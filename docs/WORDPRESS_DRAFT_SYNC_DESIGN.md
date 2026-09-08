# WordPress draft synchronisation + featured media design (Round 2B.4A)

## 1. Problem statement

The backend needs a **controlled** way to replace the complete state of an
existing WordPress draft — title, body, excerpt, category set, and featured
image — so that edits flow from the newsroom queue to the drafted post without
touching status, author, or revision history, and without ever silently
last-write-winning over a newer known state.

The existing production surface is create/lookup only:

- `POST /wp-json/newsroom/v1/drafts`
- `GET /wp-json/newsroom/v1/drafts/{draft_key}`

There is no update path and no authoritative read after creation. A generic
WordPress credential may not be substituted (Round 2B.2A established that an
Application Password is a generic credential and the trust boundary must be a
credential WordPress restricts to approved newsroom routes).

Round 2B.4A therefore records the approved architecture for a **full-state
draft sync** plus **featured media by media key**, and proves it on a
disposable stack whose production sources are frozen and byte-verified.
Round 2B.4B will implement the design in local production-quality backend
source under supervisor review. Neither round is deployment or production
validation.

## 2. Mandatory invariants

1. Sync never changes `post_status` (always `draft`), `post_author`, or the
   revision history; it fails closed if WordPress disagrees.
2. Sync is **full-state**: the submitted `{title, content, excerpt, categories,
   featured_media_key}` is the complete desired state, and the postcondition
   check verifies the stored post equals it exactly.
3. `featured_media_key` is a required field; `null` clears the featured media
   pointer and **only** the pointer. Attachments, files, and media-boundary
   rows are never deleted by a sync.
4. Featured assignment resolves **only** media-key-managed attachments owned by
   the media authority; bare attachment IDs are rejected and arbitrary input is
   impossible.
5. CAS: `expected_version` is nullable and, when non-null, is the lowercase
   SHA-256 `state_fingerprint` learned from the previous state GET or sync
   response. When present and stale the sync is rejected with
   `409 newsroom_draft_sync_stale_version`. Identical replay is idempotent.
   Conflicting concurrent CAS writers produce exactly one winner per version.
6. Uncertain outcomes fail closed: if the sync could have committed but the
   outcome cannot be proven, the caller must reconcile before any retry.
7. Draft credentials authorize only the approved newsroom drafts surface; the
   media authority authorizes only the media surface; neither reaches core
   REST, XML-RPC, login, or Application Password flows.
8. Missing configuration, capability drift, corrupt mappings, missing posts,
   foreign ownership, and authentication conflicts fail closed with a specific
   error code.
9. No production source is modified by the proof; the frozen reconciliation
   trio stays byte-identical (Appendix E).

## 3. Gap audit against the existing surfaces

| Concern | Existing draft surface | Media boundary (Round 2B.3) | Delta required here |
|---|---|---|---|
| Create by `wordpressDraftKey` | `POST /newsroom/v1/drafts`, deterministic, idempotent | — | none |
| Lookup by `wordpressDraftKey` | `GET /newsroom/v1/drafts/{key}` | — | none |
| Update existing draft state | none | — | **full-state PUT** |
| Canonical read-back | none | — | **state GET** |
| Featured media assignment | none (`_thumbnail_id` untouched) | uploads + reservation, media-key managed | **resolve by `featured_media_key`** |
| Concurrency control | create conflict via payload hash | reservation tokens | **CAS `expected_version`** |
| Uncertain update outcome | create idempotency | reconcile-before-retry | **same discipline** |
| Auth allow-list | create, lookup | media upload/GET | **sync PUT + state GET** |

## 4. Authority model

Two authorities, unchanged from the production design:

- **Newsroom draft authority** (`NEWSROOM_BRIDGE_USER_ID`, service user with
  `read` + `edit_posts` + `assign_categories`) owns create, lookup, **sync**, and
  **state read**.
- **Newsroom media authority** (`NEWSROOM_BRIDGE_MEDIA_USER_ID`, service user
  with `read` + `upload_files`) owns media upload, reservation, and
  reconciliation. A media credential is rejected on every draft route and vice
  versa.

