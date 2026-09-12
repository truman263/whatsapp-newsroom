# Round 6A — Draft Preparation, Preview, and Approval Boundary

Status: corrected architecture ready for supervisor freeze. Round 6A changes this
document only; it does not implement application, Prisma, migration, or WordPress
changes.

Baseline: `feat/round-6-draft-approval` at
`826e967c88c469ccdaa21c1c2198454659a57bc2`. Round 6 prepares and presents one
reconciled WordPress DRAFT. Round 7 alone approves and publishes.

## 1. Audited current contracts

This design was re-audited against `prisma/schema.prisma`, story completeness and
event processing, the conversation state machine and ordered inbound processing,
all media-staging/WordPress-draft/WordPress-media sources, and the Round 4, Round 5,
WordPress reconciliation, draft-sync, media-authority, and trust-boundary design
and implementation documents.

Current facts are:

- `/done` and `newsroom:v1:story:done` currently return
  `CONTROL_NOT_ENABLED`; `/revise`, safe preview, and outbound Meta dispatch do not
  exist.
- Round 5 completeness requires an owned current `COLLECTING` Story in a
  `COLLECTING_MEDIA` Conversation, nonblank headline/body/byline, at least one
  category, and every optional medium `FETCHED` with approved MIME, positive size,
  and lowercase SHA-256. It does not recheck category activity.
- Accepted media positions are zero-based; the first image is position `0`.
- Durable bytes use `story-media/v1/{StoryMedia.id}/source`; the checked-in store
  is deliberately unconfigured/fail-closed.
- Draft/media clients use separate HMAC namespaces and manual redirects, but their
  ordinary `fetch` transports accept `http:` or `https:` and are not DNS-pinned.
- Create is reconciled by permanent `Story.wordpressDraftKey`; expected-version
  full-state sync exists but omits `Story.byline`.
- Generic abandoned `InboundEvent.PROCESSING` reclamation remains Round 8.

Protected CREATE reconciliation files remain frozen. Their committed
LF-normalized SHA-256 values are:

| File | SHA-256 |
|---|---|
| `class-newsroom-bridge-db.php` | `1362CB101031088B78E27D54B78EDFAC6488D9F979979A3786916839811A20FA` |
| `class-newsroom-bridge-reconciliation.php` | `6A7CE8AEC4AB3040804C217F00341275EAD25EA78570FC4CC93F47CDE03A373A` |
| `class-newsroom-bridge-rest.php` | `965608C6063540985D23F9A83A679C49EEE1543238C595A850100755F9CF609A` |

Byline support can be implemented entirely in the non-frozen
`class-newsroom-bridge-draft-sync-rest.php`, normal bootstrap/version wiring, and
Node DTO/client code. That controller already owns full-state validation,
read/apply/compare/fingerprint/response logic and can exclusively own private meta
`_newsroom_editorial_byline`. The frozen CREATE route and protected trio remain
unchanged. There is no protected-file blocker.

## 2. Scope, controls, and cutover

Round 6 owns exact `/done` finalisation, completeness/category revalidation, the
Story finalisation epoch, durable preparation, media reconciliation, WordPress
DRAFT create/reconciliation and full-state sync, editorial byline, safe Reporter
preview, durable/sendable approval prompt, `AWAITING_APPROVAL`, and exact `/revise`
back to collection on the same Story/post.

It must never publish, set WordPress status other than `draft`, enter
`Conversation.PUBLISHING`, create `Approval`, treat `/approve` as permission, use
NLP/fuzzy intent, or use a generic WordPress Application Password. `APPROVED`,
`PUBLISHING`, `PUBLISHED`, and `PUBLISH` execution belong to Round 7;
`CANCELLED` retains its Round 5 meaning.

| Action | TEXT authority | INTERACTIVE authority |
|---|---|---|
| finalise | exact trimmed `/done` | exact ID `newsroom:v1:story:done` |
| revise | exact trimmed `/revise` | exact ID `newsroom:v1:story:revise` |
| approve (Round 7 reserved) | exact trimmed `/approve` | `newsroom:v1:story:approve` / bound form in §14 |

Display titles, casing variants, prefixes/suffixes, and fuzzy matches have no
authority. Until Round 7 is active, approval controls return
`CONTROL_NOT_ENABLED` only.

