# WordPress draft sync + featured media production implementation validation (Round 2B.4B)

## Status and decision

**Round 2B.4B result: PASS.** The supervisor-approved Round 2B.4A design is
implemented in production-quality source and validated in the disposable
`draft-sync-implementation` runtime. The current-production authentication
regression runs against the **new current runtime** and passes 57 evidence
groups.

- Round 2B.4B: **CURRENT** — pending supervisor review of this round's report.
- Round 2B (WordPress adapter and controlled integration): **PENDING**.
- Production deployment: **NO-GO** — no commit, push, merge, or deploy was
  performed and none is implied by this round.

This is disposable-loopback runtime evidence, not production validation.
Newsroom Bridge remains **NOT DEPLOYED**, **NOT INSTALLED**, and **NOT
ACTIVATED** on Simbidzebasa. No production request or production credential was
used. The repository-root `.env` is never read by the harness or the runtime.

## Evidence provenance

- Tested worktree: uncommitted Round 2B.4B deltas on top of
  `157e6d407b4b5b3efa023a21f0933097d5255f34`
  (`test(wordpress): add draft sync and featured media proof (Round 2B.4A)`).
  The historical trust-boundary runtimes (`wordpress/runtime/trust-boundary/`,
  `wordpress/runtime/trust-boundary-implementation/`) remain byte-identical to
  `157e6d4`.
- Evidence provenance recorded by the runner: production-target source in the
  current Round 2B.4B worktree, based on committed parent
  `157e6d407b4b5b3efa023a21f0933097d5255f34`.
- Runtime URL: `http://127.0.0.1:<NEWSROOM_TEST_PORT>` (loopback only).
- Digest-pinned images: WordPress `7.1-php8.2-apache`, MariaDB `10.11`,
  WP-CLI `2.12.0`.
- MariaDB is not published to the Windows host.
- The `.env.runtime` credential file is generated `0600`, never printed,
  removed during reconciliation and again during teardown.

## Scope and relation to the proof round

- **Round 2B.4A** (`docs/WORDPRESS_DRAFT_SYNC_DESIGN.md`) remains the
  authoritative architecture: full-state `PUT`, canonical `GET .../state`,
  fingerprint-version CAS, replay idempotency, uncertain-outcome fail-closed
  semantics, featured media resolved only by media key, and no status/author/
  publication mutation.
- **Round 2B.4B** is the production implementation of that design: the sync and
  state routes now live in production-target WordPress source in the current
  Round 2B.4B worktree, loaded by the production plugin, and the backend adapter
  (`apps/api`) is updated to drive them. The 2B.4A **proof runtime**
  (`wordpress/runtime/draft-sync-proof/`)
  is superseded by the 2B.4B **implementation runtime**
  (`wordpress/runtime/draft-sync-implementation/`), which exercises the real
  production plugin with its real route allow-list and real authentication.

Unlike Round 2B.4A, where the sync/state handlers and the draft
authentication extension were test-only in a shadow loader, in Round 2B.4B the
production-target plugin source in the current Round 2B.4B worktree owns
activation, schema, and authentication. The disposable runtime activates the
actual `newsroom-bridge` plugin and mounts it read-only.

## Production source changes (all in this worktree, none shipped)

### WordPress plugin (`wordpress/newsroom-bridge/`)

- `newsroom-bridge.php`
  - Version `1.3.0` (`NEWSROOM_BRIDGE_VERSION`).
  - Loads `includes/class-newsroom-bridge-draft-sync-rest.php`.
  - Instantiates and registers `Newsroom_Bridge_Draft_Sync_REST` (deps:
    draft database, media database, draft reconciliation) alongside the
    existing draft and media REST handlers.
- `includes/class-newsroom-bridge-draft-sync-rest.php` (new)
  - `PUT /newsroom/v1/drafts/{draft_key}` → full-state replace.
  - `GET /newsroom/v1/drafts/{draft_key}/state` → canonical read.
  - Fingerprint CAS under the reconciliation writer lock; replay and
    stale-version semantics per §9 of the design; uncertain-outcome and
    postcondition fail-closed error mapping.
  - Featured media resolution by media key only (gates from §6.1 of the
    design), including the media authority ownership and corrupt-mapping/file
    checks. The draft authority can never assign a bare attachment id.
  - No schema change: `NEWSROOM_BRIDGE_SCHEMA_VERSION` stays `2`,
    `NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION` stays `1`.
