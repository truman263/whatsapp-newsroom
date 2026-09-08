# Newsroom Draft Sync Proof (Round 2B.4A) — TEST-ONLY

Disposable proof of the controlled **draft synchronisation + featured media**
design for the Newsroom Bridge. It layers a single full-state sync surface and
featured-media resolution onto the **frozen production** Newsroom Bridge
classes without modifying any production source.

**NEVER DEPLOY. NOT PRODUCTION.** The prototype plugin is gated by
`NEWSROOM_DRAFT_SYNC_PROOF` (true only here) and the production
`newsroom-bridge` plugin stays **inactive** in this runtime.

The inactive status is deliberate: the committed production draft auth
positively allows only its current create/get routes, so it would reject the
prototype sync/state routes; activating both auth stacks would also duplicate
authentication filters and endpoint wrappers. The test-only loader owns
activation/authentication and instantiates committed production handler
classes directly from the read-only mount. `Newsroom_Bridge_REST` handles draft
POST/GET/replay/conflict, and `Newsroom_Bridge_Media_REST` handles media
upload/GET. Only `Newsroom_Bridge_Draft_Sync_REST` handles sync PUT/state GET.

## What it proves

- Full-state sync `PUT /newsroom/v1/drafts/{draft_key}`:
  `{title, content, excerpt, categories, featured_media_key}`.
- Canonical read `GET /newsroom/v1/drafts/{draft_key}/state`.
- CAS: optional `expected_version` sha256 fingerprint, rejected stale with
  409 `newsroom_draft_sync_stale_version`; comparison runs inside the sync
  transaction under a writer lock, so concurrent CAS writers yield exactly one
  winner per version.
- Featured media by media key: identity-scoped validation, `null` clears only
  `_thumbnail_id` (attachments and media rows are never deleted).
- Idempotent replay, exact category replacement, postcondition verification,
  rollback on partial failure, and uncertain-outcome detection.
- HMAC allow-list extension for the two new routes on a line-for-line mirror of
  the frozen draft authority.
- Full hygiene: loopback-only port, generated secrets, secret sentinel audits,
  zero container/volume residue, frozen production hashes unchanged.

## Layout

- `compose.yaml` — disposable stack (`wordpress:7.1-php8.2-apache`,
  `mariadb:10.11`, `wordpress:cli`, all digest-pinned). The production plugin
  is mounted `:ro` and stays inactive.
- `bridge/` — prototype plugin `newsroom-draft-sync-proof` (loader + the
  test-only sync auth + sync REST class). Nothing here is production code.
- `fixtures/newsroom-draft-sync-fault-harness.php` — mu-plugin fault injection
  (`during_update`, `mismatched_store`).
- `run-draft-sync-proof-tests.mjs` — the full disposable evidence suite. It
  compiles the frozen `wordpress-draft.client.ts` harness build, starts the
  stack, runs every evidence group, tears everything down, and writes
  `runtime-results.json` (git-ignored, always temporary).
- `runtime-results.json` — written by the runner only; never committed.

## Run

```pwsh
node --check run-draft-sync-proof-tests.mjs
node run-draft-sync-proof-tests.mjs
```

The suite exits `0` only if every evidence group passes, the frozen/integrity
hashes are unchanged, and cleanup leaves no containers, volumes, or
`.env.runtime` behind.

## Hygiene

- `127.0.0.1` loopback only; secrets are generated per run and never written to
  the repository.
- `.env.runtime`, `runtime-results.json`, `.build/` are git-ignored.
- See `docs/WORDPRESS_DRAFT_SYNC_DESIGN.md` for the design this proof validates.
