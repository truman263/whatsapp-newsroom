# Newsroom trust-boundary disposable proof

Test-only Round 2B.2A harness for WordPress 7.1. It characterizes the current Application Password write surface, proves that role reduction alone is insufficient, and exercises a newsroom-route-scoped HMAC prototype with an identity-scoped service-user lockdown.

The hardening shim is **TEST ONLY — NEVER DEPLOY**. The approved production bridge is mounted read-only and is not modified.

The version-1 prototype accepts only top-level direct requests for the two approved newsroom routes. POST requires `application/json` or `application/json; charset=utf-8` and explicitly rejects multipart. GET requires a zero-byte body and no Content-Type. Query strings, WordPress method overrides, alternative path representations, batch use, malformed key rings, and dangerous service-user capability drift fail closed. The signature covers the concrete route and exact raw body bytes.

HMAC authentication-boundary denials require exact HTTP 401. HTTP 403 is reserved for deliberate ordinary-user authorization tests and is not accepted as route-isolation proof. Embedded batch evidence requires an explicit inner HTTP 401; missing response data fails the test.

PHP rejects duplicate-header ambiguity that reaches the application. Because some ingress stacks may collapse duplicates before PHP, a production CDN/reverse proxy must reject duplicate `X-Newsroom-*` and Content-Type headers, and that behavior must be validated before any production write. The prototype is not production hardening.

Run from the repository root:

```text
node wordpress/runtime/trust-boundary/run-trust-boundary-tests.mjs
```

The harness uses digest-pinned images, binds WordPress only to `127.0.0.1`, keeps MariaDB internal, generates disposable credentials inside its `try`/`finally`-guarded lifecycle, and never reads the repository-root `.env`. Cleanup is attempted on all handled execution paths; Compose teardown and project-scoped residue queries must succeed, zero containers and volumes must remain, and `.env.runtime` must be absent. Uncertainty in any cleanup check fails validation. Abnormal process termination, host or power failure, Docker daemon failure, or an equivalent out-of-process interruption can prevent cleanup from running and requires operator residue verification.
