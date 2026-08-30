# Newsroom Bridge disposable runtime

Test-only Docker harness for Round 2B.1. It uses digest-pinned images, binds WordPress to loopback, keeps MariaDB internal, generates disposable credentials, mounts the approved bridge read-only, and removes containers and volumes after evidence collection.

The fault injector is **TEST ONLY — NEVER DEPLOY**, requires an explicit Compose-only local test gate, and is deliberately separate from `wordpress/newsroom-bridge/`.

Run from the repository root:

```text
node wordpress/runtime/newsroom-bridge/run-runtime-tests.mjs
```

The harness refuses non-loopback targets and never reads the repository-root `.env`.