The sync surface runs as the draft authority: post author is preserved (the
draft was created by the same service user in the disciplined flow), normal
core `WP_REST_Posts_Controller` permission checks still apply, and the mapping
must be actor-owned. The media authority can never assign featured media; the
draft authority can never upload, reserve, or mutate media rows.

## 5. API surface and DTOs

### 5.1 `PUT /wp-json/newsroom/v1/drafts/{draft_key}` (NEW)

Full-state replace.

```json
{
  "draft_key": "01234567-89ab-47cd-8e01-23456789abcd",
  "title": "Headline from the newsroom queue",
  "content": "Full body as drafted.",
  "excerpt": "Optional one-liner.",
  "categories": [3, 5],
  "featured_media_key": "01234567-89ab-47cd-8e01-23456789abcd",
  "expected_version": null
}
```

- `draft_key`, `title`, `content`, `categories`, `featured_media_key` required.
- `excerpt` optional (defaults to `""`). `expected_version` is nullable and
  defaults to `null`; a non-null value must be exactly 64 lowercase hex
  characters and must come from a previous state GET or sync response.
- Unknown fields rejected with `400 newsroom_invalid_payload`.
- `title`/`content` must be non-empty strings. `categories` must be a non-empty
  array of existing, assignable category IDs (deduplicated and sorted
  numerically before any comparison).
- `featured_media_key` must be a canonical lowercase UUID v4 or `null`.

Success `200`:

```json
{
  "draft_key": "…",
  "post_id": 42,
  "status": "draft",
  "replayed": false,
  "featured_media_key": "…",
  "applied_version": "64-hex sha256 of the canonical applied state"
}
```

`replayed: true` means the stored state already equalled the target; no write
occurred. `replayed: false` means the state was applied (or, when no write was
needed beyond a pointer change, the verified path).

### 5.2 `GET /wp-json/newsroom/v1/drafts/{draft_key}/state` (NEW)

Canonical read used by the reconciliation client.

```json
{
  "draft_key": "…",
  "post_id": 42,
  "status": "draft",
  "title": "…",
  "content": "…",
  "excerpt": "…",
  "categories": [3, 5],
  "featured_media_key": "…",
  "applied_version": "64-hex sha256 of the canonical applied state"
}
```

`applied_version` is the lowercase SHA-256 `state_fingerprint` of the canonical
WordPress draft state successfully committed (or already present on replay).
The same value is returned by sync and state GET, so it can be re-verified
against live state and supplied as a later `expected_version`.

## 6. Featured media semantics

`featured_media_key` is the media-key-managed identity of an uploaded image. On
a sync:

1. `null` → clear: `delete_post_meta($post_id, '_thumbnail_id')`. Nothing else.
2. A media key → resolve to a **committed, owned, healthy image** (steps in
   §6.1) and `update_post_meta($post_id, '_thumbnail_id', $attachment_id)`.

Resolution is identity-scoped and never guesses: every gate must pass, and each
failure maps to a specific code.

### 6.1 Resolution gates (all required)

| Gate | Failure code | HTTP |
|---|---|---|
| Mapping exists in `wp_newsroom_media` | `newsroom_draft_sync_media_key_not_found` | 400 |
| `reservation_token` is NULL (committed) | `newsroom_draft_sync_media_key_in_progress` | 409 |
| Row owned by the media authority | `newsroom_draft_sync_media_not_owned` | 400 |
| Committed attachment id present | `newsroom_draft_sync_media_attachment_missing` | 409 |
| Attachment exists and is an `attachment` | `newsroom_draft_sync_media_attachment_missing` | 409 |
| Attachment author == media authority | `newsroom_draft_sync_media_not_owned` | 400 |
| MIME in {png, jpeg, webp, gif} | `newsroom_draft_sync_media_not_image` | 400 |
| `_newsroom_media_key` meta == key AND `_newsroom_media_file` exists on disk | `newsroom_draft_sync_media_corrupt` | 409 |

