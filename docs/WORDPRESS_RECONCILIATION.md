# WordPress draft reconciliation contract

## Status and scope

Round 2B.0 implements the local source for a small WordPress Newsroom Bridge and has received supervisor source approval. This approval covers local source/design and static/local validation only; it is not runtime proof. Its status remains **NOT DEPLOYED**, **NOT INSTALLED**, **NOT ACTIVATED**, **NOT WORDPRESS-INTEGRATION-TESTED**, and **NOT PRODUCTION-VALIDATED**. No production WordPress action occurred in this round.

The bridge solves one failure mode: WordPress creates a draft, but the response is lost before the backend persists its post ID. A blind retry must not create a duplicate.

Media upload, draft updates, publication, approval, category management, and backend adapter implementation are outside Round 2B.0.

## Why editorial fields are not idempotency storage

Title, content, excerpt, slug, categories, tags, permalink, and theme/plugin metadata are mutable editorial or presentation data. They cannot uniquely and durably identify an initial creation attempt. The bridge never embeds `draft_key` in those fields and does not expose arbitrary meta as a substitute.

## Private storage contract

Activation uses WordPress `dbDelta()` conventions to create `${wpdb->prefix}newsroom_reconciliation` with the site charset/collation and InnoDB:

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `draft_key` | `char(36)` | No | Canonical lowercase UUID v4 and primary identity |
| `post_id` | `bigint unsigned` | Yes | Resulting WordPress post ID |
| `payload_hash` | `char(64)` | No | SHA-256 initial-payload fingerprint |
| `actor_user_id` | `bigint unsigned` | No | Authenticated integration user |
| `reservation_token` | `char(36)` | Yes | Short-lived canonical UUID v4 identifying one create attempt |
| `created_at` | `datetime` | No | UTC reservation time |
| `updated_at` | `datetime` | No | UTC update time |

Invariants:

- `PRIMARY KEY (draft_key)` is the reservation and concurrency boundary.
- `UNIQUE KEY (post_id)` prevents two keys mapping to one non-null post.
- A healthy committed row has a non-null positive `post_id` and a null `reservation_token`.
- `post_id` may be null and `reservation_token` non-null only inside the owning uncommitted first-create transaction.
- Any committed row with a null `post_id` or non-null `reservation_token` is incomplete/corrupt, requires operator review, and is never repaired, stolen, cleared, or reused automatically.
- No foreign key points to `wp_posts`; the mapping survives manual post deletion.
- Deactivation/uninstall does not delete reconciliation history.
- A schema-version option supports deliberate future upgrades.

Activation does not trust `dbDelta()` or the schema-version option as proof of success. It verifies the resulting table through `information_schema`: InnoDB engine; exact required columns, nullability, and character lengths; primary key exactly on `draft_key`; and a single-column unique index on `post_id`. Only then is the schema version recorded. Runtime readiness repeats the same structural verification and separately verifies the core table engines. A malformed existing table is not dropped or destructively rebuilt; activation/readiness fail closed with a generic error.

## Transaction boundary

Before starting, the bridge queries `information_schema` and fails closed unless its table plus `posts`, `postmeta`, `terms`, `term_taxonomy`, and `term_relationships` all exist and use InnoDB.

The first-create transaction contains:

1. Generate a fresh internal canonical UUID v4 reservation token and atomically insert it with the new row, using a duplicate-key no-op that does not modify any existing mapping field.
2. Exact mapping read with `SELECT ... FOR UPDATE`.
3. Compare the stored token with this attempt's token to determine ownership.
4. Core WordPress draft creation only when the tokens match.
5. Conditional assignment of the returned `post_id` and clearing of the token only when `draft_key`, the owned token, and `post_id IS NULL` all match.
6. Commit.

Affected-row counts are not an ownership signal and behavior does not depend on `CLIENT_FOUND_ROWS`. A SQL failure is a storage error; after any successful insert/no-op query, ownership comes only from exact stored-token equality under the row lock. The insert does not use deprecated `VALUES()` syntax and does not replace or modify `post_id`, payload hash, actor, or reservation token on a duplicate key.

