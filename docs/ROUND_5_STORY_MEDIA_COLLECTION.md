# Round 5 — Simbidzebasa Story and media collection

**Status: ARCHITECTURE FREEZE — supervisor decision required before implementation**

## 1. Scope and non-goals

Round 5 owns deterministic Story creation and attachment, byline snapshotting, headline/body/category collection, image intent and durable staging, Story concurrency, completeness evaluation, and insertion of those stages into the approved Round 4 processor before terminal `InboundEvent.PROCESSED`.

It does not create a WordPress draft, build a preview workflow, approve or publish, send WhatsApp messages, infer content or categories, use AI, call production, or alter webhook acknowledgement semantics. Round 6 owns draft preparation/preview and `COLLECTING_MEDIA -> AWAITING_APPROVAL`; Round 7 owns approval/publication; Round 8 owns abandoned-work recovery and production hardening.

## 2. Existing handoff and persistence inventory

Round 3 authenticates the exact webhook bytes, normalizes each message, and durably inserts a unique `(provider, providerMessageId)` `InboundEvent` as `RECEIVED`. Round 4 conditionally claims it as `PROCESSING`, authorizes and associates an ACTIVE Reporter, lazily provisions one Conversation, audits, and marks it `PROCESSED`. `PROCESSED` means every currently enabled pipeline stage completed. Round 5 therefore extends that same orchestrator before its one terminal update; it must never scan historical Round 4 `PROCESSED` events.

The current schema has the required aggregates and most local invariants:

- Reporter display name and nullable editorial byline.
- Conversation state, unique current Story, and version CAS.
- Inbound event type, retained JSON fragment, provider/receipt timestamps, processing lifecycle, and Reporter association.
- Story status, nullable headline/body/byline, version, and WordPress reconciliation key.
- WordPress-ID category authority and many-to-many StoryCategory uniqueness.
- globally unique provider media ID, per-Story unique position, media lifecycle, MIME, byte count, SHA-256, captions, alt text, and nullable WordPress media ID.
- AuditLog Reporter/Story/InboundEvent provenance.

The inventory is insufficient for strict per-sender sequencing; section 10 defines the supervisor gate.

## 3. Stored WhatsApp payload contract

Round 3 retains an authenticated fragment with `object`, optional `entry_id`, `change_field`, `metadata`, `message`, and optional matching `contact`. Round 5 uses only `rawPayload.message`, after recursively verifying that the JSON nodes are non-null objects and that stored `eventType` agrees with `message.type`. It never casts arbitrary JSON directly.

Common validation requires the stored message `id` to equal `InboundEvent.providerMessageId`, `from` to equal `senderPhone` after adding `+`, and `timestamp` to parse to `providerOccurredAt`. A mismatch is a poison-record failure `MALFORMED_STORED_EVENT`; no Story mutation commits.

| Event | Required extraction and validation |
| --- | --- |
| `TEXT` | `message.text.body` must be a string; command/content rules and limits are state-specific. |
| `IMAGE` | `message.image` object; nonempty bounded `id`; allowlisted `mime_type`; optional valid base64 SHA-256; optional bounded string `caption`. |
| `INTERACTIVE` | `message.interactive.type` plus exactly one matching `button_reply` or `list_reply`; reply `id` is authoritative, bounded, and parsed by an exact grammar; title is display-only and never authority. |
| `UNKNOWN` | no domain fields are trusted; terminal non-actionable result `UNSUPPORTED_EVENT_TYPE`. |

For interactive replies, `button_reply.id` or `list_reply.id` is authoritative; the title is ignored for decisions. Unexpected siblings, missing fields, type disagreement, overlength strings, or invalid encodings fail closed. Parser errors contain fixed codes, never content.

## 4. V1 conversational protocol

Control commands are exact, state-scoped ASCII tokens beginning with `/`; no natural-language intent recognition is permitted. A token is a command only when the entire trimmed TEXT matches its grammar in a state where that command is legal. Otherwise the state-specific rules below apply. Interactive equivalents reserve the prefix `newsroom:v1:` and use reply IDs, never titles.