Attachment IDs arrive only through this resolution; they are never accepted as
input.

### 6.2 Featured, state, and reconciliation fingerprints

Two distinct lowercase SHA-256 fingerprints exist. Both hash the UTF-8 bytes
of `wp_json_encode($canonical, JSON_UNESCAPED_SLASHES |
JSON_UNESCAPED_UNICODE)` output with the property order shown below; category
values are integers, deduplicated, and numerically sorted before encoding:

- **`state_fingerprint`** (the `applied_version`): canonical
  `{contract_version: 1, title, content, excerpt, categories, featured_media_key}`.
  Categories are deduplicated and sorted numerically first. This is what the
  sync response and the state GET both return, and what `expected_version`
  compares against.
- **`reconciliation_fingerprint`** (the `payload_hash` refresh):
  `{contract_version: 1, title, content, excerpt, categories}` — deliberately
  **without** the featured key, because the frozen create/idempotency contract
  hashes the create payload fields only. Keeping the reconciliation fingerprint
  semantics unchanged means the frozen reconciliation row hash remains truthful
  for both create and sync paths.

The sync refreshes `payload_hash` in the same transaction via a direct
`wp_newsroom_reconciliation` update.

Neither fingerprint is `Story.version`. `Story.version` is an existing backend
integer optimistic-concurrency counter. It is never serialized into WordPress
`expected_version`, and it is never compared with `applied_version`.

## 7. State application

The sync applies state through the core `WP_REST_Posts_Controller` update flow
(`update_item`) with only `title`, `content`, `excerpt`, `categories`, so core
sanitisation, permission, and hook behaviour stay intact. `_thumbnail_id` is set
or cleared directly afterwards in the same transaction. Status is verified to
remain `draft` immediately after the update.

The author id in `target_state` is the **current** service user, so the
postcondition check uses the same actor that WordPress actually reports.

## 8. Idempotency, replay, and exactness

- Identical state (all fields, categories as a **sorted set**, featured key)
  ⇒ `200 replayed: true`, no write, no new transaction effect.
- Category assignment is exact-set: categories are replaced wholesale (the core
  update flow discards terms not in the submitted set), then read back and
  compared as a sorted set. This is what makes "exactly these categories, no
  leftovers" observable.
- `expected_version` echoes of the current version are accepted replays.
- The reconciliation row's `payload_hash` changes only when state actually
  changes.

## 9. Concurrency and CAS

The CAS comparison runs **inside the sync transaction**, after acquiring a
writer lock on the mapping row:

```sql
SELECT post_id FROM wp_newsroom_reconciliation WHERE draft_key = %s FOR UPDATE
```

- The lock serialises every concurrent synchroniser of one draft key.
- The post cache is invalidated after the lock, so the fingerprint is computed
  from the **latest committed** state, never a stale cached post.
- `expected_version` is compared with `hash_equals` against
  `state_fingerprint(current)`. A mismatch aborts with
  `409 newsroom_draft_sync_stale_version` and rolls back.
- Conflicting CAS writers therefore produce **exactly one winner per version**
  (the first to acquire the lock and pass the check); the rest are 409 stale.
- Identical concurrent syncs all return 200 through replay; at most one real
  write occurs and no posts are duplicated.

Replays also traverse the locked transaction path, so a replay can never race a
write into a stale fingerprint.

## 10. Uncertain outcome and partial failure

The sync is one transaction. On any unexpected throwable:

1. `rollback()`, then `clean_post_cache()`, then return a specific code:
   - `postcondition_mismatch` → `503 newsroom_draft_sync_postcondition_failed`
   - `commit_uncertain` (commit returned false after the work was flushed) →
     `503 newsroom_reconciliation_outcome_uncertain`, which **forbids blind
     retry**: the caller must reconcile this draft key first.
   - anything else → `503 newsroom_draft_sync_failed`.
2. A commit that fails after partial flush is treated as **uncertain**, not as
   failure certainty. The identical retry discipline from the create flow
   applies: same key, same state, same media key, same `expected_version`, fresh
   HMAC timestamp/signature, reconcile-before-retry.