- `includes/class-newsroom-bridge-auth.php`
  - `route_category()` positive allow-list gains exactly
    `PUT .../drafts/{draft_key}` → `draft_sync` and
    `GET .../drafts/{draft_key}/state` → `draft_state` (canonical UUID v4
    only).
  - `wrap_endpoints()` wraps exactly the four approved draft handlers
    (`create_draft`, `get_draft`, `sync_draft`, `get_state`) and verifies each
    belongs to the correct production-target handler class; it never wraps a
    namespace.
  - Request validation: `PUT` now requires the same JSON content-type/body
    rules as `POST`; `GET .../state` retains the strict zero-body rule.
  - The existing `expected_url` integrity check now accepts the draft-key and
    optional `/state` suffix from the proof.

### Backend adapter (`apps/api/src/modules/wordpress-draft/`)

- `wordpress-draft-state.ts` (new)
  - Canonical sync payload builder, state-response validator, and
    `draftStateFingerprint`/`reconciliationFingerprint` mirroring the PHP
    canonicalization (contract version 1, categories deduplicated and
    numerically sorted; byte parity with `wp_json_encode` verified in-runtime).
- `wordpress-draft.client.ts`
  - `syncDraft()`: signed PUT full-state with bounded reconcile-on-uncertain
    discipline; identical key/state/mediaKey/CAS per attempt, fresh HMAC
    timestamp/signature per attempt.
  - `getDraftState()`: signed GET `.../state` as the authoritative
    reconciliation read.
  - Transport now supports `PUT`.
- `wordpress-hmac.ts`
  - `assertApprovedRoute()` accepts `PUT` on the draft route and
    `GET .../{draft_key}/state`.
- `wordpress-draft.errors.ts`
  - New `STALE_VERSION` error code surfaced from
    `409 newsroom_draft_sync_stale_version`.

### Auth regression placement (authoritative)

The current-production authentication regression lives in
`wordpress/runtime/draft-sync-implementation/` — the new current runtime that
activates the production plugin. It exercises:

- `NEWSROOM_BRIDGE_HMAC_ENABLED`, `NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED`,
  `NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON`, `NEWSROOM_BRIDGE_USER_ID` exactly as
  production consumes them. The old `NEWSROOM_HMAC_DRAFT_KEYS` shim contract is
  not reintroduced.
- Production `Newsroom_Bridge_Auth` owns authentication, request proof,
  service-user entry, callback wrapping, and identity restoration; there is no
  manual shim user-set in the regression.

**Historical note:** the Round 2B.2A shim failure during the earlier
investigation was a **harness-generation mismatch**, not a current-production
authentication failure. The historical trust-boundary suites were never
repaired because they are frozen evidence; the `draft-sync-implementation`
suite is the current auth regression and it is green.

## Evidence groups (57, all PASS)

