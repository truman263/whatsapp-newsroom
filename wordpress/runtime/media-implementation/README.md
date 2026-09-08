# Newsroom media implementation runtime

Disposable local validation for the Node.js `@newsroom/api` WordPress media HMAC adapter (`apps/api/src/modules/wordpress-media/`) against a real WordPress 7.1/PHP 8.2/MariaDB 10.11 stack running the production Newsroom Bridge. It mounts `wordpress/newsroom-bridge/` read-only. The only extra fixture is a test-only mu-plugin (`fixtures/newsroom-media-fault-harness.php`) that can inject faults (upload-dir exhaustion, file-type rejection, attachment insert failure, metadata failure) behind the `test_media_fault_phase` option; the production plugin never references it.

Run from the repository root:

```text
node wordpress/runtime/media-implementation/run-media-implementation-tests.mjs
```

The harness compiles the real client sources (`wordpress-media.client.ts`, `wordpress-media-hmac.ts`, `wordpress-media.errors.ts`, `wordpress-media.types.ts`) with the repository TypeScript compiler into `.build/` (gitignored), then drives the compiled `WordPressMediaClient` over HTTP against the loopback-only WordPress stack. It proves Node signer ↔ WordPress verifier interoperability for the media contract (POST `/newsroom-media/v1/media`, GET `/newsroom-media/v1/media/{uuid}`), create/201 and replay consistency, conflict behavior, duplicate media-upload idempotency, GC adoption / orphan / scoped-file passes and the hourly GC gate, fault-window recovery in all four phases, concurrency, redirect/header hygiene, malformed-response rejection, bounded unavailability, reserved-then-stale reclaim, and absence of secret sentinels in logs, database, and approved repository artifacts.

The harness accepts only loopback targets, generates ephemeral credentials inside its lifecycle, and does not print credentials. Root `.env` and `.env.*` files are excluded from repository persistence checks without being opened. The generated `.env.runtime` is deleted in `finally`; cleanup results and Docker project-label residue queries are checked. Abnormal termination or host/Docker failure can interrupt cleanup, so operators must verify residue after such an event.

No production or Simbidzebasa endpoint is contacted.