### 10.1 Fault injection (TEST-ONLY)

- `during_update`: throws on the `newsroom_draft_sync_proof_before_commit`
  action inside the transaction. Proof asserts 503 + zero partial state +
  clean recovery. Production never fires this action.
- `mismatched_store`: a mu-plugin filter appends to `post_title` at write time,
  so the stored post disagrees with the target. Proof asserts
  `503 newsroom_draft_sync_postcondition_failed` + rollback + recovery.

## 11. Security boundary

The prototype authentication is a test-only extension of the committed
`Newsroom_Bridge_Auth` contract (canonical string, key-id rules, ±300 s window,
temporary service-user context, nested-dispatch denial, conflict detection)
with one documented delta: the route allow-list gains

- `PUT /newsroom/v1/drafts/{draft_key}` → `draft_sync`
- `GET /newsroom/v1/drafts/{draft_key}/state` → `draft_state`

Retained hardening observed by the proof:

- Unsigned, stale, unknown-key, tampered-signature, tampered-timestamp,
  invalid-body, query-string, and Authorization-conflict requests → 401
  `newsroom_hmac_authentication_failed`.
- Draft credentials are rejected on core routes and media routes; media
  credentials are rejected on draft routes.
- Identity lockdown: no Application Passwords, no service-user password login,
  no auth cookies.
- Security events go to `newsroom_bridge_security` log records; the generated
  secrets never appear in logs, the database, or the repository audit set.

For 2B.4B, production must extend
`wordpress/newsroom-bridge/includes/class-newsroom-bridge-auth.php`, reusing the
existing draft HMAC key ring and configured draft service user. Its
`route_category()` positive allow-list must add exactly the sync PUT and state
GET above; `wrap_endpoints()` must wrap exactly their registered callbacks in
the same proof-bound, exception-safe user-context guard. The request validation
must apply the existing JSON content-type/body rules to PUT while retaining the
zero-body GET rule. No new credential, service user, capability, media
authority, publication authority, or generic `wp/v2` authority is required.

## 12. Backend implementation plan (Round 2B.4B)

The backend `apps/api` draft module (frozen `wordpress-draft.client.ts`)
currently performs create/replay by a deterministic `wordpressDraftKey`. 2B.4B
adds:

1. **`syncDraft`** in the adapter: PUT full-state + read-back reconciliation
   loop reusing the proven create discipline (bounded attempts, identical
   key/state/mediaKey/CAS per attempt, fresh HMAC per attempt).
2. **`Story.version` CAS**: this existing integer counter guards backend Story
   database mutations/workflow. It is a separate concurrency domain from the
   WordPress draft-state fingerprint. The orchestrator may record both, but it
   must never serialize `Story.version` into WordPress `expected_version` or
   treat it as equivalent to `applied_version`.
3. **DTO mapping**: `Story` → sync payload (`title`, `content`, `excerpt`,
   category id set, `featured_media_key`), with the WordPress state GET as the
   authoritative reconciliation read rather than a blind result code.
4. **Media-key binding**: the featured media key is a draft-side pointer to the
   media-boundary object; upload/reservation/reconciliation stay entirely in
   the media module. The backend stores the media key, never an attachment id.
5. **Error surfacing**: stale → caller-abort-and-reread; uncertain →
   reconcile-and-retry; postcondition-failed → alert, never blind retry.

## 13. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| PUT accepts only changed fields (PATCH-like) | Not full-state; makes idempotency, postcondition checks, and exact category sync messy and partial updates observable by readers |
| Use core `wp/v2/posts` directly with a generic credential | Violates the Round 2B.2A trust boundary |
| Featured media as bare `featured_media` attachment id | Any attachment id would be assignable; breaks authority isolation and allows arbitrary pointing |
| Clearing featured media via `featured_media_key: ""` | Ambiguous non-null sentinel; `null` is the explicit clear contract |
| CAS only at the backend on `Story.version` | The terminal WordPress surface would still silently last-write-win under concurrent backend instances |
| Lock the whole `wp_posts` row for every sync | Overlocks unrelated writers; the reconciliation mapping row is the correct serialisation point for a draft key |
| Commit-then-verify without transaction | Leaves durable partial state on failure |