Retain the deployment watermark `ROUND6_CONTROL_CUTOVER_AT`: when controls are enabled it is a required,
strict RFC3339/ISO-8601 UTC instant, immutable for that deployment activation.
Eligibility is exactly `InboundEvent.receivedAt >= cutover`; equality is eligible
and `providerOccurredAt` is never used. Missing/invalid configuration fails startup
closed. Historical `PROCESSED` events are never scanned. Test before/equal/after.

## 3. `/done`, category activity, locking, and concurrency

Inside one finalisation transaction, `/done` is actionable only when the event is
the ordered currently owned event and cutover-eligible; Reporter is `ACTIVE`;
Conversation belongs to Reporter, points to Story, and is `COLLECTING_MEDIA`;
Story belongs to Reporter and is `COLLECTING`; Round 5 completeness passes; every
selected category is `ACTIVE`; and no active preparation exists for a later/equal
epoch. No external call precedes commit.

Category identity is persisted `StoryCategory.categoryId` joined to
`EditorialCategory.wordpressCategoryId`; never resolve slugs during preparation.
An inactive selection returns `CATEGORY_SELECTION_NO_LONGER_ACTIVE`, leaving Story
`COLLECTING`, Conversation `COLLECTING_MEDIA`, version and selection unchanged,
with no preparation/object-store/WordPress/outbound call. Never filter or
substitute. The Reporter must explicitly choose a currently valid set. Incomplete
input returns `COMPLETENESS_NOT_SATISFIED`; a CAS/authority conflict returns
`STORY_FINALISATION_CONFLICT`.

Canonical lock order is:

`InboundEvent → Reporter → Conversation → Story → EditorialCategory UUID ASC → StoryCategory category UUID → StoryMedia(position ASC, UUID ASC)`.

Insert `DraftPreparation` after those locks establish the epoch. Recovery extends
the order with existing `DraftPreparation` after Story and before its attempts and
prompt. No object-store, DNS, WordPress, or WhatsApp call occurs in a PostgreSQL
transaction.

Same-sender ordering plus Story CAS and unique preparation epoch mean that among
two or twenty `/done` events only the first can change `COLLECTING → READY`, bump
version, and insert authority. Later/replayed events cause no second version bump,
remote work, or prompt. Cross-Reporter ownership fails closed.

## 4. Story.version and status meanings

The first successful `/done` changes Story `COLLECTING → READY` and increments
`Story.version` exactly once. That resulting value is the immutable preparation,
preview, and approval-binding epoch. `READY → DRAFT_CREATING → DRAFT_CREATED →
AWAITING_APPROVAL`, media upload, draft create/sync, outbound sending, and duplicate
`/done` do not increment it.

- `COLLECTING`: approved Round 5 controls may mutate.
- `READY`: finalisation was transactionally validated, the epoch was created, and
  durable preparation exists; WordPress readiness is not claimed.
- `DRAFT_CREATING`: remote preparation/reconciliation is active.
- `DRAFT_CREATED`: one WordPress draft identity is known locally; approval is not
  yet allowed.
- `AWAITING_APPROVAL`: full state is verified for the epoch and durable prompt
  intent exists.
- `FAILED`: local invariant corruption makes automation unsafe. Authentication,
  configuration/capability problems, network/5xx/timeouts, and uncertain outcomes
  do not default to FAILED.

Conversation stays `COLLECTING_MEDIA` while Story is READY, DRAFT_CREATING, or
DRAFT_CREATED. Collection mutations must require both the expected Conversation
state and `Story.status == COLLECTING`; Story status is the freeze barrier. The
final local CAS alone moves Conversation to AWAITING_APPROVAL, without remote I/O.

## 5. Concrete proposed Prisma delta (not implemented)

The previous “no schema change” conclusion is rejected. Minimal proposal:

```prisma
enum DraftPreparationStatus {
  ACTIVE
  RECONCILIATION_REQUIRED
  BLOCKED
  READY_FOR_APPROVAL
  SUPERSEDED
  FAILED
}

enum PublishOperation {
  CREATE_DRAFT
  SYNC_DRAFT
  PUBLISH
}

model DraftPreparation {
  id                              String                 @id @default(uuid()) @db.Uuid
  storyId                         String                 @db.Uuid
  inboundEventId                  String                 @unique @db.Uuid
  storyVersion                    Int
  status                          DraftPreparationStatus @default(ACTIVE)
  wordpressPostId                 BigInt?                @db.BigInt
  wordpressAppliedVersion         String?                @db.Char(64)
  approvalPromptCorrelationKey    String                 @unique @db.VarChar(191)
  approvalPromptOutboundMessageId String?                @unique @db.Uuid
  previewExpiresAt                DateTime               @db.Timestamptz(3)
  lastErrorCode                   String?                @db.VarChar(100)
  startedAt                       DateTime               @default(now()) @db.Timestamptz(3)
  readyAt                         DateTime?              @db.Timestamptz(3)
  supersededAt                    DateTime?              @db.Timestamptz(3)
  failedAt                        DateTime?              @db.Timestamptz(3)
  createdAt                       DateTime               @default(now()) @db.Timestamptz(3)
  updatedAt                       DateTime               @updatedAt @db.Timestamptz(3)
  story                           Story                  @relation(fields: [storyId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  inboundEvent                    InboundEvent           @relation(fields: [inboundEventId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  approvalPromptOutboundMessage   OutboundMessage?       @relation("DraftPreparationApprovalPrompt", fields: [approvalPromptOutboundMessageId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  approval                        Approval?

  @@unique([storyId, storyVersion])
  @@index([status, updatedAt])
  @@index([storyId, status])
}
```

Add inverse `Story.draftPreparations`, `InboundEvent.draftPreparation`, and named
`OutboundMessage.draftPreparationApprovalPrompt` relations. The optional unique FK
is preferred: it proves the actual prompt rather than parsing a correlation string;
the unique correlation key remains send/idempotency authority. Reporter identity
is recovered through Story and must equal the initiating event Reporter.

Freeze future Round 7 binding in the same controlled migration:

```prisma
model Approval {
  // all current fields/relations remain
  draftPreparationId      String @unique @db.Uuid
  storyVersion            Int
  wordpressAppliedVersion String @db.Char(64)
  draftPreparation        DraftPreparation @relation(fields: [draftPreparationId], references: [id], onDelete: Restrict, onUpdate: Cascade)

  @@index([storyVersion])
  @@index([wordpressAppliedVersion])
}
```

Round 6 never writes Approval. Adopt with an offline controlled Prisma migration,
never `db push`. Existing Stories/events/messages/attempts need no preparation
backfill; new `/done` epochs create rows. If pre-production Approval rows exist,
fail deployment closed for supervised backfill rather than inventing authority.
Prove fresh PostgreSQL, existing-row upgrade, staged nullability/constraints,
repeat deployment, generated-client consistency, and drift detection.

## 6. Preparation identity and PublishAttempt

One epoch is `(storyId, storyVersion)`, with one preparation and one permanently
bound initiating `/done` event. Revision creates a later row only after version
changes and supersedes the old row.

`CREATE_DRAFT` is only initial POST/reconciliation; `SYNC_DRAFT` is full-state
PUT/reconciliation initially and after revision; `PUBLISH` is Round 7. Attempt
numbers remain monotonic per `(storyId, operation)`. Durable logical keys are
`draft-create:{draftPreparationId}` and
`draft-sync:{draftPreparationId}:{storyVersion}`. Stored storyVersion—not string
parsing—is authoritative. Transport retry/reconciliation reuses the same logical
attempt row and idempotency key. Physical retry telemetry may be a counter/child
record; it must not invent another logical operation.

## 7. WordPress media, featured image, and draft identity

For each Story-owned medium ordered `position ASC, id ASC`, require `FETCHED`,
approved MIME, exact positive size, and lowercase SHA-256. Derive deterministic
WordPress media key from `StoryMedia.id`, read
`story-media/v1/{id}/source`, and independently verify byte length/SHA-256 against
the row. Never fetch from Meta or reuse a Meta URL.

Outside transactions, call the media HMAC authority. On uncertainty GET the exact
media key before any POST retry. Persist `wordpressMediaId`, then mark `UPLOADED`,
in a short transaction. A crash between remote success and local persistence
therefore cannot duplicate an attachment. Zero images skip object storage; a
media-bearing production Story fails closed if the durable store is unconfigured.

Featured image is exactly null for zero media; otherwise choose `MIN(position)`
(UUID only as defensive tie-break). With contiguous zero-based ordering, position 0
is the first image; position 1 is the second image and must never be described as
the first. Send the selected deterministic media key, never a
Reporter-supplied bare attachment ID. All attachments reconcile; no reordering.