| Conversation state | Accepted event | Meaning |
| --- | --- | --- |
| `IDLE` | exact TEXT `/story` or interactive ID `newsroom:v1:story:start` | atomically create/attach a Story and enter `AWAITING_HEADLINE` |
| `AWAITING_HEADLINE` | TEXT other than exact `/cancel` | complete headline in one event |
| `AWAITING_BODY` | TEXT other than exact `/cancel` | complete body in one event |
| `COLLECTING_MEDIA` | IMAGE | associate and stage one image |
| `COLLECTING_MEDIA` | exact TEXT `/categories <slug>[,<slug>...]` | replace the complete category set after fail-closed ACTIVE-slug resolution |
| owned collection states | exact TEXT `/cancel` or interactive ID `newsroom:v1:story:cancel` | mark Story `CANCELLED`, clear attachment, transition to `IDLE` atomically |

Reporters use current category slugs rather than WordPress numeric IDs. For each comma-separated token: trim surrounding whitespace, normalize to Unicode NFC, apply locale-independent ASCII lowercase, require the grammar `[a-z0-9]+(?:-[a-z0-9]+)*` and at most 200 characters, then query ACTIVE `EditorialCategory` rows for the exact resulting slug. Every token must resolve to exactly one row; zero or multiple matches reject the whole command. Resolved local category identities are deduplicated and sorted by UUID for persistence. `wordpressCategoryId` remains the authoritative external taxonomy identity; slug is only a mutable, current human-facing lookup token and is not historical identity. Names and Story content are never inference inputs.

Future interactive UI reserves `newsroom:v1:categories:set:<wp-id>[,<wp-id>...]`, where canonical positive decimal WordPress IDs carry authoritative identity internally. This reserves an identifier contract only and does not add outbound messaging in Round 5.

Headline/body replacement after their state has advanced is not supported in V1. Body messages are not concatenated. Category selection is complete-set replacement, not additive. Duplicate selection of the already-current canonical set is a valid no-op with no version increment or mutation audit. Cancellation belongs to Round 5 only while collecting; it prevents indefinitely attached abandoned Stories.

`/done` and `newsroom:v1:story:done` are reserved for a future Round 6 contract. Round 5 neither evaluates completeness because of that input nor terminally consumes it as successful intent. During Round 5-only behavior it is `IGNORED / CONTROL_NOT_ENABLED`. Round 5 exposes only a pure/read-only completeness validator for later composition; Round 6 owns the first user intent that may advance a complete Story toward draft preparation.

IMAGE in any other state, unsupported interactive replies, and category commands in the wrong state are non-actionable. Ordinary headline/body text is content even if it resembles a command other than the single exact `/cancel` token; this is the deliberate V1 UX choice requiring supervisor approval.

## 5. Atomic Story creation and byline snapshot

With the InboundEvent, Reporter, and Conversation already locked by the extended processor, Story start is one PostgreSQL transaction:

1. require ACTIVE Reporter, owned `IDLE` Conversation, expected Conversation version, and a valid start command;
2. create exactly one Story with `reporterId`, `status = COLLECTING`, `byline = Reporter.editorialByline ?? Reporter.displayName`, `version = 0`, null headline/body, and the existing generated `wordpressDraftKey`;
3. call the approved `transitionInTransaction(tx, IDLE -> AWAITING_HEADLINE, ATTACH(storyId), inboundEventId)`;
4. write `STORY_CREATED` audit; and
5. complete the event.

Any failure rolls back Story, attachment, state/version, audits, and event completion. No unattached Story is committed. The nonblank, trimmed snapshot is immutable during later profile changes and never rendered into `Story.body`.

## 6. Headline and body collection

Headline accepts exactly one TEXT event. Normalize CRLF/CR to LF, trim outer Unicode whitespace, reject any remaining newline, reject empty content, and count Unicode code points—not UTF-16 units—against the database maximum of 500. A successful transaction locks/validates the current Story, CAS-updates `Story.version`, sets headline, calls Conversation `AWAITING_HEADLINE -> AWAITING_BODY` with `PRESERVE`, writes content-free provenance audit, and completes the event. CAS failure rolls everything back.

Body also accepts exactly one TEXT event. Normalize line endings to LF and trim only outer Unicode whitespace; preserve all internal newlines, blank paragraphs, spacing, and text exactly. Reject empty content and impose a V1 application ceiling of 100,000 UTF-8 bytes to bound memory/log/database abuse. The atomic operation CAS-updates Story body/version, calls Conversation `AWAITING_BODY -> COLLECTING_MEDIA` with `PRESERVE`, audits without body text, and completes the event. It does not concatenate subsequent TEXT or embed the byline.

