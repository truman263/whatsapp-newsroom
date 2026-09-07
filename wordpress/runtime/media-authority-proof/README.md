# Media authority proof (Round 2B.3B)

Disposable evidence for the WordPress media-authority and idempotency
architecture. **Nothing here is production code and nothing here is deployed.**

## What it proves

- Media authority is **separate** from draft authority: a media HMAC key ring,
  media service identity, and media-specific canonical protocol with its own
  header name set and positive route allow-list.
- No generic WordPress credential exists anywhere in the backend; the media
  secret authenticates nothing outside the two approved media routes.
- Deterministic media-key idempotency with distinct, durable conflict and
  reconciliation semantics; GET recovery after uncertain POST.
- Crash/fault-window modelling, bounded orphan detection/recovery, identical
  and conflicting concurrency, and response-loss recovery.
- Minimum media service capabilities (`read`, `upload_files`) established from
  actual WordPress behaviour rather than speculation.

## Layout

- `compose.yaml` — digest-pinned WordPress 7.1 / PHP 8.2 / MariaDB 10.11 /
  WP-CLI; loopback-only; production Newsroom Bridge mounted **read-only**;
  `./bridge` mounted read-only as the `media-newsroom-proof` plugin.
- `bridge/*.php` — TEST-ONLY prototype plugin: config, media auth, media
  store, media controller. Every file is labelled TEST-ONLY and is never
  loaded by the production plugin.
- `run-media-authority-proof-tests.mjs` — harness: provisioning, reference
  Node media HMAC signer + client, loopback fault proxies, the full proof
  matrix, evidence writing, and teardown with residue checks.

## Run

```powershell
node wordpress/runtime/media-authority-proof/run-media-authority-proof-tests.mjs
```

Needs Docker with Compose. The harness generates ephemeral secrets, writes
`.env.runtime` (removed in `finally`), never reads the repository-root `.env`,
and verifies the frozen production bridge hashes before and after runtime.
`runtime-results.json` is the sanitized evidence file (git-ignored).

## The test-only media namespace

The two approved routes are registered under the **test-only** namespace
`/newsroom-media/v1` (`POST /newsroom-media/v1/media`,
`GET /newsroom-media/v1/media/{canonical-lowercase-uuid-v4}`).

This differs from the conceptually-preferred `/newsroom/v1/media`: the frozen
production Newsroom Bridge owns the `/newsroom/` REST prefix and returns an
exact 401 for every non-draft request carrying *any* `X-Newsroom-*` header,
so a second, independent authority cannot be proven positively under that
prefix in the same runtime. The disposable media authority therefore uses its
own `X-Newsroom-Media-*` header set, own key ring, own service identity, and
own namespace. The **canonical media HMAC protocol** frozen by this proof is
route-agnostic: the concrete route is a signed field, so the documented
production layout (`/newsroom/v1/media`) carries the same protocol without
changing its semantics. See `docs/WORDPRESS_MEDIA_AUTHORITY_DESIGN.md`.