`Story.wordpressDraftKey` is permanent: one Story, one WordPress post forever. If
post ID is null, use existing create/reconciliation; a lost create response is
reconciled by draft key before retry. Persist only authoritative post ID. Revision
reuses the same key/post and never deletes. Every response/state read must prove
`status == draft`; anything else fails closed. No generic core credential exists.

## 8. Editorial byline, full state, and fingerprints

Canonical desired state is exactly `title`, `content`, `excerpt`, `categories`,
`editorial_byline`, `featured_media_key`. `editorial_byline` is the Story snapshot,
not current `Reporter.editorialByline`: valid Unicode, trimmed nonblank, maximum
200 characters. Store/read it exactly in newsroom-owned private post meta. PUT
accepts all six fields and rejects unknown keys; GET returns all six;
postconditions include all six. Technical WordPress author remains and is verified
as the service user. Never append byline to body or change technical author.

CREATE remains unchanged (`title/content/excerpt/categories`). A newly created
draft is only intermediate DRAFT_CREATED; immediate full-state sync adds byline
and featured media, so it cannot reach approval early. This preserves the frozen
CREATE trio.

Keep distinct hashes:

- state fingerprint / `applied_version`: canonical SHA-256 using sync
  `contract_version: 2` over title, content, excerpt, sorted/deduplicated
  categories, editorial_byline, and
  featured_media_key;
- CREATE reconciliation fingerprint: unchanged `contract_version: 1`, title,
  content, excerpt,
  and categories only, exactly matching frozen CREATE payload.

Story.version is separate from both. Category desired state uses exact persisted
ACTIVE `wordpressCategoryId` values, numeric/sorted/deduplicated, never slugs; GET
postcondition proves no leftovers, silent drops, or extras.

## 9. WordPress transport hardening

Current clients are not pinned. Before activation production WordPress origins are
HTTPS-only, with no credentials/query/fragment. Resolve configured hostname before
each request and reject loopback, RFC1918 private, link-local, CGNAT,
multicast/reserved, IPv6 loopback/unspecified/ULA/link-local, and IPv4-mapped
forbidden addresses. Connect to one validated address while preserving hostname
for TLS SNI/certificate validation, with no uncontrolled second lookup. Do not
follow redirects; never forward HMAC across hosts; bound timeouts. Tests inject
resolver/transport. Disposable local WordPress injects test transport rather than
weakening production. No WordPress server change is needed for this hardening.

## 10. Durable staged saga and event terminal semantics

Phase A—transaction: lock/revalidate; CAS Story version `old → old+1`; set READY;
insert ACTIVE preparation with unique prompt correlation and configurable preview
expiry (default 24 hours); content-free audit; leave initiating event PROCESSING;
commit before external work.

Phase B—media: set DRAFT_CREATING without version change and reconcile all durable
objects using short DB lifecycle transactions and external calls.

Phase C—create: if needed, create/reconcile by permanent draft key outside a
transaction, persist post ID, set DRAFT_CREATED; no version change.

Phase D—sync: GET state, build six-field desired state (empty excerpt, exact numeric
categories, Story byline, first-media key/null), expected-version PUT, and reconcile
uncertainty by GET before retry. Final GET must match post ID, draft status, all six
values, and applied_version; persist applied version. No version change.

Phase E—one local transaction: revalidate epoch/proof; create unique PENDING prompt;
link it; set preparation READY_FOR_APPROVAL/readyAt, Story AWAITING_APPROVAL,
Conversation AWAITING_APPROVAL through existing CAS; audit; mark initiating event
PROCESSED. It need not await WhatsApp delivery.

Recovery scans explicit unfinished DraftPreparation rows only, never historical
PROCESSED events. Round 6 owns this saga recovery, not generic Round 8 abandoned
PROCESSING recovery. Unless Round 6 safely rediscovers a stranded event through its
preparation FK, Round 8 recovery is a production gate.

## 11. Failure taxonomy and content-free evidence

| Class | Durable result | Recovery |
|---|---|---|
| local integrity corruption | preparation FAILED; Story FAILED only when automation is unsafe | supervised repair |
| operator-fixable auth/capability/config/store/catalog condition | BLOCKED; Story stays recoverable | resume same preparation after repair |
| network/5xx/temporary store failure | ACTIVE or RECONCILIATION_REQUIRED | bounded retry/reconciliation |
| uncertain external mutation | RECONCILIATION_REQUIRED | GET by media key/draft key/state before mutation retry |