## 7. Story version and transaction concurrency

`Story.version` is the optimistic token for the Story aggregate. Every accepted aggregate mutation increments it exactly once: headline set, body set, changed complete category set, media association/order change, cancellation, and future Round-owned metadata changes. No-op category replacement and completeness reads do not increment it.

Mutations use `UPDATE Story ... WHERE id = expectedStoryId AND reporterId = reporterId AND version = expectedVersion` and require one affected row. Conversation transitions separately require the expected Conversation state/version. Both CAS operations and every dependent join/audit/event-terminal write share one transaction. A zero-row Story or Conversation update is a domain concurrency conflict; no blind retry and no last-write-wins are allowed.

Canonical lock order is: InboundEvent, Reporter, Conversation, Story, EditorialCategory rows in ascending UUID, StoryCategory rows by category UUID, then StoryMedia rows by position/UUID. External storage and HTTP never occur while these locks are held. All services accept the caller's Prisma transaction client so this order cannot be hidden behind nested transactions.

## 8. Category authority and catalog population

Reporter-facing text identifies categories by normalized current slug as defined in section 4. Because the schema does not make slug unique, resolution queries all ACTIVE exact matches and requires exactly one local row for every token. Unknown, inactive, ambiguous, or malformed tokens reject the whole command with no partial set. The resolved `EditorialCategory.id` and its unique `wordpressCategoryId` are authoritative persisted identities; slug and name remain mutable lookup/display metadata. No primary category exists.

Selection replaces the complete set. Compare canonical sorted database category UUIDs; if unchanged, return a no-op. Otherwise Story-version CAS first establishes ownership of the mutation, then delete obsolete and insert missing StoryCategory joins in the same transaction, relying on the composite primary key for duplicate defense. Concurrent replacements yield one winner and stale conflicts, not a union.

Round 5B tests use fixture catalog rows. Production activation requires a separately approved, operator-controlled/bootstrap synchronization that reads authoritative WordPress category IDs plus names/slugs and applies ACTIVE/INACTIVE changes. It is a deployment prerequisite, not a webhook action and not a live Round 5A/5B call. It should be delivered before production activation, alongside controlled integration bootstrap; Round 6 may consume the catalog but must not invent it. The historical ten-category discovery snapshot is never seed truth.

## 9. Story status and completeness

Round 5 owns `COLLECTING -> CANCELLED` only. A new Story remains `COLLECTING` throughout headline, body, category, and optional media collection. The completeness validator is a pure/read-only domain result and does not change status. Round 6 must revalidate and atomically own `COLLECTING -> READY` as part of draft preparation before any draft call.

V1 completeness is true only when:

- Story belongs to the Reporter and is the Conversation's current Story;
- Conversation is `COLLECTING_MEDIA`;
- Story status is `COLLECTING`;
- trimmed headline, body, and byline are nonempty;
- at least one StoryCategory exists and every selected category still exists (historical inactive status does not silently remove an already-selected category; Round 6 policy must revalidate ACTIVE before draft preparation); and
- if any StoryMedia exists, every row is `FETCHED` with approved MIME, positive size within the shared ceiling, and lowercase 64-hex backend SHA-256.

Images are optional. No featured image is inferred when none exists. Any `RECEIVED`, `FETCHING`, or `FAILED` associated image makes completeness false until reconciled, retried, or explicitly cancelled by a later approved media-removal command; V1 defines no media removal.

## 10. Mandatory per-sender ingestion-order decision and schema gate

Stateful interpretation cannot use worker lock-acquisition order. `providerOccurredAt` has only provider timestamp resolution and can tie; `receivedAt` can tie and reflects transaction time rather than an authoritative per-sender sequence; `providerMessageId` is identity, not chronology. Webhooks can arrive concurrently or late, and Round 4's `process(eventId)` can claim a later event first. The current schema therefore cannot prove or enforce a stable per-sender ingestion order.

**Decision: Round 5B requires a schema and ingestion change before any stateful Story implementation.** `senderIngestSequence` means a monotonically allocated per-canonical-sender sequence representing the order in which this newsroom durably accepts authenticated inbound WhatsApp events. Deterministic V1 processing and media position use that local durable-ingestion order.