Any normal creation or persistence error rolls back. A commit-call error causes a best-effort rollback and returns `newsroom_reconciliation_outcome_uncertain`; it does not prove whether commit succeeded. The backend **must GET `/newsroom/v1/drafts/{draft_key}` before any create retry**.

The bridge uses `WP_REST_Posts_Controller` with an internal `WP_REST_Request` so normal core post preparation, explicit create permission checks, sanitization, hooks, and category semantics remain in force. It does not insert article rows with custom SQL. The request forces `post`, `draft`, and the current integration user as author.

Immediately around that exact controller call, a temporary `rest_insert_post` action captures the authoritative main post ID only when the hook reports creation, receives the identical `WP_REST_Request` object, and identifies a core `post`. The hook is always removed in a `finally` block. This capture remains available when later core REST processing returns `WP_Error`; response data is not the infrastructure identity source.

Before the uncommitted create path, the bridge preserves the current `wp_suspend_cache_addition()` state and suspends new cache additions. It restores the exact previous state in `finally` without suspending cache invalidation. If a candidate post ID is known and the transaction rolls back—or commit outcome is uncertain—it calls `clean_post_cache()` after the database resolution attempt. This forces later reconciliation to read durable database truth rather than a cached uncommitted/stale `WP_Post`.

After core creation succeeds and before mapping attachment, the bridge re-reads assigned category IDs, converts them to positive integers, de-duplicates, numeric-sorts, and requires exact equality with the canonical requested IDs. A category race or hook alteration causes rollback, cache cleanup, and a stable creation error; the bridge never repairs terms automatically.

WordPress save/REST hooks execute inside the bridge transaction window. The bridge makes no outbound request, but hooks may perform external effects, write non-transactional storage, issue DDL/implicit commits, manipulate transactions, or use a persistent object cache in ways MySQL rollback cannot reverse. Cache-addition suspension and cleanup reduce stale core post-cache risk; they cannot make arbitrary plugin caches or effects transactional. Production activation requires active-hook/table review plus controlled failure injection. Normal core hooks are not disabled.

## Concurrency and idempotency

Two same-key requests contend on the primary-key insert. The request whose token is stored owns the reservation. A competing duplicate-key no-op waits for transaction resolution, then locks and reads the durable row; it cannot steal or clear the winner's token. If the first transaction rolls back, normal database concurrency may allow the waiting insert to establish its own token. There is no unlocked “select then insert” gap and affected-row counts do not decide the winner.

- Same key and same hash: return the existing mapping, without a new post.
- Same key and different hash: HTTP 409 `newsroom_idempotency_conflict`.
- Mapping with null post ID, non-null reservation token, missing post, wrong post type, wrong actor, or inaccessible post: fail closed; never reuse the key.
- A later post status change does not invalidate the mapping.

## Payload fingerprint

The SHA-256 input is deterministic JSON with this fixed key order:

1. `contract_version` (`1`)
2. `title`
3. `content`
4. `excerpt` (empty string when omitted)
5. canonical category IDs

Category IDs are validated as positive integers, de-duplicated, and numerically sorted before hashing. Generated post ID, slug, permalink, and timestamps are excluded. Full content is not copied into the reconciliation table.

The canonical JSON serialization result is checked explicitly. If serialization returns `false`, fingerprinting fails closed with a stable storage error instead of hashing an invalid value; the fingerprint fields, order, and encoding flags remain unchanged.

## REST contract

### `POST /wp-json/newsroom/v1/drafts`

Accepts exactly:

```json
{
  "draft_key": "canonical-lowercase-uuid-v4",
  "title": "non-empty string",
  "content": "non-empty string",
  "excerpt": "optional string",
  "categories": [1, 16]
}
```

Unknown fields are rejected. Categories must already exist. The bridge never creates or edits terms.

