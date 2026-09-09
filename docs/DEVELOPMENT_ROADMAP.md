# Development roadmap

## Round 0 — Repository/application foundation

**Status: APPROVED**

## Round 1 — Production domain model and PostgreSQL foundation

**Status: APPROVED**

## Round 1.1 — Live PostgreSQL migration and persistence-invariant validation

**Status: APPROVED**

## Round 1.2 — Simbidzebasa WordPress contract alignment

- Editorial bylines
- WordPress categories
- Multi-category Story relationships

**Status: APPROVED**

## Round 2A — Simbidzebasa WordPress contract discovery

Read-only first: REST API availability, authentication capability, actual post type, category IDs/names/slugs, media endpoint, featured-media behaviour, writable post fields, custom metadata capability, reconciliation/idempotency mechanism, and relevant theme/plugin behaviour.

**Status: APPROVED**

## Round 2B.0 — WordPress reconciliation bridge

Local Newsroom Bridge source, private reconciliation storage, idempotent draft-create contract, deterministic recovery lookup, and static/local validation only.

**Status: APPROVED**

## Round 2B.1 — WordPress runtime and fault-injection validation

- Disposable/staging WordPress environment
- Plugin installation/activation validation
- Schema and `dbDelta()` validation
- Permissions
- Transaction rollback
- Concurrent same-key requests
- Concurrent conflicting requests
- Uncertain-response recovery
- Cache behavior
- Category assignment
- Hook/plugin side-effect review
- No public publication

**Status: APPROVED**

## Round 2B.2A — WordPress trust-boundary architecture and disposable security proof

Design and locally prove a route-scoped authentication architecture that removes generic WordPress credentials from the newsroom backend, locks down the draft service identity, preserves deterministic draft reconciliation, separates future publication authority, and leaves ordinary WordPress users unaffected.

**Status: APPROVED**

## Round 2B.2B — WordPress trust-boundary implementation and validation

Implement the supervisor-approved authentication boundary in production-quality WordPress source, validate it locally/staging, and prepare an audited migration plan. No publication, production deployment, or backend adapter work is implied.

**Status: APPROVED**

## Round 2B.3A — WordPress backend draft adapter (HMAC)

Implement the Node.js backend draft adapter in `@newsroom/api` that signs newsroom HMAC requests to the production Newsroom Bridge and performs deterministic draft creation with recoverable uncertain outcomes. No publication, media authority, or production deployment work is implied; it is validated locally/staging against the frozen bridge.

**Status: APPROVED**

## Round 2B.3B — WordPress media authority and idempotency

Design and prove (disposable runtime only) a media authority that is deliberately separate from the draft authority: media-specific canonical HMAC headers and key ring, dedicated media service identity, media reconciliation table, reservation-first idempotency, replay/conflict semantics, crash-window recovery, and orphan garbage collection. No publication work is implied; validation is local/staging only against the frozen bridge.

**Status: APPROVED**

## Round 2B.3C — Production media bridge + backend media adapter implementation

Implement the supervisor-approved media authority in production-quality WordPress source (production media bridge extension) and the Node.js backend media adapter, extending the Round 2B.3B proof design and the Round 2B.3A draft client.

**Status: CURRENT — production media bridge + backend media adapter implemented and validated in the disposable runtime; production deployment NO-GO**

## Round 2B.4A — WordPress draft sync + featured media design and disposable proof

Architecture and disposable-proof for full-state draft synchronisation (title, body, excerpt, exact category set, featured media by media key) with fingerprint-version CAS, replay idempotency, uncertain-outcome fail-closed semantics, and no status/author mutation or publication. 2B.4B will implement the design in production-quality backend (Node adapter + page) and production bridge extensions; production work remains NO-GO until the supervisor approves this round's report.

**Status: APPROVED** — disposable proof validated in the disposable runtime; production implementation recorded in Round 2B.4B.

## Round 2B.4B — Production draft sync + featured media implementation

Implement the approved 2B.4A design in production-quality backend (Node adapter) and production bridge extensions (sync PUT + state GET, featured media by media key, fingerprint-version CAS, production auth regression on the current runtime). No publication, deployment, or production validation work is implied.

**Status: CURRENT — production sync/state implementation validated in the disposable runtime (57 evidence groups); production deployment NO-GO**

## Round 2B — WordPress adapter and controlled integration

Isolated WordPress client using capabilities already confirmed during approved Round 2A discovery, category synchronisation, controlled DRAFT creation only, media upload, featured image, category assignment, draft retrieval/update, reconciliation of uncertain draft creation, and no public publication test.

**Status: PENDING**

## Production deployment (all of Round 2B)

**Status: NO-GO** — deployment of any WordPress media/draft authority work is not permitted until the supervisor approves the full Round 2B sequence.

## Round 3 — WhatsApp Cloud API webhook ingestion

Webhook verification, signature authenticity, normalisation, durable InboundEvent persistence, and database-backed deduplication.

## Round 4 — Reporter authorisation and deterministic conversation state machine

Phone allowlist, Reporter provisioning, Conversation provisioning, and compare-and-set transitions.

## Round 5 — Simbidzebasa-aligned Story/media collection

Headline, Story byline snapshot, body, categories, images, deterministic ordering, completeness validation, and durable media staging decision.

## Round 6 — WordPress draft and WhatsApp preview workflow

Draft creation, media/category synchronisation, preview/review response, and recoverable external attempts.

## Round 7 — Explicit approval and publication

Persisted Approval provenance, APPROVE command, publish attempt, reconciliation, final WordPress publication, and confirmation to Reporter.

## Round 8 — Production hardening

Retries, failure recovery, abandoned processing recovery, security review, logging/redaction, audit review, WordPress failure testing, Meta failure testing, load/concurrency validation, and release readiness.

Every round requires supervisor architectural approval before the next begins.
