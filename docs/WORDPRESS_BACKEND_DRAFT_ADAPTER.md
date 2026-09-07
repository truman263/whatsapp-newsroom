# WordPress backend draft adapter

Round 2B.3A: the Node.js backend draft adapter in `@newsroom/api` that talks to the production Newsroom Bridge (Round 2B.2B) over the frozen newsroom HMAC contract. Scope is draft creation only — no publication, no media authority (see ROADMAP Round 2B.3B).

## Approved contract (frozen, Round 2B.2B)

- Canonical string: `newsroom-hmac-v1\n{key_id}\n{UPPERCASE_METHOD}\n{concrete_canonical_rest_route}\n{unix_timestamp}\n{lowercase_sha256_of_exact_raw_body}` — 6 fields, one LF between, no trailing LF.
- HMAC-SHA-256 over the secret; signature is 64 lowercase hex. Secret is a canonical 43-character unpadded base64url value decoding to exactly 32 bytes, strictly canonical re-encoded.
- Key id: `[a-z0-9]` start, `{0,63}` allowed `[a-z0-9._-]`.
- Timestamp: integer Unix seconds; server accepts `[0-9]{10,12}` with `MAX_CLOCK_SKEW = 300`.
- POST route `/newsroom/v1/drafts`; GET route `/newsroom/v1/drafts/{lowercase-uuid-v4}`.
- URL is `baseUrl + /wp-json + route`. GET sends no body and no `Content-Type`. POST sends `Content-Type: application/json`. `redirect: 'manual'`. TLS verification is never disabled.
- Server DTOs (201): `{draft_key, post_id, replayed: false, status: 'draft'}`; (200 replay): `{post_id, replayed: true, status: 'draft'}`; GET 200: `{draft_key, post_id, status: 'draft'}`; GET 404: `{code: 'not_found'}`.
- WordPress fingerprint body: `{contract_version: 1, title, content, excerpt: '', categories}` (categories deduplicated and sorted server-side).

## Implementation (`apps/api/src/modules/wordpress-draft`)

- `wordpress-hmac.ts` — key-id validation, strict secret decode, route approval, and the 6-field canonical signer (`signNewsroomRequest`).
- `wordpress-draft.errors.ts` — `WordPressDraftError` with `AUTHENTICATION_FAILURE | CONTRACT_FAILURE | CONFLICT | NOT_FOUND | UNCERTAIN_OUTCOME | WORDPRESS_UNAVAILABLE | UNEXPECTED_RESPONSE`.
- `wordpress-draft.types.ts` — `CreateWordPressDraftInput`, `WordPressDraftReference`, `CreateWordPressDraftResult`, `WordPressDraftClientOptions`.
- `wordpress-draft.client.ts` — `WordPressDraftClient`: base URL validation (absolute http/https, no userinfo/query/fragment, subdirectory-safe `wp-json` path join), injected clock/transport, strict DTO validators, and the uncertain-outcome algorithm:

  - POST OK 200/201 → `CREATED`/`REPLAYED`.
  - Transport throw or HTTP >= 500 → `UNCERTAIN_OUTCOME` at the transport, then bounded reconciliation GETs.
  - GET 200 → `RECOVERED`; GET 404 → bounded retry of the **same** POST (same key/payload, fresh timestamp/signature); GET uncertain/unavailable → throw `UNCERTAIN_OUTCOME` — never a blind second POST.
  - 401 → `AUTHENTICATION_FAILURE`; 3xx/400/422/403 → `CONTRACT_FAILURE`; 409 → `CONFLICT`; 404 → `NOT_FOUND`; malformed DTOs → `UNEXPECTED_RESPONSE`; constructor/input violations → `CONTRACT_FAILURE`.

- `wordpress-draft.module.ts` — Nest module wiring through `ConfigService`.
- `apps/api/src/app.module.ts`, `apps/api/src/config/configuration.ts`, `apps/api/src/config/env.schema.ts`, `.env.example` — configuration/environment wiring (`DRAFT_HMAC_KEY_ID`, `DRAFT_HMAC_SECRET`, `REQUEST_TIMEOUT_MS`, `RECONCILIATION_ATTEMPTS`, `RECONCILIATION_DELAY_MS`). No secrets are committed; the example file holds placeholders only.

## Validation

- Unit: `wordpress-hmac.spec.ts` (22 exact-vector tests) and `wordpress-draft.client.spec.ts` (client behaviour), passing under the strict `tseslint.recommendedTypeChecked` config. Full suite: `pnpm lint`, `pnpm typecheck`, `pnpm test` (94 tests, 5 suites).
- Runtime harness: `wordpress/runtime/backend-draft-adapter/run-backend-draft-adapter-tests.mjs` compiles the **real** client sources with the repository TypeScript compiler and drives them over loopback HTTP against a digest-pinned WordPress 7.1/PHP 8.2/MariaDB 10.11 stack running the frozen Newsroom Bridge read-only. Evidence covers: Node signer ↔ WordPress verifier interop (201 + fingerprint mapping), GET 200, signed replay, 409 conflict, committed-then-dropped response recovery (`RECOVERED`), undelivered POST → GET 404 → retried POST (`CREATED`), GET-unavailable with no blind second POST, 401 for unknown key id, header hygiene (no generic authentication headers), manual redirects with no HMAC leak, malformed DTO rejection, bounded unavailability, and no secret sentinels in logs, database, or approved repository artifacts.
- Frozen bridge hashes are re-verified before and after runtime; teardown is exit-status checked with zero container/volume residue.

No production or Simbidzebasa endpoint has been contacted. Production deployment remains NO-GO until Round 2B closes under supervisor review.