# Round 6B.2 draft-preparation orchestration proof

Disposable-only proof using PostgreSQL 16 and the existing WordPress 7.1 / PHP 8.2 / MariaDB 10.11 compose definition. It invokes the unreachable Phase-A primitive and worker directly with an injected loopback transport; production HTTPS policy is unchanged.

Run from the repository root:

`node wordpress/runtime/draft-preparation/run-draft-preparation-proof.mjs`