It is not WhatsApp send order, is not derived from `providerMessageId`, and is not derived from `providerOccurredAt`. Delayed or out-of-order webhook delivery cannot be reconstructed into true send order because the retained provider contract exposes no monotonic sender sequence. No architecture claim may be stronger than durable authenticated ingestion order. If true sender order is required, the feature remains blocked pending a different provider/product protocol.

Proposed additions:

```prisma
model InboundSenderSequence {
  senderPhone String   @id @db.VarChar(16)
  nextValue   BigInt   @default(0) @db.BigInt
  updatedAt   DateTime @updatedAt @db.Timestamptz(3)
}

model InboundEvent {
  // existing fields
  senderIngestSequence BigInt @db.BigInt

  @@unique([senderPhone, senderIngestSequence])
  @@index([senderPhone, processingStatus, senderIngestSequence])
}
```

`nextValue` is the next sequence to allocate; the first allocation is zero. Inside one PostgreSQL ingestion transaction, group normalized candidates by canonical `senderPhone`, sort the distinct sender keys lexically to establish cursor-lock order, then for each sender:

1. `INSERT` its cursor with `nextValue = 0 ON CONFLICT DO NOTHING`;
2. `SELECT` that cursor row `FOR UPDATE`;
3. for `N` candidates, reserve `[nextValue, nextValue + N - 1]`;
4. assign those consecutive values in the normalizer's retained traversal order; and
5. update the cursor to `nextValue + N` before inserting the events.

Cursor advancement and all `InboundEvent` inserts commit or roll back together. Same-sender webhook transactions serialize on one cursor row and cannot overlap ranges; different senders do not share a cursor or globally serialize. A multi-sender batch uses a separate range for each sender. `createMany({ skipDuplicates: true })` may discard provider-message replays after range reservation. Consumed gaps are acceptable and have no semantic meaning: sequences are monotonic and unique, not gapless. The existing `(provider, providerMessageId)` key remains replay authority.

The authoritative claim is one parameterized PostgreSQL `UPDATE ... RETURNING`, not a select followed by an unrelated update:

```sql
UPDATE "InboundEvent" AS candidate
SET "processingStatus" = 'PROCESSING',
    "processingStartedAt" = :now,
    "processingAttempts" = "processingAttempts" + 1,
    "processedAt" = NULL,
    "lastErrorCode" = NULL,
    "lastErrorMessage" = NULL,
    "updatedAt" = :now
WHERE candidate.id = :event_id
  AND candidate."processingStatus" = 'RECEIVED'
  AND NOT EXISTS (
    SELECT 1
    FROM "InboundEvent" AS earlier
    WHERE earlier."senderPhone" = candidate."senderPhone"
      AND earlier."senderIngestSequence" < candidate."senderIngestSequence"
      AND earlier."processingStatus" IN ('RECEIVED', 'PROCESSING')
  )
RETURNING candidate.id;
```

Exactly one returned row owns the event; zero is a no-op. Earlier `PROCESSED`, `IGNORED`, or `FAILED` rows do not block. An earlier `PROCESSING` row always blocks, including when abandoned, until Round 8 recovery. For committed N and N+1, the N row is visible as `RECEIVED` or `PROCESSING` to the N+1 statement until N becomes terminal, so they cannot both be owners concurrently. If N commits a terminal result before the N+1 claim statement's snapshot, N+1 may then legitimately win as the next event. The unique sender-ingest index supports the anti-join; 20-way proofs must race adjacent and identical candidates using independent connections.

Production is NO-GO and operational databases are not active, so adoption is one controlled offline migration after the repaired baseline, not a pretend-online dual-writer rollout:

1. create `InboundSenderSequence`;
2. add nullable `senderIngestSequence`;
3. backfill each sender using `row_number() over (partition by "senderPhone" order by "receivedAt", id) - 1`;
4. initialize every cursor `nextValue` to one greater than that sender's maximum, or zero when none exists;
5. verify no duplicate `(senderPhone, senderIngestSequence)` pair;
6. verify zero null sequences;
7. set the column `NOT NULL`;
8. add the unique and ordered-claim indexes, ordering DDL steps as needed to validate safely inside the offline migration; and
9. deploy the compatible Round 3 ingestion writer and Round 5 ordered claimant together before operational activation.