Safe codes include `COMPLETENESS_NOT_SATISFIED`,
`CATEGORY_SELECTION_NO_LONGER_ACTIVE`, `STORY_FINALISATION_CONFLICT`,
`MEDIA_BYTES_UNAVAILABLE`, `MEDIA_OBJECT_STORE_UNCONFIGURED`,
`WORDPRESS_MEDIA_RECONCILIATION_REQUIRED`,
`WORDPRESS_DRAFT_RECONCILIATION_REQUIRED`, `WORDPRESS_DRAFT_BLOCKED`,
`WORDPRESS_STATE_MISMATCH`, `PREVIEW_VERSION_STALE`, `PREVIEW_EXPIRED`, and
`APPROVAL_PROMPT_NOT_SENT`, plus stronger current client codes.

Audit events follow snake_case: `story_finalisation_requested`,
`story_finalisation_rejected_incomplete`,
`story_finalisation_rejected_inactive_category`, `draft_preparation_started`,
`wordpress_media_reconciled`, `wordpress_draft_created`,
`wordpress_draft_reconciled`, `draft_preparation_reconciliation_required`,
`draft_preparation_blocked`, `story_ready_for_approval`,
`approval_prompt_queued`, `approval_prompt_sent`, `story_revision_requested`, and
`draft_preparation_superseded`. AuditLog is evidence, never state. Metadata is
limited to IDs, version, counts, positions, safe MIME/fingerprints, numeric WP IDs,
and transitions. Errors/audits/logs never contain headline/body/byline/caption,
phone, token/secret, temporary URL, raw provider payload, or bytes.

## 12. Crash/recovery matrix

The initiating event remains PROCESSING through Phase D. Every retry reuses durable
identity and performs no remote call inside a transaction.

| Crash point | Durable state | Deterministic recovery / no-duplicate rule |
|---|---|---|
| after validation before Phase A commit | Story COLLECTING; no preparation | rollback; retry finalises once; no remote effect |
| after READY/preparation commit | READY; ACTIVE | resume explicit epoch; no new row/version |
| after one of several media succeeds locally | DRAFT_CREATING; ACTIVE | skip/reconcile completed keys in canonical order |
| after attachment succeeds before local ID | DRAFT_CREATING; RECONCILIATION_REQUIRED | GET media key before POST; persist recovered ID |
| after draft POST succeeds before local post ID | DRAFT_CREATING; RECONCILIATION_REQUIRED | GET permanent draft key; one post forever |
| after draft GET before local update | DRAFT_CREATING/DRAFT_CREATED; ACTIVE | safely repeat GET; no mutation needed |
| after PUT succeeds but response is lost | DRAFT_CREATED; RECONCILIATION_REQUIRED | GET/compare hash; only mismatch with fresh expected version permits PUT |
| after applied_version known but completion tx fails | DRAFT_CREATED; ACTIVE/reconciling | GET/recompare then idempotent Phase E; unique prompt/FK |
| after prompt PENDING created | event PROCESSED; approval posture complete | dispatcher owns exact row; saga does not resend |
| after dispatcher marks SENDING before HTTP | prompt SENDING | provider-safe reconciliation/lease; no blind duplicate |
| provider accepts before local SENT | prompt SENDING; approval forbidden | reconcile provider authority before SENT/resend |
| after Conversation enters AWAITING_APPROVAL | Phase E atomic invariant | reread only; no duplicate transition/prompt |
| after `/revise` before old token/control | new COLLECTING epoch; old SUPERSEDED | old epoch resolves stale and fails closed |

## 13. Safe Reporter preview

Preview is a Round 6 activation prerequisite, never a public WordPress draft URL.
Use a backend-hosted read-only shell conceptually
`https://newsroom.example/preview#token=<signed-value>`. The fragment is absent
from the initial HTTP request target, proxy URL, and Referer; shell code POSTs it in
body or Authorization header to the render endpoint.

Dedicated preview-secret HMAC covers preparation ID, story ID, Story version,
WordPress applied version, and expiry. Never persist raw token in preparation,
prompt, audit, errors, or logs; persist only `previewExpiresAt`. Lifetime is
configurable, default 24 hours.

Before rendering require current, non-SUPERSEDED/non-FAILED preparation; matching
Story/current Conversation ownership and epoch; approval-compatible Story status;
nonexpired token; stored applied version. HMAC GET current WordPress state and
require expected post ID, status exactly draft, and applied version equal to the
preparation. Drift returns generic unavailable and requires reconciliation before
preview/approval. Render authoritative headline, editorial byline, body,
categories, and only securely available image representation. If inline media
needs a new authenticated read surface, build/prove it separately; expose no
object/filesystem secret. Preview is read-only.

