# Architecture

## Modular monolith

The system is one deployable NestJS API with explicit feature-module boundaries. The initial newsroom does not justify distributed deployment, brokers, cross-service contracts, or eventual-consistency overhead. A boundary may be extracted only when measured operational needs justify it.

There is one newsroom, one configured WordPress site, and one WhatsApp Business integration. WordPress deployment configuration is not a tenant. No Organisation, Tenant, Publication, Workspace, or Site persistence model exists.

## Boundaries and dependency direction

- Controllers handle transport concerns only.
- Application services will coordinate use cases independently of WhatsApp or future admin entry points.
- WhatsApp and WordPress payloads remain inside their future adapters.
- Prisma is available through `DatabaseModule` and `PrismaService`; ad-hoc clients are prohibited in application code.
- Feature-specific repositories will be concrete, thin, and colocated with their feature when a real use case requires a method. Round 1 does not add empty repositories, generic base repositories, or speculative CRUD methods merely for ceremony.
- Prisma types never become public HTTP DTOs.
- The health module reports application liveness only.

External systems are Meta WhatsApp Cloud API, PostgreSQL, and WordPress REST API. No external API implementation exists in Round 1.

WordPress is authoritative for category IDs. Category names and slugs are synchronised metadata discovered from the REST API, not hardcoded from the public site, and homepage sections are not automatically taxonomy. Stories support multiple categories without a primary category. Round 2A performs read-only contract discovery before any adapter writes. The configured technical WordPress publishing identity remains separate from Reporter editorial identity; Reporter stores current byline preference and Story stores historical byline provenance.

## Transaction boundaries

1. State changes involving multiple local records use short PostgreSQL transactions.
2. Meta and WordPress HTTP calls never run inside a database transaction.
3. Persisted inbound events, outbound intents, approvals, and publish attempts surround external side effects.
4. An uncertain external outcome is reconciled; failure does not imply the external side effect did not happen.
5. `(provider, providerMessageId)` uniqueness absorbs duplicate inbound messages.
6. Explicit Approval is persisted before publish execution begins.
7. `PUBLISHED` is recorded only after WordPress success is confirmed or reconciled.

There is no distributed transaction claim. Later WordPress work must reconcile uncertain `CREATE_DRAFT` outcomes using the Story `wordpressDraftKey` before retrying.

The initial Round 1 migration has been applied and validated against a fresh development/test PostgreSQL schema. Live tests confirmed the short transaction, optimistic compare-and-set, uniqueness, nullable uniqueness, and referential-action primitives described here; they do not implement any newsroom workflow.

## Evidence-preserving deletion

Historical and audit relations use `ON DELETE RESTRICT`, including both StoryCategory links and nullable audit links when they are populated. `SET NULL` is limited to the transient Conversation current-story pointer and the optional InboundEvent reporter association; both preserve the dependent row. No relation uses cascading delete. Reporter/category deactivation and Story cancellation are state changes, not deletion APIs.

## Concurrency

Conversation and Story carry integer versions for optimistic compare-and-set transitions. Conflicting updates reload and re-evaluate rather than silently overwriting. No generic locking framework is introduced.

Future workflow transitions must be deterministic and explicitly approved. AI is not part of the publication control path.