First creation returns HTTP 201 with `replayed: false`. Same-payload replay returns HTTP 200 with `replayed: true`. Responses contain only draft key, post ID, status, and replay flag.

The client cannot choose status, post type, author, featured media, tags, slug, dates, password, sticky state, template, or meta. There is no path to publication.

### `GET /wp-json/newsroom/v1/drafts/{draft_key}`

Performs an exact primary-key lookup after UUID validation. A healthy result contains only draft key, post ID, and current WordPress status. A confirmed successful database read with no row returns 404. A database read failure returns HTTP 503 `newsroom_reconciliation_storage_error`, never 404. Missing/corrupt/inaccessible targets return stable errors and are never recreated.

No list, fuzzy search, title search, slug search, public lookup, update, delete, publish, category-management, user, or debug route exists.

## Permission model and deployment configuration

Every route has an explicit permission callback requiring both:

1. Current authenticated user ID exactly equals positive numeric `NEWSROOM_BRIDGE_USER_ID`.
2. `current_user_can('edit_posts')` is true.

The constant is protected site configuration and the plugin fails closed when it is absent or invalid. User ID 2 is not hardcoded in business logic. Core category assignment additionally evaluates the category taxonomy's normal `assign_terms` capability. The plugin grants no role or capability.

The currently discovered dedicated identity is SDB News, Author. Production configuration and activation remain manual, audited deployment steps.

## Error contract

Stable errors include:

- `newsroom_bridge_not_configured`
- `newsroom_bridge_forbidden`
- `newsroom_invalid_draft_key`
- `newsroom_invalid_payload`
- `newsroom_category_not_found`
- `newsroom_storage_not_transactional`
- `newsroom_reconciliation_storage_error`
- `newsroom_reconciliation_outcome_uncertain`
- `newsroom_draft_creation_failed`
- `newsroom_idempotency_conflict`
- `newsroom_reconciliation_not_found`
- `newsroom_reconciliation_target_missing`
- `newsroom_reconciliation_corrupt`

REST errors do not include SQL, hashes, credentials, full payloads, article bodies, or environment configuration.

## Failure and recovery examples

| Case | Expected behavior |
|---|---|
| Response lost after commit | GET by `draft_key` returns the committed post ID |
| Same request retried | Existing mapping returned; no second post |
| Changed Story reuses create key | HTTP 409; future update operation must use known post ID |
| Core insert never establishes a post | Transaction rolls back; no cache cleanup is needed |
| Core establishes a post then terms/additional processing fails | Transaction rolls back and captured post cache is cleaned |
| Category postcondition differs | Transaction rolls back and captured post cache is cleaned |
| Mapping persistence fails | Transaction rolls back local rows and cleans captured post cache |
| Existing row has null post ID or non-null reservation token | `newsroom_reconciliation_corrupt`; no post creation or automatic repair |
| GET database read fails | HTTP 503 storage error; never reported as not found |
| Commit result is uncertain | `newsroom_reconciliation_outcome_uncertain`; best-effort rollback/cache cleanup; caller must GET before retry |
| Mapped post manually deleted | Invariant error; key remains unusable |
| Mapped post published/trashed | Mapping remains valid if the integration user retains access |
| Integration identity changes | Route or mapping access fails closed |
| Non-transactional core table | No draft creation; service error |

## Explicit remaining risks

- Media upload has its own uncertain-response and duplicate-upload problem. Post reconciliation does not solve media idempotency.
- Persistent object-cache plugins may not honor core cache behavior in a fully transactional way.
- Active hooks/plugins may produce external effects, non-transactional writes, DDL implicit commits, or transaction manipulation that rollback cannot reverse.
- No approved local WordPress integration environment exists, so concurrency, rollback, controller behavior, schema installation, category assignment, and responses are not runtime-proven.
- Production installation, activation, `NEWSROOM_BRIDGE_USER_ID` configuration, engine inspection, and controlled validation remain pending supervisor approval.