Return `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow, noarchive`, strict CSP, no external
images/scripts/fonts/styles, and no WordPress cookie/login/generic credential.
Expiry does not invalidate Story. Reissue only for the same current preparation,
Story version, and applied version without version mutation. Prove
`Story.byline == WordPress editorial_byline == preview byline`; later Reporter
byline changes cannot alter the Story snapshot.

## 14. Outbound prompt, AWAITING_APPROVAL, and approval binding

OutboundMessage is durable send authority. Queue payload contains typed non-secret
IDs/version/template/control identity only, no story content or token. Dispatcher
constructs the fragment preview token/URL at send time. A dedicated subsystem
deterministically claims PENDING, commits PENDING → SENDING, calls provider outside
transactions, uses provider correlation/idempotency, and marks SENT only after
acceptance proof. Uncertainty is reconciled before resend; errors are fixed and
content-free. DELIVERED remains webhook-driven. The repository has no client today,
so 6B.3 must build it before `/done`; outbound HTTP never hides in story/draft code.

Conversation AWAITING_APPROVAL means Story is AWAITING_APPROVAL, preparation is
READY_FOR_APPROVAL, WordPress full state/status/applied version were verified, safe
preview can be generated, and durable prompt intent exists. It does not mean
delivery. Round 7 accepts only if the bound prompt is SENT or DELIVERED, never
PENDING, SENDING, or FAILED.

Primary approval authority is a non-secret bound ID such as
`newsroom:v1:story:approve:<opaque-prompt-id>`, resolving the durable prompt and
preparation rather than the current Story. Text `/approve` is fallback only when
exactly one current valid prompt resolves for that Reporter and all ownership,
epoch, fingerprint, and send-status checks pass. Approval binds Reporter, Story,
DraftPreparation, Story.version, applied_version, and OutboundMessage. Old controls
after revision fail closed.

## 15. `/revise` and actual editing scope

For an ACTIVE Reporter, `/revise` is actionable only when owned current Story and
Conversation are AWAITING_APPROVAL and current preparation is READY_FOR_APPROVAL.
One canonical-lock transaction changes Story to COLLECTING and increments version
exactly once, Conversation to COLLECTING_MEDIA, and preparation to SUPERSEDED. It
retains draft key/post ID/media, performs no remote call, and immediately invalidates
old preview, prompt, and approval epoch. The next `/done` creates a new preparation
and full-state syncs the same post.

Current Round 5 COLLECTING_MEDIA accepts images and exact `/categories ...`; it has
no headline/body replacement control there. `/revise` enables only those existing
mutations. Future exact `/headline` or `/body` controls require separate supervisor
approval and are not silently added.

## 16. Exact Round 7 handoff

Round 7 may act only when all are true: ACTIVE Reporter; owned Conversation is
AWAITING_APPROVAL and points to Story; Story belongs to Reporter and is
AWAITING_APPROVAL; exactly one current preparation is READY_FOR_APPROVAL, not
SUPERSEDED, and matches Story.version; reconciled post ID exists and matches Story;
HMAC state GET succeeds with that post, status draft, and applied_version equal to
the preparation; all intended media are reconciled; categories remain exact and
authoritative; safe preview exists for the same Story/version/applied_version; the
explicit linked prompt belongs to the same Reporter/Story/preparation and is SENT
or DELIVERED; and no blocked/uncertain/reconciliation work remains.

Only then may Round 7 resolve the bound event and create Approval with preparation,
Story version, and applied version. Pre-revision controls, version mismatch, and
WordPress drift fail closed. Never “approve whatever is current.”

## 17. Security and production prerequisites

Preserve HMAC-only separated draft/media authority; no App Password/publish
authority; HTTPS pinned transport; manual redirects/no cross-host HMAC; no
Reporter URL; durable byte verification; ownership/ACTIVE/CAS isolation; separate
preview secret; token non-persistence; content-free telemetry.

Activation requires configured production durable object store; draft/media HMAC
credentials; HTTPS WordPress origin and pinned transport; deployed byline-aware
draft-sync contract; operational category synchronization; public backend preview
origin/secret and compatible proxy logging; Meta outbound credentials and deployed
dispatcher; and Round 8 generic recovery if Round 6 cannot reclaim a stranded
PROCESSING event through preparation linkage. No activation before all gates.

