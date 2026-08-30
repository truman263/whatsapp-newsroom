# Development roadmap

1. **Round 0 — Repository/application foundation**: approved.
2. **Round 1 — Domain model and database foundation**: implemented pending architectural review; includes PostgreSQL schema, migration SQL, constraints, indexes, concurrency/transaction contracts, and honest schema-level tests.
3. **Round 2 — WordPress integration**: isolated REST client, authentication, contracts, reconciliation behavior, and integration tests.
4. **Round 3 — WhatsApp webhook ingestion**: authenticity verification, normalization, database-backed deduplication, and durable ingestion.
5. **Round 4 — Reporter authorization and deterministic conversation state machine**: allowlisting and approved compare-and-set transitions.
6. **Round 5 — Story/media collection**: deterministic content collection, validation, and a production decision for durable media binary staging/recovery.
7. **Round 6 — WordPress draft workflow**: persisted attempts, draft reconciliation, synchronization, and preview delivery.
8. **Round 7 — Approval and publishing workflow**: explicit approval provenance and decoupled publication orchestration.
9. **Round 8 — Failure handling, recovery, security hardening, and production validation**: retries, operational recovery, audit review, PostgreSQL constraint integration tests, security testing, and release readiness.

Each round requires architectural review before the next begins.
