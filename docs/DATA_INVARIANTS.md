# Data invariants

This document records Round 1 database guarantees and the application invariants that later rounds must enforce without weakening the schema.

## Live PostgreSQL verification

Round 1.1 applied the initial migration to a fresh development/test PostgreSQL schema and physically verified its nine domain tables, fourteen enums, fourteen foreign keys, fifteen non-primary unique indexes, twenty-four ordinary indexes, and seven manual checks. Database integration tests also proved nullable unique behavior, evidence-preserving referential actions, transaction rollback, Story/Conversation compare-and-set behavior, and exactly one successful insert during a concurrent duplicate inbound-message race. The run-scoped fixtures were removed after testing, and a database-to-schema comparison reported no drift.

## Identity and idempotency

- All domain primary keys are database-generated UUIDs.
- Reporter phone number is unique and must be canonical E.164 before persistence.
- `(InboundEvent.provider, InboundEvent.providerMessageId)` is the provider-message idempotency boundary.
- `OutboundMessage.correlationKey` uniquely identifies a logical outbound response.
- Non-null outbound provider message IDs are unique.
- `Story.wordpressDraftKey` is a unique database-generated UUID independent of headline/title.
- Non-null Story WordPress post IDs and StoryMedia WordPress media IDs are unique.
- `PublishAttempt.idempotencyKey` is globally unique.
- `EditorialCategory.wordpressCategoryId` is globally unique and is the authoritative WordPress taxonomy identity; mutable name and slug are not identity.

PostgreSQL unique indexes allow multiple nulls, which is intentional for identifiers that do not exist until an external operation succeeds.

## Reporter and Conversation

- `Conversation.reporterId` uniqueness enforces at most one Conversation per Reporter.
- Later reporter provisioning creates Reporter and Conversation in one short transaction to uphold exactly one at the domain boundary.
- Conversation `version` begins at zero and is database-checked as nonnegative.
- `currentStoryId` is nullable and unique. Normal `IDLE` behavior requires null.
- A selected current Story must belong to the same Reporter; later transition code enforces this cross-row invariant.
- Deleting a current Story sets the transient pointer null and never cascades through the Conversation.

## Story and media

- Story headline/body are nullable during collection; state-dependent completeness is an application transition invariant.
- Story `version` begins at zero and is database-checked as nonnegative.
- `(StoryMedia.storyId, StoryMedia.position)` uniquely determines deterministic media order.
- StoryMedia provider IDs are globally unique for the one configured provider deployment.
- Media positions and file sizes are database-checked as nonnegative.
- PostgreSQL stores metadata only. Temporary WhatsApp media URLs are not durable storage.
- Durable binary staging and recovery must be decided before production media processing is complete.
- Reporter `editorialByline` is nullable current preference; Story `byline` is a nullable historical snapshot and is not automatically updated with Reporter changes.
- `(StoryCategory.storyId, StoryCategory.categoryId)` uniquely prevents duplicate assignment and supports multiple categories per Story.
- No primary category exists. Later publication logic must require at least one active category, but that application invariant is not implemented in Round 1.2.

## Approval provenance

- `Approval.storyId` uniqueness permits one V1 approval record per Story.
- `Approval.inboundEventId` uniqueness prevents one inbound command approving multiple stories.
- Approval retains required Reporter, Story, and InboundEvent relations with delete restriction.
- Approval has no `updatedAt` and normal application code treats it as immutable evidence.
- Cancellation is represented by Story state and audit provenance, not a negative Approval record.
- Explicit Approval is persisted before any publish execution begins.

## WordPress attempts and reconciliation

- `(storyId, operation, attemptNumber)` is unique and attempt numbers are database-checked as positive.
- A persisted attempt does not make WordPress transactional.
- `RECONCILIATION_REQUIRED` represents uncertainty about an external result.
- Before retrying an uncertain `CREATE_DRAFT`, later logic reconciles using the Story `wordpressDraftKey` and WordPress lookup.
- External HTTP calls never run inside a PostgreSQL transaction.
- `PUBLISHED` is recorded only after confirmed or reconciled WordPress success.

## Optimistic concurrency

Story and Conversation changes use expected status plus expected version in a short compare-and-set operation, incrementing version atomically. Zero affected rows mean stale state or a lost race; the caller reloads and re-evaluates. Prisma `updateMany`, optionally inside a short transaction with other local writes, can implement this without a generic locking framework.

## Evidence and deletion

- Historical relations, including populated audit links, use `RESTRICT`.
- Both StoryCategory foreign keys use `RESTRICT`; category deactivation preserves associations and a category with Story history cannot be deleted.
- `SET NULL` is limited to the transient current-story pointer and optional InboundEvent reporter association.
- No foreign key uses cascading delete.
- Reporter deactivation is `INACTIVE`; Story cancellation is `CANCELLED`.
- Inbound payloads, outbound payloads, errors, and audit metadata exclude secrets and unnecessary personal data.
- AuditLog has no `updatedAt` and is append-only by application contract.
- Database permissions or triggers for hard append-only enforcement are not introduced in Round 1 and remain a production-hardening consideration.