## 18. Future test/proof matrix

Require: incomplete and inactive-category `/done`; zero/one/multi-media; position-0
featured; all attachment reconciliation; duplicate/20-way `/done`; exactly one
epoch bump; stale Story CAS/cross-Reporter isolation; no external I/O in PG tx;
media partial/lost-response recovery; create and sync uncertainty; exact categories;
applied-version mismatch; exact byline/unchanged technical author; WordPress always
draft and zero publish call/status/PUBLISH execution; preview valid/expired/stale/
drift and token absent from storage/logs/initial URL; PENDING/SENDING/FAILED cannot
approve and SENT/DELIVERED can later qualify; outbound uncertainty; `/revise`
invalidation with same key/post; old control rejection; cutover before/equal/after
on receivedAt and no historical replay; DNS/address-family rejection, SNI/cert
hostname, no redirect/HMAC forwarding, timeout/injected transport; all 13 crash
points; fresh/adopted/repeated/drift PostgreSQL migration; Round 5 and Round 2B
regressions; frozen normalized hashes unchanged.

## 19. Frozen minimum implementation plan

### 6B.0 — persistence prerequisites

Scope: approved Prisma delta, migration/client, constraints. Non-goals: runtime
saga, WP/outbound/preview, controls, Approval writes/publish. Sources: schema,
migration, DB tests. Schema: yes. WordPress: no. Proof: fresh/adopted/repeated/drift
PostgreSQL and constraints/concurrency. Disposable WP: N/A. `/done`: disabled.

### 6B.1 — WordPress contract/client hardening

Scope: byline private-meta full state, applied-version update, Node DTO/client,
HTTPS pinned draft/media transports, normal bootstrap/version. Non-goals: frozen
CREATE, saga/preview/outbound/controls/publish. Sources: non-frozen sync controller,
bootstrap, Node draft/media/security and tests. Schema: no. WordPress: non-frozen
only; protected trio forbidden. Proof: contract KATs, Unicode/length/unknown fields,
author/status, two fingerprints, DNS/redirect. PostgreSQL: none. Disposable WP:
required GET/PUT/meta/fingerprint proof. `/done`: disabled.

### 6B.2 — saga core

Scope: unreachable finalisation primitives, preparation worker, media verification,
create/sync/reconcile, crash recovery, preview authority primitives. Non-goals:
control routing, send, Approval/publish. Sources: new preparation module and current
interfaces/config/audit. Schema/WP source: no. Proof: status/epoch/category/lock,
I/O boundaries, uncertainty, crash 1–8, PostgreSQL concurrency and disposable WP.
`/done`: disabled.

### 6B.3 — preview and outbound

Scope: fragment shell/render endpoint, token/expiry/drift, Meta client/dispatcher,
typed prompt/bound ID. Non-goals: `/done`, `/revise`, Approval/publish. Sources: new
preview/outbound/config/UI. Schema/WP source: no. Proof: preview security/rendering,
dispatcher claims/uncertainty, crash 9–11, PostgreSQL, disposable WP drift, fake
Meta. `/done`: disabled.

### 6B.4 — `/done` activation and full integration

Scope: exact routing/cutover, transactional validation, worker invocation, Phase E.
Non-goals: `/revise`, approval/publish. Sources: reporter/story workflow and proven
Round 6 modules. Schema/WP source: no. Proof: full matrix, 20-way/one bump, all
recovery/prompt/event semantics, regressions, PostgreSQL and disposable WP. `/done`
stays disabled until this proof passes; only then enable behind all config gates.

### 6B.5 — `/revise`

Scope: exact controls, atomic supersession/invalidation, same-post next-epoch sync.
Non-goals: new editing controls, Approval/publish. Sources: workflow/preparation and
tests. Schema/WP source: no. Proof: crash 12–13, stale token/control, same key/post/
media, PostgreSQL contention, disposable WP resync. `/done`: only as gated by 6B.4.

## 20. Supervisor decisions

BLOCKING SUPERVISOR DECISIONS: NONE

PRE-PRODUCTION ONLY: select/confirm the concrete production durable object-store
adapter and the Meta provider's exact reconciliation/idempotency mechanism during
6B.3. These deployment choices may not weaken the frozen fail-closed contracts.