| Group | Meaning |
|---|---|
| `php_lint_runtime` | Runtime PHP lint of fixtures and committed bridge files |
| `activation_and_schema` | Production plugin active 1.3.0, schema 2/1, both routes, exact tables, service-policy caps |
| `draft_client_create_201` / `draft_client_get_200` / `draft_client_replay_200` | Frozen committed client create/get/replay still green |
| `draft_bridge_conflict_409` | Changed-payload create still conflicts and preserves the post |
| `media_upload_201` / `media_get_200` | Media HMAC upload and actual production media GET remain green |
| `kat_vector_offline` / `kat_live_put_200` | Offline and live KAT for the sync PUT canonical string/signature |
| `state_get_200` / `sync_replay_200` | Canonical state read and format-preserving replay |
| `compiled_builder_php_parity` | Node fingerprint/body builders byte-match PHP |
| `full_state_put_200` / `exact_category_replacement` / `multi_category_assign` / `category_dedupe_sorted_exact` | Full-state replace and exact category-set semantics |
| `media_featured_fixture` / `featured_set_by_media_key` / `featured_swap_a_to_b` / `featured_only_payload_hash_invariant` / `featured_clear_null` | Featured media by key: set, swap, clear, reconciliation-hash invariant |
| `cas_stale_version_409` / `cas_stale_noop_replay_200` | Stale expected version rejects; identical (even stale) replay returns 200 replay with zero mutation |
| `concurrency_identical_10` / `concurrency_conflicting_cas_10` | 10x identical replays; 10x conflicting CAS has exactly one winner |
| `validation_400s` / `unknown_category_rejected_400` | Schema/field/type validation plus explicit nonexistent positive category rejection without durable state change |
| `featured_unknown_key_400` / `featured_reserved_key_409` / `featured_not_owned_400` / `featured_non_image_400` / `featured_corrupt_mapping_409` / `featured_corrupt_file_409` | Media resolution gates fail closed with specific codes |
| `status_author_no_publication` | Status stays `draft`, author preserved, no publication path |
| `response_loss_recovery` / `undelivered_retry` | Lost-response reconciliation and undelivered-first retry discipline |
| `fault_partial_operation_rollback` / `fault_postcondition_mismatch` / `fault_commit_uncertain` | Core-hook fault injection: rollback, postcondition 503, commit-uncertain 503 |
| `draft_identity_lockdown` / `core_rest_isolation` / `method_isolation` / `cross_route_rejection` | Identity lockdown, core REST isolation, method/route exactness |
| `authentication_negatives` / `authorization_conflict_401` / `auth_route_and_method_exact_401` | Signed/auth negative matrix and Authorization-conflict rejection |
| `auth_cookie_conflict_401` / `auth_nonce_conflict_401` | `wordpress_logged_in` cookie and `X-WP-Nonce` rejected on draft routes |
| `auth_core_media_inaccessible` / `auth_batch_nested_denied` | Signer cannot reach core `/wp/v2/media` or nested `/batch/v1` |
| `auth_ordinary_author_unaffected` | Ordinary author Application Password unaffected on core; denied on newsroom routes |
| `auth_generic_login_lockdown` | Service login and XML-RPC denied |
| `auth_service_user_transition` | `save_post` runs as the service user; identity restored to `0` after success and commit-uncertain |
| `auth_config_fail_closed` | Malformed/absent key ring, lockdown off, HMAC off, missing service user all fail closed; good config restores 201/200 |
| `no_secret_sentinels` | Generated secrets absent from logs, DB, and repository scan set; root `.env` excluded |
| `final_integrity` | Frozen hashes unchanged; production sources unchanged; final health create/sync/client all green |

Full per-group results and details:
`wordpress/runtime/draft-sync-implementation/runtime-results.json`
(git-ignored; from the executed run).

## Repository validation gates

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (8 suites / 202 tests),
  `pnpm build` — all passed.
- Harness build via
  `tsc -p apps/api/tsconfig.wordpress-draft-sync-implementation-harness.json` —
  passed.
- PHP lint (inside digest-pinned PHP 8.2 container) — passed.
- PHP 7.4 lint of the plugin tree — passed (verified in `php:7.4-cli`).
- `docker compose config -q` — passed.
- `git diff --check` — passed (LF→CRLF warnings only).
- Historical runtimes clean: `git status` shows no modifications and no
  untracked files under `wordpress/runtime/trust-boundary/` or
  `wordpress/runtime/trust-boundary-implementation/`.

## Cleanup

`docker compose down -v --remove-orphans` removed the disposable containers and
volumes; teardown asserts zero remaining project containers, zero remaining
project volumes, and absence of `.env.runtime`.

## Remaining limitations (unchanged from design §14)

- Sync never deletes; explicit unpublish/delete media-policy semantics are out
  of scope for this round.
- Production active-hook inventory, production cache behaviour, and
  Simbidzebasa-specific runtime validation remain open.
- The `newsroom_draft_sync_proof_before_commit` action must never appear in
  production code; the proof gate (`NEWSROOM_DRAFT_SYNC_PROOF`) is the only
  thing preventing it from being reachable, and no such route is registered by
  production.