## 14. Production unknowns / open items

- Media-policy changes on delete: currently sync never deletes; future
  publication workflows may need explicit unpublish semantics, out of scope.
- WordPress-side expectations limit: KAT/audit for very large bodies is
  unchanged; the design does not alter the create path.
- **No WordPress reconciliation schema v3 is required.** The sync handler can
  compute `state_fingerprint` from the current canonical post fields and the
  existing reconciliation/media records. Schema v2 already stores the draft
  mapping and create-payload reconciliation fingerprint; no new durable field
  is needed. `Story.version` already exists in the backend schema.
- The `newsroom_draft_sync_proof_before_commit` action must never appear in
  production code; the proof gate (`NEWSROOM_DRAFT_SYNC_PROOF`) is the only
  thing preventing it from being reachable.

## 15. Disposable evidence

The proof suite (`wordpress/runtime/draft-sync-proof/run-draft-sync-proof-tests.mjs`)
covers a digest-pinned disposable stack. The production plugin is mounted
read-only but inactive because its positive draft allow-list rejects the new
sync/state routes and registering both auth stacks would create conflicting
authentication filters and endpoint wrappers. The test-only loader therefore
owns activation and authentication; it directly loads committed production
classes from the read-only mount:

- `draft_client_create_201`, `draft_client_get_200`,
  `draft_client_replay_200`, and `draft_bridge_conflict_409` are handled by the
  committed `Newsroom_Bridge_REST` and `Newsroom_Bridge_Reconciliation`
  classes, instantiated by the test-only loader.
- `media_upload_201` is handled by the committed
  `Newsroom_Bridge_Media_REST` and `Newsroom_Bridge_Media_Reconciliation`
  classes, instantiated by the test-only loader. Media GET is registered by
  that same committed handler, but this suite has no separately named media
  GET evidence group.
- Sync PUT and state GET are handled only by the test-only
  `Newsroom_Bridge_Draft_Sync_REST`; test-only PHP also supplies the extended
  draft authentication and fault injection.

The suite covers:

- activation + schema (`wp_newsroom_media`, `wp_newsroom_reconciliation`) +
  routes + capability model;
- frozen client create/get/replay/conflict and media HMAC upload;
- offline + live KAT vector (see Appendix A);
- state GET, replay, full-state application, exact category replacement,
  multi-category assignment;
- featured set / swap / clear with attachment and media-row preservation;
- CAS stale 409, 10x identical concurrency, 10x conflicting CAS (1 winner,
  9 stale);
- validation 400s with state preservation;
- unknown / reserved / foreign / non-image / corrupt media keys;
- response-loss recovery and undelivered-first retry;
- both fault phases (503, rollback, recovery);
- identity lockdown, auth negatives, core-REST isolation, cross-route
  rejection, Authorization-conflict;
- log/DB/repository secret sentinel audits;
- frozen + production hash integrity before and after; zero cleanup residue.

Full per-group results: `wordpress/runtime/draft-sync-proof/runtime-results.json`
(git-ignored, from the executed run; summary in Appendix F).

## 16. GO / NO-GO

This document is the approval candidate. The executed final round report owns
the approval verdict after evidence, repository gates, frozen hashes, and
cleanup have been independently verified.

## Appendix A — Canonical KAT vector

- key id `draft-local-v1`; secret (base64url, decoded to 32 bytes)
  `QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI`
- route `/newsroom/v1/drafts/01234567-89ab-47cd-8e01-23456789abcd`
- timestamp `1750000000`; method `PUT`
- body `{"draft_key":"01234567-89ab-47cd-8e01-23456789abcd","title":"Sync KAT Title","content":"KAT body","excerpt":"","categories":[1],"featured_media_key":null}`
- body sha256 `640dfc46a02b12fab568f9bb5bf07728111079991c4c12c2dab579d31d7f1bab`
- canonical string

