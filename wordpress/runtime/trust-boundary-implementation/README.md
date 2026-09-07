# Newsroom trust-boundary implementation runtime

Disposable local validation for the production Newsroom Bridge 1.1.0 trust-boundary implementation. It mounts `wordpress/newsroom-bridge/` read-only and does not mount or reuse the Round 2B.2A authentication shim.

Run from the repository root:

```text
node wordpress/runtime/trust-boundary-implementation/run-implementation-tests.mjs
```

The harness accepts only a loopback target, generates local credentials inside its lifecycle, and does not print credentials. Repository persistence checks read only an explicit approved artifact list; root `.env` and `.env.*` files are excluded from that list without being opened. The generated `.env.runtime` is used only for lifecycle management and is deleted in `finally`. Cleanup command results and Docker project-label residue queries are checked; uncertainty or residue fails validation. Abnormal process termination or host/Docker failure can interrupt cleanup, so operators must verify residue after such an event.

The test probe is fixture-only code used for same/different-object nested attacks, in-process restoration faults, controlled policy drift, durable-state snapshots, and fail-closed database inspection. It is **TEST ONLY — NEVER DEPLOY**. No production or Simbidzebasa endpoint is contacted.