One migration is sufficient because adoption is offline and no old writer may run concurrently. It must be proven against empty PostgreSQL, a populated pre-Round-5 database, and Round 4 fixtures/history; preserve every existing row and provider-event key; run a second `migrate deploy` as a no-op; require `migrate status` current and zero Prisma drift. Historical backfill constructs deterministic database history only and does not manufacture WhatsApp send order. Existing terminal events remain evidence and are never replayed. `AuditLog` cannot replace the field because it is written after claim and cannot participate in claim authority.

This migration changes the approved Round 3 ingestion source and is required before Story/text/category or media collection, not merely before staging. Round 5A does not implement it.

## 11. Image extraction, association, and deterministic position

An IMAGE is accepted only in `COLLECTING_MEDIA` for the current owned Story. `providerMediaId` is an opaque 1–191-character provider identifier accepted only from a conservative ASCII identifier grammar and is never used in a path. MIME must be exactly `image/png`, `image/jpeg`, `image/webp`, or `image/gif`. Optional provider SHA must decode from canonical base64 to exactly 32 bytes. Caption is normalized for line endings and bounded to 4,096 Unicode code points; it may be stored as caption but never copied to alt text because those meanings differ. `altText` remains null absent explicit future reporter input.

`position` is zero-based accepted image order for the Story, derived from the enforced `InboundEvent.senderIngestSequence` order. It represents newsroom durable-ingestion order, not claimed WhatsApp send order. While holding the Story lock and winning Story-version CAS, insert at `max(position)+1`; `(storyId, position)` is the final database guard. Strict per-sender claiming prevents concurrent later image events from overtaking. `providerMediaId` uniqueness makes provider replay a no-op/conflict check rather than another row. A provider ID already attached to another Story is a security/domain conflict, never reassigned.

## 12. Durable media staging, SHA, size, and MIME

`StoryMedia.sha256` means lowercase hexadecimal SHA-256 of the exact durable downloaded bytes, computed by this backend. A provider base64 digest is verification input only: compare its decoded bytes in constant time with the computed digest; never store ambiguous base64 in `sha256`.

The staging allowlist exactly matches the approved WordPress media boundary: PNG, JPEG, WebP, and GIF. Reject zero bytes, streams exceeding the configured ceiling, MIME disagreement, bad magic bytes, truncated/corrupt structure, decompression/dimension bombs under a bounded image-header decoder, and hash mismatch. Round 5's staging maximum is bounded deployment configuration and must not exceed the configured WordPress media-authority acceptance ceiling; both values must be aligned and verified before activation. The bridge currently defaults to 500,000 bytes, which is likely restrictive for ordinary phone images, but it is not frozen as a permanent newsroom product limit. Raising either value requires an explicit coordinated pre-production decision and revalidation; no WordPress source change is authorized here. Round 5B oversize tests may use a deliberately small test ceiling.

StoryMedia is durable intent. The production storage contract is a durable object store with atomic/conditional put, read/head, checksum metadata, bounded streaming, durability guarantees, and deterministic keys. The key is derived only from the server UUID: `story-media/v1/{StoryMedia.id}/source`. It contains no provider ID, filename, phone, or user input. Because that identity is deterministic, no object-key schema field is needed. A local filesystem adapter is test-only.

## 13. External media side effects and recovery

Media processing is split deliberately:

1. short transaction validates event/order/state/ownership, wins Story-version CAS, inserts StoryMedia `RECEIVED` at its position, audits association, and leaves the InboundEvent `PROCESSING`;
2. conditional `RECEIVED -> FETCHING` claim;
3. outside all database transactions, a provider adapter requests metadata from a fixed configured Graph endpoint, downloads with bounded streaming, validates redirects/host/IP on every hop, validates MIME/magic/size/hash, and conditionally writes the deterministic object;
4. short completion transaction locks StoryMedia and event, verifies object head/checksum/size, changes media to `FETCHED`, stores canonical MIME/size/SHA, audits staging, and marks the event `PROCESSED`.

Temporary provider URLs, tokens, bytes, and response bodies are never persisted or audited. Authorization headers are sent only to explicitly permitted hosts. HTTPS is mandatory; private, loopback, link-local, metadata-service, userinfo, nonstandard-port, DNS-rebinding, and unvalidated redirects are rejected. Timeouts, redirect count, response headers, and streamed bytes are bounded.

Crash semantics:

- after intent before fetch: durable `RECEIVED`, event `PROCESSING`; safe explicit retry;
- after metadata/download: no durable claim of success; retry;
- after object write before DB completion: deterministic HEAD/checksum reconciliation completes without duplicate bytes;
- after DB completion failure: object remains reconcilable by deterministic key;
- during `FETCHING`: remains visible for diagnosis; automated stale reclaim is Round 8;
- provider/object failure: short transaction changes media to `FAILED`, records a fixed content-free audit code, and leaves the event non-successful; an explicit bounded retry may conditionally return `FAILED -> FETCHING`, while autonomous abandoned recovery is Round 8.

External storage and PostgreSQL are never described as one transaction. Round 5B uses a fake Meta server and production-contract in-memory/local object adapter; no live Meta call.

## 14. Processor evolution and terminal semantics

The Round 4 processor remains the sole orchestration entry. Extract its active-Reporter path into a transaction-aware pipeline stage interface or inject one `StoryEventProcessor`; do not duplicate claim/authorization logic. For active Reporters:

```text
ordered conditional claim
-> lock/re-read event
-> authorize and associate Reporter
-> get/lock Conversation
-> parse stored event
-> apply Story operation and CAS/audit
-> finish any required external media stage
-> terminal PROCESSED in the relevant completion transaction
```

Unknown/inactive behavior remains exactly Round 4. The webhook is unchanged and never waits for downstream work or launches a background promise. Historical `PROCESSED` events are not rescanned.

Text/category/start/cancel events complete domain mutation and event atomically in one database transaction. Image events intentionally span durable intent, an external step, and a reconciliation transaction; the event remains `PROCESSING` until all currently enabled staging work succeeds.

## 15. State mismatch, ignored, failure, and conflict semantics

| Condition | Result/code | Meaning |
| --- | --- | --- |
| IMAGE outside `COLLECTING_MEDIA` | `IGNORED / IMAGE_NOT_ACCEPTED_IN_STATE` | ordinary non-actionable input |
| UNKNOWN | `IGNORED / UNSUPPORTED_EVENT_TYPE` | unsupported provider content |
| unsupported interactive reply | `IGNORED / UNSUPPORTED_INTERACTION` | no V1 action |
| category command outside `COLLECTING_MEDIA` | `IGNORED / CATEGORY_NOT_ACCEPTED_IN_STATE` | user/state mismatch |
| other TEXT in `COLLECTING_MEDIA` | `IGNORED / TEXT_NOT_ACCEPTED_IN_STATE` | not headline/body |
| reserved `/done` or `newsroom:v1:story:done` in Round 5-only processing | `IGNORED / CONTROL_NOT_ENABLED` | Round 6 owns any future advancement intent |
| identical category set | valid no-op; `PROCESSED` | intent already satisfied, no mutation audit/version increment |
| malformed retained JSON/type mismatch | `FAILED / MALFORMED_STORED_EVENT` | deterministic poison evidence |
| invalid/unknown/inactive category | `IGNORED / CATEGORY_SELECTION_INVALID` | ordinary rejected selection, no partial update |
| invalid headline/body | `IGNORED / CONTENT_VALIDATION_FAILED` | fixed code; no content in error fields |
| stale Story/Conversation CAS | domain conflict `STALE_STORY` or `STALE_CONVERSATION` | rollback; caller does not reinterpret stale content |
| provider/object/transient DB failure | retriable operational failure | never mislabeled ignored/processed |

`lastErrorMessage` remains null for user mistakes. Fixed error codes contain no content. Domain conflicts leave the claimed event `PROCESSING` for controlled recovery unless a fresh-state transaction can prove the original intent is already satisfied; Round 8 owns generic abandonment recovery.

## 16. Audit and replay strategy

Required successful mutation events are service-owned constants:

- `STORY_CREATED`
- `STORY_HEADLINE_SET`
- `STORY_BODY_SET`
- `STORY_CATEGORIES_SET`
- `STORY_CANCELLED`
- `STORY_MEDIA_ASSOCIATED`
- `STORY_MEDIA_STAGED`

Every reporter-driven audit has Reporter, Story, and InboundEvent IDs; entity type/ID identifies the mutated aggregate. Metadata may contain version before/after, category database IDs/count, media position, MIME, byte size, and backend SHA where operationally necessary. It never contains headline, body, caption, raw payload, binary, phone, provider URL, provider ID unless required as entity identity, token, or secret. Completeness checks are not audited because they are read-only and would add noise.

