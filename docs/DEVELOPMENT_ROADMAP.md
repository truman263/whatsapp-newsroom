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

**Status: CURRENT**

## Round 2B — WordPress adapter and controlled integration

Isolated WordPress client, authenticated capability verification, category synchronisation, controlled DRAFT creation only, media upload, featured image, category assignment, draft retrieval/update, reconciliation of uncertain draft creation, and no public publication test.

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
