# Production draft sync implementation validation

Disposable loopback runtime. Actual production plugin is active and mounted
read-only. The production draft adapter drives sync/state. Faults use external
MU-plugin/core hooks and transport proxies only. Never deploy the fixtures.

## Evidence protocol

- WordPress 7.1 / PHP 8.2, MariaDB 10.11, WP-CLI 2.12.0 (digest-pinned; see
  `compose.yaml`).
- Loopback only; the harness refuses non-loopback targets and never reads the
  repository-root `.env`.
- Secrets are injected via `compose.yaml` environment from the generated
  `.env.runtime`, never committed, removed during and after the run.
- `run-draft-sync-implementation-tests.mjs` writes
  `runtime-results.json` (git-ignored) and removes all containers/volumes on
  teardown.
- Frozen reconciliation trio hashes are asserted before and after the run.

## Production auth regression

The current-production authentication regression lives here. It exercises the
production `Newsroom_Bridge_Auth` against the **production plugin**, active and
mounted read-only, with exactly these constants:

- `NEWSROOM_BRIDGE_HMAC_ENABLED`
- `NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED`
- `NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON`
- `NEWSROOM_BRIDGE_USER_ID`

The old `NEWSROOM_HMAC_DRAFT_KEYS` shim contract is not reintroduced; there is
no manual shim user-set.

Group coverage: `authentication_negatives`, `authorization_conflict_401`,
`auth_route_and_method_exact_401`, `auth_cookie_conflict_401`,
`auth_nonce_conflict_401`, `auth_core_media_inaccessible`,
`auth_batch_nested_denied`, `auth_ordinary_author_unaffected`,
`auth_generic_login_lockdown`, `auth_service_user_transition`,
`auth_config_fail_closed`, `no_secret_sentinels`.

Historical note: the Round 2B.2A shim failure was a harness-generation
mismatch, not a current-production authentication failure. The historical
trust-boundary runtimes are frozen evidence and are never edited; this runtime
is the current auth regression source of truth.