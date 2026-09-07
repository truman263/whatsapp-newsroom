# Newsroom backend draft adapter runtime

Disposable local validation for the Node.js `@newsroom/api` WordPress draft HMAC adapter (`apps/api/src/modules/wordpress-draft/`) against a real WordPress 7.1/PHP 8.2/MariaDB 10.11 stack running the production Newsroom Bridge. It mounts `wordpress/newsroom-bridge/` read-only and does not mount any other shim or probe.

Run from the repository root:

```text
node wordpress/runtime/backend-draft-adapter/run-backend-draft-adapter-tests.mjs
```

The harness compiles the real client sources (`wordpress-draft.client.ts`, `wordpress-hmac.ts`, `wordpress-draft.errors.ts`, `wordpress-draft.types.ts`) with the repository TypeScript compiler into `.build/` (gitignored), then drives the compiled `WordPressDraftClient` over HTTP against the loopback-only WordPress stack. It proves Node signer ↔ WordPress verifier interoperability, draft creation/read/replay/conflict, dropped/undelivered/uncertain responses, redirect handling, malformed DTO rejection, bounded unavailability, header hygiene (no generic authentication headers), and absence of secret sentinels in logs, database, and approved repository artifacts.

The harness accepts only loopback targets, generates ephemeral credentials inside its lifecycle, and does not print credentials. Root `.env` and `.env.*` files are excluded from repository persistence checks without being opened. The generated `.env.runtime` is deleted in `finally`; cleanup results and Docker project-label residue queries are checked. Abnormal termination or host/Docker failure can interrupt cleanup, so operators must verify residue after such an event.

No production or Simbidzebasa endpoint is contacted.