Replay safety composes existing event uniqueness/claiming with CAS and constraints. Story start and attach are one transaction. Headline/body cannot replay after state advances. Category replacement is canonical and identical replay is a no-op. StoryCategory primary key prevents duplicates. Provider media ID and `(storyId, position)` prevent duplicate media. The object key derived from StoryMedia ID makes conditional object writes idempotent; retry reconciles existing size/SHA before reuse and fails closed on mismatch. Mutation audits occur only with the winning mutation.

## 17. Security controls and findings

| Risk | Frozen control | Classification |
| --- | --- | --- |
| cross-Reporter Story/category/media mutation or Story hijack | Reporter/Conversation/Story predicates, locks, both CAS tokens, approved ATTACH ownership check | LOW |
| stale overwrite | Story and Conversation version CAS in one transaction | LOW |
| event/media reordering | database-serialized `senderIngestSequence` plus atomic ordered claim; absent today | blocking MEDIUM |
| command/content confusion | frozen exact state-scoped slash grammar, slug rules, and interactive ID namespace | LOW |
| category spoofing/inactive assignment | authoritative numeric WP ID resolved to ACTIVE local row; complete-set transaction | LOW |
| provider ID/path traversal | strict bounded opaque ID; storage key uses only server UUID | LOW |
| MIME/hash spoofing, oversized/zero/bomb media | streamed ceiling, magic/decode bounds, backend SHA, provider-hash verification | LOW |
| SSRF/redirect/token leakage | fixed Graph endpoint, validated CDN policy and every redirect/IP, scoped auth, no URL persistence | LOW |
| external call in transaction | durable-intent/reconciliation split | LOW |
| audit content leakage | constant event/code and metadata allowlists | LOW |
| abandoned PROCESSING/FETCHING | durable evidence; automated reclaim deferred to Round 8 | non-blocking MEDIUM |
| media byte ceiling | staging/WordPress deployment values must align; current 500,000-byte bridge default requires a pre-production product decision | non-blocking MEDIUM |

There are no CRITICAL or HIGH findings. The missing database-serialized per-sender ingestion order is a blocking MEDIUM and schema/source gate; it is not described as missing proof of WhatsApp send order.

## 18. Schema sufficiency verdict

**Decision B: Round 5B requires a schema change.**

The exact missing data is a durable, unique, database-serialized, monotonically allocated `senderIngestSequence` per canonical sender, usable before claiming. Current timestamps and provider ID cannot supply this local ingestion-order invariant; AuditLog is written too late and cannot order claim ownership. The proposed cursor model, InboundEvent field, unique constraint, processing index, offline backfill, allocation transaction, and atomic claim are specified in section 10.

Migration risk is moderate: table rewrite/backfill and unique-index construction should be measured. Controlled offline adoption permits one subsequent migration after the repaired baseline, followed by deployment of the compatible ingestion writer and ordered claimant before activation. Existing rows and provider-event identities are preserved; terminal history is not replayed.

This migration is required before any Round 5 stateful implementation, because headline/body meaning also depends on order. It is not merely a media-staging prerequisite. Round 5A makes no schema/source change.

## 19. Exact implementation plan after supervisor approval

Use two implementation sub-rounds because external media creates a materially different failure boundary, not for convenience:

### Round 5B.0 — ordering prerequisite

- add the approved schema migration and generated client change;
- update Round 3 ingestion narrowly to allocate `senderIngestSequence` ranges transactionally without changing authentication, normalization, durability, deduplication, or acknowledgement semantics;
- replace event-ID-only claim authority with ordered per-sender claiming while retaining the Round 4 conditional claim and unknown/inactive semantics;
- prove concurrent ingestion, duplicate gaps, ordered claim, delayed processing, and migration/backfill.

Round 5B.1 cannot begin until 5B.0 is supervisor-approved and its migration, allocation, and ordered-claim behavior have passed disposable PostgreSQL proof.

### Round 5B.1 — Story, text, category collection

Add `apps/api/src/modules/story-collection/` with:

- strict stored WhatsApp event parser and V1 command parser;
- Story creation/byline service;
- headline/body mutation service;
- category resolver/replacement service;
- Story CAS helper accepting a transaction client;
- completeness validator;
- Story event interpreter/orchestrator;
- audit constants and fixed domain results/errors.

Modify `reporter-workflow/inbound-event-processing.service.ts` to invoke the injected Story stage before terminal processing, and its module/types/tests only as needed. Reuse `ConversationStateMachineService.transitionInTransaction`; never duplicate its graph/CAS.