```
newsroom-hmac-v1
draft-local-v1
PUT
/newsroom/v1/drafts/01234567-89ab-47cd-8e01-23456789abcd
1750000000
640dfc46a02b12fab568f9bb5bf07728111079991c4c12c2dab579d31d7f1bab
```

- expected signature `ed1ec9db1f911e63b6f22a9ab310fae9c47756ce08211e0e00561553ea6df965`

## Appendix B — Error catalogue

| Code | HTTP | Meaning |
|---|---|---|
| `newsroom_invalid_draft_key` | 400 | draft key is not a canonical lowercase UUID v4 |
| `newsroom_invalid_payload` | 400 | schema/field validation failed |
| `newsroom_category_not_found` | 400 | a category id does not exist |
| `newsroom_draft_sync_not_found` | 404 | no mapping for the draft key |
| `newsroom_draft_sync_media_key_not_found` | 400 | media key is not managed |
| `newsroom_draft_sync_media_key_in_progress` | 409 | media row still reserved |
| `newsroom_draft_sync_media_not_owned` | 400 | row/attachment not owned by media authority |
| `newsroom_draft_sync_media_attachment_missing` | 409 | no committed attachment |
| `newsroom_draft_sync_media_not_image` | 400 | MIME not in accepted set |
| `newsroom_draft_sync_media_corrupt` | 409 | key meta / file binding broken |
| `newsroom_draft_sync_stale_version` | 409 | `expected_version` stale; reconcile first |
| `newsroom_reconciliation_corrupt` | 409 | incomplete / wrong-type mapping |
| `newsroom_reconciliation_target_missing` | 409 | mapped post gone; key not reusable |
| `newsroom_bridge_forbidden` | 403 | actor / capability / ownership mismatch |
| `newsroom_bridge_not_configured` | 503 | service user not configured |
| `newsroom_draft_sync_postcondition_failed` | 503 | stored state ≠ target after apply |
| `newsroom_reconciliation_outcome_uncertain` | 503 | commit uncertain; reconcile before retry |
| `newsroom_draft_sync_failed` | 503 | unexpected failure in sync |
| `newsroom_hmac_authentication_failed` | 401 | any HMAC authentication failure |

## Appendix C — Fingerprint semantics recap

- `state_fingerprint` = lowercase SHA-256 of the UTF-8 `wp_json_encode` bytes
  for (`{contract_version:1, title, content,
  excerpt, categories(sorted numeric), featured_media_key}`)) — the
  `applied_version`; compared by nullable `expected_version`.
- `reconciliation_fingerprint` = lowercase SHA-256 of the UTF-8
  `wp_json_encode` bytes for (`{contract_version:1, title,
  content, excerpt, categories(sorted numeric)}`)) — refreshes the frozen
  `payload_hash`; **no featured key**.
- Categories are a set: deduplicated and sorted numerically before every
  comparison/hash, in both PHP and the harness.

## Appendix D — Mapping of proof evidence groups to invariants

Evidence groups and their invariant links are recorded in the runner and
reported in full in the Round 2B.4A report (Appendix F summary).

## Appendix E — Frozen production trio

| File | sha256 |
|---|---|
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-db.php` | `1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa` |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-reconciliation.php` | `6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a` |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-rest.php` | `965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a` |

## Appendix F — Runtime evidence summary

(Completed by the executed proof run; see
`wordpress/runtime/draft-sync-proof/runtime-results.json`.)

## References

- `docs/WORDPRESS_CONTRACT.md`, `docs/WORDPRESS_RECONCILIATION.md`,
  `docs/WORDPRESS_MEDIA_AUTHORITY_DESIGN.md`,
  `docs/WORDPRESS_TRUST_BOUNDARY_DESIGN.md`,
  `docs/WORDPRESS_BACKEND_DRAFT_ADAPTER.md`,
  `docs/WORDPRESS_MEDIA_IMPLEMENTATION.md`
- `wordpress/newsroom-bridge/` (frozen production sources)
- `wordpress/runtime/draft-sync-proof/` (this proof)
