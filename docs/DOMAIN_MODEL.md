# Domain model

Round 1 establishes the PostgreSQL persistence model. It does not implement workflows, transitions, external integrations, or HTTP contracts.

## Reporter

An authorised WhatsApp user. `phoneNumber` is unique and stored in canonical E.164 form. The database reserves 16 characters for `+` and up to 15 digits; full parsing, validation, and canonicalisation happen at the application boundary before persistence. `displayName` is operational identity, while nullable `editorialByline` is the Reporter’s current preferred publication byline. Reporter deactivation uses `INACTIVE`; deletion is not a routine domain operation. Credentials, WordPress-user links, and login fields do not belong on Reporter: the technical WordPress publishing account is separate from journalist editorial identity.

A Reporter has at most one Conversation by the unique `Conversation.reporterId` foreign key. Relational databases cannot require every parent row to have a child row, so later reporter provisioning must create Reporter and Conversation together in one short transaction to uphold the domain's exactly-one rule.

## Conversation

A durable state container for one Reporter, not chat-session history. `currentStoryId` is a nullable, unique pointer to the active Story. It is null during normal `IDLE` behavior. The pointer owns neither the Story nor its history: deleting the referenced Story sets the pointer null, while other historical relations normally prevent story deletion.

The Reporter must own the selected current Story. This cross-row equality cannot be expressed by the current foreign keys and must be enforced by the later compare-and-set application transition.

## InboundEvent

A normalised provider message/event and the durable ingestion boundary. It is not a raw HTTP request log. `(provider, providerMessageId)` is unique, absorbing duplicate provider message deliveries. Unknown senders are retained using nullable `reporterId` plus the required canonical `senderPhone`. Recovery fields record processing status, attempts, start/completion times, and sanitised errors.

`rawPayload` is evidence for the normalised provider event only. It must exclude credentials, authorization headers, and unrelated HTTP request data.

## OutboundMessage

Provider-neutral persisted delivery intent. `correlationKey` uniquely identifies a logical response. A non-null `providerMessageId` is unique under PostgreSQL semantics. Payload contains intended message content, never access tokens or headers. Delivery attempts and timestamps support later recovery without implementing sending in Round 1.

## Story

The canonical newsroom content aggregate. Headline and body remain nullable while collection is incomplete. State-dependent completeness will be enforced later by application transitions. Nullable `byline` is historical editorial provenance. Later creation logic will snapshot `Reporter.editorialByline ?? Reporter.displayName`; changing the Reporter later does not update an existing Story. In normal use the snapshot is immutable after creation, and `body` remains canonical article content rather than containing rendered byline text.

`wordpressDraftKey` is a database-generated UUID, unique and independent of mutable content. It is a reconciliation key, not a public slug. Non-null `wordpressPostId` is unique. WordPress IDs use PostgreSQL `BIGINT` to preserve the external identifier range.

## EditorialCategory and StoryCategory

`EditorialCategory.wordpressCategoryId` is the unique, authoritative external taxonomy identity and uses PostgreSQL `BIGINT`. `name` and `slug` are mutable metadata synchronised from WordPress; neither is identity and neither is derived from the other. The public site’s currently visible categories are not seeded or hardcoded truth, and homepage presentation sections do not automatically define taxonomy. Round 2A will discover the actual taxonomy and capabilities through the WordPress REST API.

`StoryCategory` is the explicit many-to-many association. Its `(storyId, categoryId)` primary key prevents duplicate assignment, while `createdAt` records when the historical newsroom metadata was attached. A Story can have multiple categories and no primary-category semantic is assumed. Both foreign keys restrict deletion. Setting an EditorialCategory to `INACTIVE` retains its historical Story associations; routine retirement is a status change, not deletion.

## StoryMedia

Metadata for media associated with a Story. Media order is unique by `(storyId, position)`. Provider media identifiers and non-null WordPress media identifiers are unique. Binary content and temporary WhatsApp URLs are not stored as durable media. Durable binary staging and recovery remain unresolved before production media processing.

## Approval

Immutable-in-normal-use provenance for one explicit positive approval. Both `storyId` and `inboundEventId` are unique, so one Story has at most one V1 Approval and one inbound command cannot approve multiple stories. Required foreign keys to Story, Reporter, and InboundEvent use delete restriction to preserve provenance.

Cancellation is a Story state/audit action, not an Approval decision.

## PublishAttempt

A persisted attempt for `CREATE_DRAFT` or `PUBLISH`. Global `idempotencyKey` uniqueness prevents duplicated logical attempts; `(storyId, operation, attemptNumber)` is also unique. Attempt numbers are database-checked as positive. `RECONCILIATION_REQUIRED` records uncertain external outcomes without claiming WordPress transactionality.

## AuditLog

Append-only newsroom/system provenance. It intentionally has no `updatedAt`. Optional links support timelines and investigation; `entityType` and `entityId` can identify an entity that has no dedicated relation. Metadata must be minimal and sanitised. Normal application code must never update or casually delete audit records.

## Persistence types

Prisma records are persistence representations, not HTTP DTOs or the complete domain model. Later repositories will translate persistence operations for specific application use cases rather than exposing Prisma delegates to controllers.