### Round 5B.2 — media intent and durable staging

Add:

- image extractor/validator;
- StoryMedia association/position service;
- provider-media client interface plus fake proof adapter and production Meta adapter with strict SSRF/redirect policy;
- durable object-store interface plus contract-test adapter;
- streaming MIME/hash/size validator;
- staging/reconciliation service and focused failure types.

Extend the same processor stage for image intent and completion. Add shared media-limit configuration aligned with the WordPress client/bridge; do not change WordPress source in this round. Production activation remains blocked until durable-store configuration and category population are approved.

Round 5B.2 depends on the 5B.1 owned Story/processor contracts but uses only fake provider and storage implementations during proof; it requires no live Meta or WordPress access.

## 20. Round 5B acceptance and runtime matrix

All database/concurrency proofs use disposable PostgreSQL and independent clients; external proof uses fake Meta and object-store contract adapters.

| Area | Required proof |
| --- | --- |
| ordering migration | empty deploy, existing-row backfill, cursor initialization, uniqueness, no nulls, rollback safety |
| ingestion order | first value zero; exact range/cursor arithmetic; same-sender concurrency cannot overlap; array order retained; different senders use independent cursors; rollback restores cursor/inserts; duplicate gaps are harmless |
| ordered claim | atomic anti-join update; N+1 cannot overtake N while N is RECEIVED/PROCESSING; terminal predecessors do not block; different senders proceed independently; 20-way adjacent/identical races preserve ingestion order |
| Story start | authorised only; 20 contenders create/attach exactly one Story; one audit; rollback removes Story and attachment |
| byline | exact editorialByline fallback; later Reporter change leaves snapshot unchanged; nonblank invariant |
| headline | trim/line-ending/single-line/empty/500-code-point cases; Story write plus Conversation CAS rollback together |
| body | line-ending/outer trim/paragraph preservation/empty/UTF-8 ceiling; no concatenation; write plus CAS rollback |
| Story CAS | every changed aggregate mutation increments once; stale/wrong owner rejected; 20-way races one winner |
| categories | reporter slug normalization and exact-one ACTIVE match; ambiguous/inactive/unknown/malformed rejection; mapping to authoritative IDs; multiple/set replacement; no primary; duplicate no-op; 20-way replacement race |
| cancellation | owned states only; Story CANCELLED plus Conversation CLEAR atomic; no Approval |
| completeness | every true/false predicate, no-image true case, optional-image cases, all-media-FETCHED rule, read-only/no status change |
| image parsing | state/type/provider ID/MIME/base64 hash/caption bounds; alt null; malformed fixed failure |
| image concurrency | strict event order yields positions 0..n-1; 20 images, no collision/overtake; cross-Reporter rejection |
| provider replay | same provider ID creates no duplicate row/position/audit/object |
| staging | success, canonical backend SHA, provider hash match/mismatch, MIME disagreement, magic/corruption/bomb, zero/oversize/truncated stream |
| provider failures | fixed endpoint, SSRF/private IP/redirect rejection, timeout, bounded response, token non-leakage |
| object failures | conditional put, existing matching object replay, conflicting object failure, write/DB crash reconciliation |
| lifecycle | RECEIVED/FETCHING/FETCHED/FAILED transitions, event remains PROCESSING until staged, no false success |
| processor | active path includes Story stage before PROCESSED; unknown/inactive unchanged; terminal/historical events not rescanned |
| rollback | Story create/attach, body/CAS, category set, media intent/position/audit, and terminal event updates roll back atomically |
| negative scope | no draft, WordPress call, Approval, publication, OutboundMessage, AI, live Meta, live WordPress, Supabase, or content/secret logging |

## 21. Deferred responsibilities and activation gates

Round 6 owns READY transition, draft creation/sync, preview/review, and selection of featured media (or null). Round 7 owns approval/publication. Round 8 owns automated stale event/media reclaim, bounded retry policy, alerting, garbage collection, and load hardening.

Before production activation, supervisors must approve: the per-sender authenticated-ingestion-order semantic and migration; category-catalog bootstrap/sync ownership; a production durable object-store adapter/configuration; and aligned media ceilings. The command/content and reporter-facing slug UX are now frozen by this remediation. No live integration is authorized by this freeze.
