# Round 7A — Approval and Publication Architecture

Status: corrected architecture ready for supervisor freeze. Round 7A changes this
document only; it does not implement application, Prisma, migration, or WordPress
changes and it returns one consolidated final report (§21).

Baseline: `feat/round-7-approval-publish` at `02c53241ad9204d4193ec927b5d0459b18c8760a`.
Round 6 prepared and presented one reconciled WordPress DRAFT. Round 7 alone
approves and publishes. The Round 6 architecture document
(`docs/ROUND_6_DRAFT_APPROVAL_ARCHITECTURE.md`) is the frozen base; this document
supersedes nothing in it and adds the approval/publish layer exactly at the Round 6
handoff (§16 of Round 6, restated here in §3).

## 1. Audited current contracts

This design was re-audited against `prisma/schema.prisma`, the Round 6B migration,
inbound event processing, the story event processor, the conversation state
machine, draft preparation/revision/finalisation services, newsroom preview and
token services, the WhatsApp outbound dispatcher/client and approval prompt
service, WordPress draft/media HMAC allowlists and transport, application
configuration and environment validation, and the relevant DB/unit/e2e tests.

Current facts are:

- There is no `Approval` runtime path: no `/approve` handling exists in
  `story-event-processor.service.ts` (only `/done` and `/revise` are recognized,
  both gated by `round6DoneEnabled`), no `Approval` writes exist anywhere, and
  `PublishOperation.PUBLISH` execution does not exist. `Approval`, `APPROVED`,
  `PUBLISHING`, `PUBLISHED`, `approvedAt`, `publishedAt`, and `story_approval_*`
  audit events are Round 7 alone.
- The conversation state machine already permits `AWAITING_APPROVAL → PUBLISHING`
  (mutation `PRESERVE`) and `PUBLISHING → IDLE` (mutation `CLEAR`). `PUBLISHING`
  has no outgoing edge other than `IDLE`; `Conversation` clears its
  `currentStoryId` on the `PUBLISHING → IDLE` transition.
- The approval prompt interactive control id is `newsroom:v1:story:approve:<OutboundMessage.id>`
  (built by the dispatcher, validated by the client against
  `^newsroom:v1:story:approve:[0-9a-f-]{36}$`). The prompt payload is
  `APPROVAL_PROMPT_V1 { draftPreparationId, storyId, storyVersion, wordpressAppliedVersion }`.
- `ApprovalPromptService.queueApprovalPromptInTransaction` locks Story then
  DraftPreparation, identity-checks `storyId`/`storyVersion`/`wordpressAppliedVersion`,
  and is idempotent through the unique `approvalPromptCorrelationKey` and the
  unique optional FK `approvalPromptOutboundMessageId`.
- The WhatsApp dispatcher re-verifies inside its claim transaction: message
  `PENDING`, preparation `READY_FOR_APPROVAL`, Story `AWAITING_APPROVAL`,
  Conversation `AWAITING_APPROVAL` pointing at Story, `story.version == prep.storyVersion`,
  `prep.wordpressAppliedVersion` equals payload, reporter identity, and
  `prep.approvalPromptOutboundMessageId == message.id`. Any mismatch returns
  `NOT_CLAIMED`. `DispatchResult` is `SENT | FAILED | OUTCOME_UNCERTAIN | NOT_CLAIMED | MANUAL_RECONCILIATION_REQUIRED`.
- `Round6FinalisationService.completeApprovalPostureInTransaction` (Phase E) is
  the only place that writes `READY_FOR_APPROVAL`/`AWAITING_APPROVAL`/`PROCESSED`
  and is itself idempotent. The initiating `/done` event is `PROCESSED` inside
  Phase E, before out-of-band dispatch.
- `Round6RevisionService.reviseInTransaction` locks in the canonical order
  `InboundEvent → Reporter → Conversation → Story → DraftPreparation →
  OutboundMessage` and supersedes the preparation
  (`SUPERSEDED`), returns Story to `COLLECTING` with exactly one version
  increment, transitions Conversation to `COLLECTING_MEDIA`, and marks the
  `/revise` event `PROCESSED`. It performs no remote WordPress I/O. A superseded
  preparation keeps its prompt row; the prompt is simply no longer resolvable.
- Preview token claims v1 are `{ v, preparation_id, story_id, story_version,
  wordpress_applied_version, exp }`, signed under `newsroom-preview-v1` HMAC.
  Issue re-runs `verifyPreparedAuthority` and throws `PREVIEW_EXPIRED` when
  `now >= exp`. Verify accepts only an exact claim shape and rejects by
  `PREVIEW_UNAVAILABLE`/`PREVIEW_EXPIRED`. Preview render/media re-verify the
  preparation identity including `previewExpiresAt` equality and re-run
  `verifyPreparedAuthority`; `PREVIEW_VERSION_STALE` fails closed.
- `verifyPreparedAuthority` accepts preparation status `ACTIVE` or
  `READY_FOR_APPROVAL` only, Story status `DRAFT_CREATED` or `AWAITING_APPROVAL`
  only, matching `wordpressPostId`, all media `UPLOADED` with positive
  `wordpressMediaId`, and a live HMAC GET whose `post_id`/`applied_version`/full
  state equal the preparation. It persists `WORDPRESS_STATE_MISMATCH` and fails
  closed on drift. It performs remote I/O and is never used inside a PostgreSQL
  transaction.
- WordPress HMAC allowlists are exhaustive and contain no publish operation:
  draft = `POST /newsroom/v1/drafts`, `GET|PUT /newsroom/v1/drafts/{uuid}`,
  `GET /newsroom/v1/drafts/{uuid}/state`; media = `POST /newsroom-media/v1/media`,
  `GET /newsroom-media/v1/media/{uuid}`. Signed canonical strings are
  `newsroom-hmac-v1` and `newsroom-media-hmac-v1`; each has its own key id and
  32-byte base64url secret.
- `InboundEvent.receivedAt` is a required column with DB default `now()` (the
  webhook module has no reporter-provided `receivedAt` field; the stored parser
  derives nothing as `receivedAt`). `providerOccurredAt` is optional and is used
  only for parse-integrity cross-checking. `ROUND6_CONTROL_CUTOVER_AT` exists in
  environment validation as a strict RFC3339/ISO-8601 UTC millisecond instant
  (e.g. `2026-01-01T00:00:00.000Z`), optional in test (default `9999-12-31T23:59:59.999Z`),
  required otherwise. There is no `round7` configuration section yet.
- `Approval` (already in `schema.prisma`) has: `storyId @unique`, `reporterId`,
  `inboundEventId @unique`, `draftPreparationId @unique`, `storyVersion`,
  `wordpressAppliedVersion Char(64)`, `decision ApprovalDecision default APPROVED`,
  `createdAt`, relations to Story/Reporter/InboundEvent/DraftPreparation, and
  indexes on `reporterId`, `storyVersion`, `wordpressAppliedVersion`.
  `ApprovalDecision` contains only `APPROVED`.
- `StoryStatus` contains `APPROVED`, `PUBLISHING`, `PUBLISHED`; `Story` has
  `approvedAt`/`publishedAt`/`wordpressPostUrl`. `ConversationState` contains
  `PUBLISHING`. `PublishAttemptStatus` is `PENDING | IN_PROGRESS | SUCCEEDED |
  FAILED | RECONCILIATION_REQUIRED`; `PublishAttempt` has `@@unique([storyId,
  operation, attemptNumber])`, unique `idempotencyKey`, `wordpressPostId`,
  `httpStatus`, `errorCode`, `errorMessage`, `startedAt`, `completedAt`.
- `Story.wordpressDraftKey` is permanent: one Story, one WordPress post forever.
  Revision reuses the same key/post and never deletes. Every draft response/state
  read must prove `status == draft`.
- Protect CREATE reconciliation files remain frozen. Their committed LF-normalized
  SHA-256 values are `1362CB101031088B78E27D54B78EDFAC6488D9F979979A3786916839811A20FA`
  (`class-newsroom-bridge-db.php`),
  `6A7CE8AEC4AB3040804C217F00341275EAD25EA78570FC4CC93F47CDE03A373A`
  (`class-newsroom-bridge-reconciliation.php`), and
  `965608C6063540985D23F9A83A679C49EEE1543238C595A850100755F9CF609A`
  (`class-newsroom-bridge-rest.php`); all re-verified unchanged. The publish
  surface is built exclusively in new, non-frozen files.
- Round 6B migration contains a pre-DDL guard that raises
  `ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED` when `Approval` rows already exist in a
  pre-production database; Round 7B.0 extends this posture (see §13).

## 2. Scope, controls, and cutover

Round 7 owns exact `/approve` (and bound interactive control) handling, the
approval transaction, the durable `Approval` row, the durable `PublishAttempt`
binding for `PUBLISH`, the publish saga with WordPress CAS publish, the
`APPROVED → PUBLISHING → PUBLISHED` lifecycle, `Conversation.PUBLISHING`, and all
publish reconciliation (cases A–E) and crash recovery. It never revises, never
sets WordPress status other than `draft → publish` through the isolated publish
surface, never uses NLP/fuzzy intent, never uses a generic WordPress Application
Password, and never treats prompt delivery guarantees as publish authority.

`CANCELLED` retains its Round 5 meaning and remains unreachable from
`AWAITING_APPROVAL` (no conversation edge exists).

| Action | TEXT authority | INTERACTIVE authority |
|---|---|---|
| approve | exact trimmed `/approve` | exact ID `newsroom:v1:story:approve:<OutboundMessage.id>` |

Display titles, casing variants, prefixes/suffixes, and fuzzy matches have no
authority. `/approve` is a fallback and is accepted only when exactly one current
valid prompt resolves for that Reporter (§3). Until Round 7 is active, approval
controls return `CONTROL_NOT_ENABLED` only, exactly like Round 6 pre-cutover.

Retain the deployment watermark `ROUND7_CONTROL_CUTOVER_AT` (new, alongside
unchanged `ROUND6_CONTROL_CUTOVER_AT`): required, strict RFC3339/ISO-8601 UTC
instant, immutable for that deployment activation. Eligibility is exactly
`InboundEvent.receivedAt >= cutover`; equality is eligible and
`providerOccurredAt` is never used as the authority. Missing/invalid
configuration fails startup closed. Historical `PROCESSED` events are never
scanned. Test before/equal/after. An approval control received before the cutover
is always `CONTROL_NOT_ENABLED`, regardless of prompt state.

## 3. Control binding and approval resolution

A `newsroom:v1:story:approve:<OutboundMessage.id>` reply id resolves strictly as a
bound control: look up the `OutboundMessage` by id, then its uniquely linked
preparation (`approvalPromptOutboundMessageId`), then the Story. Text `/approve`
is accepted only when, for that Reporter, exactly one current valid prompt
resolves — an `INTERACTIVE` `OutboundMessage` whose
`correlationKey == preparation.approvalPromptCorrelationKey`, status is `SENT` or
`DELIVERED` (never `PENDING`, `SENDING`, or `FAILED`), whose preparation is
`READY_FOR_APPROVAL` not `SUPERSEDED`, whose Story is `AWAITING_APPROVAL` and
owned by the Reporter, and whose version/applied-version match. Zero or more than
one resolution returns `APPROVAL_AMBIGUOUS` and fails closed.

The approval event must be the ordered currently owned event and cutover-eligible;
Reporter `ACTIVE`; Conversation belongs to Reporter and is `AWAITING_APPROVAL`;
Story belongs to Reporter, is `AWAITING_APPROVAL`, version equals the preparation;
preparation is `READY_FOR_APPROVAL`; the bound prompt is `SENT`/`DELIVERED`;
reconciled `wordpressPostId` exists and matches Story; applied version is present
and 64-hex.

Before the approval transaction, mandatory **Approval Phase 0** resolves the
candidate authority locally and, outside every PostgreSQL transaction, performs
an authoritative WordPress draft GET. It requires the exact permanent draft key,
exact post ID, `status == draft`, `applied_version ==
DraftPreparation.wordpressAppliedVersion`, exact canonical title, body, excerpt,
categories, `editorial_byline`, featured media, expected technical author, and no
other state drift. Failure creates no Approval or PublishAttempt and performs no
`APPROVED` transition. The local transaction then revalidates the candidate under
locks (§4). The later publish CAS remains mandatory and closes the
verify→approve→publish TOCTOU window; WordPress I/O never occurs inside the
approval transaction.

## 4. Approval transaction

Single canonical-lock transaction. Every participant locks in this exact global
order: `InboundEvent → Reporter → Conversation → Story → EditorialCategory rows
selected by the Story → StoryCategory rows → StoryMedia rows → DraftPreparation
→ linked OutboundMessage → existing Approval, if any → relevant PublishAttempt,
if any`. Category, join, and media rows are locked in stable primary-key order;
`/revise` must adopt this expanded Round-7 order before approval is enabled.

1. Resolve the bound control or the unique `/approve` fallback (§3).
2. Revalidate under those locks: Reporter `ACTIVE`; Conversation
   `AWAITING_APPROVAL`, `currentStoryId == Story.id`, same Reporter; Story
   `AWAITING_APPROVAL`, same Reporter, exact expected `Story.version`; every
   selected category still `ACTIVE` and the exact `StoryCategory` set preserved;
   all intended media still authoritative/reconciled with no invalid or missing
   WordPress media authority; DraftPreparation `READY_FOR_APPROVAL`, not
   `SUPERSEDED`, same Story/version/post and valid exact
   `wordpressAppliedVersion`; linked OutboundMessage has the same Reporter,
   Story, preparation, and typed approval payload and is `SENT` or `DELIVERED`
   only; existing Approval and PublishAttempt are absent or exact idempotent rows
   for this event/approval/epoch, never conflicts. Any failure follows the existing
   ignored/conflict semantics (`APPROVAL_IDENTITY_CONFLICT`,
   `APPROVAL_PROMPT_NOT_SENT`, `APPROVAL_STATE_MISMATCH`).
3. Create `Approval { storyId, reporterId, inboundEventId (the /approve event),
   draftPreparationId, storyVersion, wordpressAppliedVersion, decision APPROVED }`.
   Unique constraints on `storyId`, `inboundEventId`, and `draftPreparationId`
   make a second approval for the same Story, same event, or same epoch
   impossible.
4. Story → `APPROVED`, `approvedAt` set.
5. Create the durable `PublishAttempt` for `operation PUBLISH`, attempt number =
   `max(attemptNumber) + 1` for `(storyId, PUBLISH)`, status `PENDING`,
   `idempotencyKey = draft-publish:{draftPreparationId}:{storyVersion}`, and set
   the (Round 7B.0 reserved) `approvalId` FK to the new `Approval`. This is the
   durable Approval ⊣ PublishAttempt binding: one approved epoch, one logical
   publish intent, forever.
6. Leave the `/approve` event `PROCESSING`. Conversation stays
   `AWAITING_APPROVAL`; Story.version is unchanged.
7. Content-free audit `story_approval_bound` with IDs/version/applied-version
   only.

No WordPress, object-store, Meta, DNS, or other remote I/O occurs in this
transaction. Locking selected categories closes the deactivation race: it either
precedes approval (which fails) or follows the approved snapshot. Locking
StoryMedia and checking reconciliation identifiers closes media replacement or
deletion races; the WordPress CAS later independently rejects changed or missing
media/content authority. Approval commit is the final local authority snapshot:
the ACTIVE categories, exact StoryCategory set, and reconciled StoryMedia set are
the immutable approved epoch. Later catalogue deactivation alone neither rewrites
nor revokes it. Any direct Story, StoryCategory, or StoryMedia mutation after
`APPROVED` is invariant corruption and publication fails closed. The publication
CAS proves actual WordPress state still equals that approved snapshot. After commit, the out-of-band publish driver proceeds
(§5); unlike Round 6 prompt dispatch, the approval event remains `PROCESSING`
until publication finalization.

Consequence: Story `APPROVED` is the point of no revision. A `/revise` arriving
after approval finds Story not `AWAITING_APPROVAL` and fails with
`STORY_REVISION_CONFLICT`; there is no revision window between approval and
publish (§10).

## 5. Durable publish saga

PublishAttempt status semantics and their complete PostgreSQL posture are frozen:

| Attempt status | Exact meaning and durable posture |
|---|---|
| `PENDING` | Durable intent exists but is unclaimed: Story `APPROVED`, Conversation `AWAITING_APPROVAL`, inbound approval event `PROCESSING`. |
| `IN_PROGRESS` | Claim committed and outcome not yet proved: Story `PUBLISHING`, Conversation `PUBLISHING`, event `PROCESSING`. |
| `RECONCILIATION_REQUIRED` | External outcome/authority or repairable auth, configuration, or capability condition cannot safely continue automatically: Story and Conversation remain `PUBLISHING`, event remains `PROCESSING`, DraftPreparation remains immutable `READY_FOR_APPROVAL`, and the same attempt is retained for explicit supervised reconciliation. The ordinary scheduler never claims it; no blind retry. |
| `SUCCEEDED` | Ledger-backed publication proved and PostgreSQL finalization committed: Story `PUBLISHED`, Conversation `IDLE` with currentStoryId cleared, event `PROCESSED`, same attempt terminal `SUCCEEDED`. |
| `FAILED` | Only unrecoverable local invariant/corruption or an explicit supervised terminal decision where automatic retry is unsafe. Story remains in a supervised terminal failure posture, Conversation remains non-IDLE and attached for operator control, event remains `PROCESSING`; no automatic retry or new intent. |

Phase A — claim: a dedicated subsystem deterministically claims the `PENDING`
`PUBLISH` `PublishAttempt` by `idempotencyKey` (Approval-linked resume is primary;
a scan may schedule that same row but never creates intent), re-verifies
`approvalId` exists and Story is `APPROVED`, sets the attempt `IN_PROGRESS`,
transitions Conversation `AWAITING_APPROVAL → PUBLISHING` (`PRESERVE`), and
sets Story `APPROVED → PUBLISHING`, then commits. InboundEvent remains
`PROCESSING`. No remote I/O.

Phase B — publish: outside any PostgreSQL transaction, GET authoritative ledger
evidence by `publish_key` (§7). Matching `PUBLISHED` evidence proves success;
otherwise POST the exact approved binding. An already-published post without
matching ledger authority fails closed (§8).

Phase C — finalize: short transaction, after ledger-backed acceptance proof, sets Story
`PUBLISHED`/`publishedAt` (+ `wordpressPostUrl` when returned), attempt
`SUCCEEDED`/`completedAt`/`httpStatus`, and transitions Conversation
`PUBLISHING → IDLE` (`CLEAR`, detaching `currentStoryId`), and changes the inbound
approval event `PROCESSING → PROCESSED`, sets `processedAt`, and clears errors. Audit
`story_publish_succeeded` with the numeric post id. `process(eventId)` and attempt
scanning converge on the same Approval-bound attempt; neither generically reclaims
an InboundEvent (§12).

Phase D — reconciliation: on uncertainty/crash the saga performs strict
GET-before-action reconciliation (§8). A publish that can never be proven against
the approved epoch transitions the attempt to `RECONCILIATION_REQUIRED`; Story
and Conversation remain `PUBLISHING`, the approval event remains `PROCESSING`,
and DraftPreparation remains `READY_FOR_APPROVAL` as immutable historical approval
evidence, requiring operator decision (§8 Case E).
Uncertain, network, timeout, 5xx, lost-response, and repairable auth/configuration/
capability outcomes always become `RECONCILIATION_REQUIRED`, never `FAILED`, and
are never blindly retried.

## 6. WordPress publish authority

The WordPress production surface gets an isolated durable ledger and capability
through new non-frozen files only: `class-newsroom-bridge-publications-table.php`,
`class-newsroom-bridge-publish-auth.php`, and
`class-newsroom-bridge-publish-rest.php`. Bootstrap/schema-version wiring is
deferred to an explicitly approved 7B.1.
The frozen protected trio (`class-newsroom-bridge-db.php`,
`class-newsroom-bridge-reconciliation.php`, `class-newsroom-bridge-rest.php`) is
never modified.

The exact HMAC canonical UTF-8 byte string is six fields separated by one LF byte
and has no trailing newline:
`newsroom-publish-hmac-v1\n{key_id}\n{UPPERCASE_METHOD}\n{canonical REST route}\n{unix_timestamp}\n{lowercase_sha256_of_exact_raw_body}`.
The route is the exact canonical path only (no scheme, host, or query), timestamp
is base-10 Unix seconds, and the body hash is 64 lowercase hex. GET uses the exact
zero-byte body hash
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Exact singleton headers are `X-Newsroom-Publish-Auth-Version:
newsroom-publish-hmac-v1`, `X-Newsroom-Publish-Key-Id`,
`X-Newsroom-Publish-Timestamp`, and `X-Newsroom-Publish-Signature` (base64url,
no padding). Reject duplicate auth headers, invalid/non-canonical base64url
secret/signature, clock skew outside tolerance, route/method/body-hash mismatch,
redirects or cross-host redirect, and credential forwarding. The dedicated
secret is 32 bytes base64url. Allowlist is
exactly: `POST /newsroom/v1/publications` and
`GET /newsroom/v1/publications/{uuid}` (idempotency/state read). No draft or media
namespace can publish; no publish namespace can create or sync drafts.

The frozen identity is a dedicated newsroom publisher service user/role, not an
Administrator, with only `read`/minimum login primitive if required and the custom
capability `publish_newsroom_publications`; it has no `publish_posts`,
`edit_others_posts`, generic `wp/v2` publication access, Application Password, or
broad REST write authority. Configuration contains an immutable map from each
allowed dedicated publish `key_id` to exactly one numeric publisher service-user
ID. Startup validates that the key id is unique, the user exists and is the
configured dedicated identity, and `user_can(configuredPublisherId,
"publish_newsroom_publications")`; invalid mapping fails closed. Request authority
is exactly: valid publish HMAC AND its key_id maps to that configured publisher ID
AND that configured user has the capability. No generic WordPress REST login is
required or accepted. Because identity comes only from the server-side key map,
the request cannot select or authenticate another user. Draft/media HMAC
credentials cannot authenticate. The controller accepts no content fields and
cannot alter title/body/byline/categories/media; publication preserves the
existing technical post author. Generic REST publication remains unavailable
because the identity lacks the primitive publish capability and generic REST
credentials, while this custom capability is checked only by this controller.

Transport: the publish client uses the same DNS-pinned HTTPS-only
`SecureWordPressTransport` as draft/media (no redirects, no cross-host HMAC
forwarding, bounded timeouts); responses must prove the publish outcome before
`SUCCEEDED`.

## 7. Publish HTTP contract and CAS

- `publish_key = PublishAttempt.id`. The existing PublishAttempt primary-key UUID
  is the permanent canonical WordPress ledger key for this immutable
  Approval-bound publication intent; no additional Prisma field is introduced.
  `draft_key` is the distinct permanent `Story.wordpressDraftKey`.
- New `${wpdb->prefix}newsroom_publications` (conceptually
  `wp_newsroom_publications`) has `publish_key CHAR(36)` primary/unique canonical
  UUID, `draft_key CHAR(36)`, `post_id BIGINT UNSIGNED`,
  `expected_applied_version CHAR(64)`, validated `status` (`RESERVED` or
  `PUBLISHED`), nullable `published_at`, and `created_at`/`updated_at`; unique
  `(draft_key, expected_applied_version)` enforces one successful newsroom
  publication for an approved draft epoch. The four-part binding is immutable.
- 7B.1 creates/upgrades it via the new isolated table class with explicit schema
  version, charset/collation, indexes, transactional-engine verification, and
  repeatable upgrade tests. It performs no inference/backfill from published
  posts. The protected trio remains byte-for-byte unchanged.
- `GET /newsroom/v1/publications/{publish_key}` returns authoritative ledger
  evidence (`publish_key`, `draft_key`, `post_id`, `expected_applied_version`,
  ledger `status`, `published_at`). Not found means no newsroom publication
  authority and permits POST only while the exact mapped post remains the approved
  draft. Exact `PUBLISHED` returns reusable success evidence. `RESERVED`, malformed,
  or conflicting state returns reconciliation/integrity failure and never permits
  blind publication or inferred success. It never synthesizes success from post
  status or fingerprint.
- `POST /newsroom/v1/publications` body `{ publish_key, draft_key,
  expected_applied_version, post_id }` (exact keys, no extras). After publish-HMAC
  authentication, a WordPress DB transaction first locks and reads the ledger by
  publish_key, before inspecting or requiring WordPress post status. An exact
  matching `PUBLISHED` row immediately returns its existing `200` evidence without
  any post read required for mutation, WordPress mutation, or repeated transition.
  `RESERVED`, malformed state, or the same publish_key with a different draft_key,
  post_id, or expected_applied_version fails closed as reconciliation/authority
  conflict. Only when no ledger row exists may it resolve the exact draft mapping,
  verify post_id, require current post status `draft`, compute and CAS the canonical
  Round-6 state fingerprint, verify technical author, reserve the durable binding,
  mutate only `post_status: draft → publish`, re-read and prove all content state
  unchanged, mark ledger `PUBLISHED`, and commit. Rollback leaves neither published
  status nor authoritative PUBLISHED ledger. Because reservation, status mutation,
  and `PUBLISHED` marking commit atomically, `RESERVED` is not normally durable or
  externally visible and is never continued blindly or treated as success.
  Responses:
  - `200` `{ publish_key, post_id, status: "publish", applied_version_before,
    published_at }` (accepted).
  - `409 STALE_VERSION` when the applied-version CAS fails.
  - `409 STATE_MISMATCH` when status is not `draft` (includes pre-published).
  - `403`/`401` capability/auth failure (blocked posture).
- The CAS means: a Story approved at epoch/applied-version V can only be
  published when WordPress still holds draft V. Drift anywhere fails closed and
  blocks the same immutable Approval and same PublishAttempt. An operator may
  restore WordPress to the exact approved draft state and resume that same attempt
  only when safely proven; otherwise the Story enters the supervised terminal
  failure posture. No second Approval/preparation or Reporter revision is allowed.
- If commit outcome is uncertain, GET by publish_key precedes every POST retry.
  Only the exact matching `PUBLISHED` ledger binding proves success; post status
  plus matching fingerprint is insufficient.

## 8. Reconciliation cases and no-duplicate rules

All publish reconciliation is GET-before-action on the exact immutable publish
key; its uniqueness, the epoch uniqueness, and the attempt idempotency key make a
second logical publication impossible.

- Case A — response lost after accepted POST: GET ledger. Exact binding with
  ledger `PUBLISHED` → mark `SUCCEEDED`, Story
  `PUBLISHED`, Conversation `IDLE`. Never re-POST.
- Case B — duplicate claim/retry (two workers): second claim re-checks
  `PENDING` under lock and returns `NOT_CLAIMED`; GET confirms already published.
- Case C — manual external publish: absent/not-PUBLISHED matching ledger authority,
  even when status is `publish` and fingerprint matches → `PUBLISH_CAS_CONFLICT` /
  `WORDPRESS_PUBLISH_BLOCKED`, attempt `RECONCILIATION_REQUIRED`, operator
  decision. Never infer success, create a ledger row retroactively, unpublish, or
  re-publish.
- Case D — stale approval recovery re-entry: attempt row idempotency
  (`approvalId`, `idempotencyKey` unique) makes re-entry read-only and harmless.
- Case E — draft drift between approval and publish (WordPress state changed, or
  an external full-state sync advanced `applied_version`): POST returns `409
  STALE_VERSION`; GET confirms mismatch; attempt
  `RECONCILIATION_REQUIRED`, posture blocking. The same immutable Approval and
  attempt remain authoritative. An operator may restore the exact approved draft
  and resume the same attempt if safely provable; otherwise apply supervised
  terminal failure. Never create another preparation/Approval or ask the Reporter
  to revise. No version is published except the approved one.

`RECONCILIATION_REQUIRED` is never auto-claimed by the ordinary scheduler.
Explicit supervised reconciliation performs GET first. An exact matching
`PUBLISHED` ledger finalizes the same attempt. If an operator safely restores and
proves the exact approved draft, the same attempt may be explicitly transitioned
back to `IN_PROGRESS` and resumed. Otherwise it remains
`RECONCILIATION_REQUIRED` or is moved by explicit supervision to `FAILED`. No path
creates another PublishAttempt.

## 9. Crash/recovery matrix

The approval transaction atomically commits Approval + PENDING attempt + Story
APPROVED while deliberately leaving the event PROCESSING. That durable Approval
is the sole Round-7 recovery authority.

| Crash point | Durable state | Deterministic recovery / no-duplicate rule |
|---|---|---|
| after `/approve` revalidation before commit/crash | event PROCESSING; no Approval | Round 7 does not reclaim; Round 8 owns generic abandoned-PROCESSING recovery |
| after Approval commit before publish claim | event PROCESSING; Approval durable; Story APPROVED; attempt PENDING | `process(eventId)` finds exact Approval and resumes its exact attempt; no new Approval/intent/version |
| after publish claim before HTTP | event PROCESSING; Story/Conversation PUBLISHING; attempt IN_PROGRESS | GET publication key before any POST |
| after WordPress transaction commits but response is lost | event PROCESSING; attempt IN_PROGRESS; exact ledger PUBLISHED | GET publish_key; durable PUBLISHED ledger proves success |
| manual external publish without matching ledger | event PROCESSING; attempt IN_PROGRESS; no PUBLISHED authority | fail closed to operator reconciliation; fabricate nothing |
| after auth/config/capability error, timeout, network error, or 5xx before attempt update | event PROCESSING; Story/Conversation PUBLISHING; attempt IN_PROGRESS | GET first, then set same attempt RECONCILIATION_REQUIRED; no blind retry |
| durable RESERVED/corrupt ledger observed | event PROCESSING; Story/Conversation PUBLISHING; same attempt not terminal | integrity reconciliation; never continue publish or infer success |
| after remote success before PG success | event PROCESSING; Story/Conversation PUBLISHING; attempt IN_PROGRESS | GET ledger proves success; finalize same attempt |
| after PG finalization before response | event PROCESSED; Story PUBLISHED; Conversation IDLE; attempt SUCCEEDED | duplicate process is read-only/`NOT_CLAIMED`; no second publish |
| `/approve` and `/revise` in flight | exactly one wins (§10) | canonical lock order; loser fails closed |
| publish driver dies mid-scan | PENDING/IN_PROGRESS rows | status scan resumes exact rows with GET-first for IN_PROGRESS; it never claims RECONCILIATION_REQUIRED |

## 10. `/revise` vs `/approve` race

Both transactions use the expanded canonical lock order in §4. Whichever acquires
Story `FOR UPDATE` first commits; the other
side sees the changed Story status and fails closed:

- `/approve` wins → Story `APPROVED`; `/revise` finds Story not
  `AWAITING_APPROVAL` → `STORY_REVISION_CONFLICT` (ignored).
- `/revise` wins → preparation `SUPERSEDED`, Story `COLLECTING` version+1;
  `/approve` resolution finds no `READY_FOR_APPROVAL`/`AWAITING_APPROVAL`
  posture → `APPROVAL_IDENTITY_CONFLICT`/`APPROVAL_AMBIGUOUS` (ignored).

There is no deadlock (identical order) and no revision window after approval
(Section 4 consequence).

## 11. Preview expiry and reissuance

An expired preview token returns `PREVIEW_EXPIRED` and nothing renders. Expiry
does not invalidate the Story, the approval, or the right to publish: the token is
a capability for a bounded viewing lifetime; approval binds the Story epoch
(`storyVersion`/`wordpressAppliedVersion`), not token lifetime. Reissue is
permitted only for the same current preparation, Story version, and applied
version without version mutation (Round 6 §13), and token issue requires
`verifyPreparedAuthority` (preparation `ACTIVE`/`READY_FOR_APPROVAL`, Story
`DRAFT_CREATED`/`AWAITING_APPROVAL`) — so after Story becomes `APPROVED` no new
preview is issuable, which is correct. An approved Story whose prompt token
expired still proceeds to publish with no additional controls and no version
change.

## 12. PROCESSING recovery for approval events

Round 7-owned recovery is limited and exact. Only the well-defined windows below
are resumed, each by re-reading durable rows, never by generic Round 8 abandoned-
`PROCESSING` reclamation:

When `process(eventId)` gets `NOT_CLAIMED` because the event is already
`PROCESSING`, it looks up exactly `Approval.inboundEventId == event.id`. If that
durable Approval exists, it loads the uniquely bound PUBLISH PublishAttempt,
validates the same approval/epoch binding, and resumes that exact attempt from
  `PENDING` or `IN_PROGRESS`. `RECONCILIATION_REQUIRED` is returned only to the
  explicit supervised GET-first flow in §8, never ordinary scheduling. It never creates another Approval, logical publication
intent, or Story version increment. Attempt scanning is only a scheduler for these
same durable rows and converges on this identical path; it is not independent
authority.

Approval and its PENDING PublishAttempt are created atomically in §4, so an
Approval-without-attempt state cannot result from an interrupted commit. If such
a state exists, it is invariant corruption: fail closed and require operator
reconciliation; never synthesize an attempt. If no exact Round-7 durable Approval
exists, do not generically reclaim or rerun the already-PROCESSING event. Generic
abandoned-PROCESSING recovery belongs to Round 8.

## 13. Schema and configuration delta (Round 7B.0 reserve)

No schema change is made in Round 7A. When implementation is approved, the single
controlled migration reserves:

```prisma
// reserved additions only; nothing is implemented in Round 7A
model Approval {
  // all current fields/relations remain (decision APPROVED only)
  publishAttempt PublishAttempt? @relation("ApprovalPublishAttempt")
}

model PublishAttempt {
  // all current fields/relations remain
  approvalId String? @unique @db.Uuid
  approval   Approval? @relation("ApprovalPublishAttempt", fields: [approvalId], references: [id], onDelete: Restrict, onUpdate: Cascade)
}
```

The migration also adds a named SQL CHECK constraint equivalent to:

```sql
CHECK (
  (operation = 'PUBLISH' AND "approvalId" IS NOT NULL)
  OR
  (operation IN ('CREATE_DRAFT', 'SYNC_DRAFT') AND "approvalId" IS NULL)
)
```

`approvalId` remains nullable and UNIQUE with the existing proposed FK
`ON DELETE RESTRICT ON UPDATE CASCADE`, preserving Round-6 CREATE_DRAFT and
SYNC_DRAFT rows while making invalid publication authority unrepresentable.
No publish-key column is added: `PublishAttempt.id` is already the canonical UUID
sent as `publish_key` and stored as the WordPress ledger primary key.

The unique `Approval.storyId`, `Approval.inboundEventId`, `Approval.draftPreparationId`,
and `PublishAttempt.approvalId` constraints plus the unique
`draft-publish:{draftPreparationId}:{storyVersion}` idempotency key make one
approval/one logical publish per epoch impossible to duplicate. The WordPress
ledger is a WordPress schema delta isolated to 7B.1, not Prisma; no additional PG
model is required. Env validation adds
`ROUND7_CONTROL_CUTOVER_AT` with identical RFC3339 UTC millisecond strictness to
`ROUND6_CONTROL_CUTOVER_AT`. No deployment watermark column is needed.

The migration keeps the existing guard: if `Approval` rows exist in a database
being upgraded without supervised backfill, fail deployment closed
(`ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED` extended to the new columns).
Adopt with an offline controlled Prisma migration, never `db push`. Prove fresh
PostgreSQL, existing-row upgrade, staged nullability/constraints, repeat
deployment, generated-client consistency, and drift detection. Proof explicitly
covers fresh databases; adopted databases with every existing operation; CHECK
acceptance/rejection for all operation/null combinations; repeated migration;
and drift detection for a missing, renamed, or textually/semantically altered
constraint.

## 14. Failure taxonomy, codes, and audit events

| Class | Durable result | Recovery |
|---|---|---|
| pre-approval local invariant corruption | Approval never written; no state transition | operator review |
| post-claim unrecoverable invariant/corruption or supervised terminal decision | attempt `FAILED`; Story supervised terminal failure posture; Conversation attached/non-IDLE; event PROCESSING | operator only; no automatic retry |
| repairable authentication/capability/config fault | attempt `RECONCILIATION_REQUIRED`; Story/Conversation PUBLISHING; event PROCESSING | repair, GET-first operator/reconciliation resume of same attempt |
| network/timeout/5xx/lost response | attempt `RECONCILIATION_REQUIRED`; Story/Conversation PUBLISHING; event PROCESSING | GET-before-action; no blind retry |
| uncertain external mutation | same attempt `RECONCILIATION_REQUIRED`; Story/Conversation PUBLISHING; DraftPreparation READY_FOR_APPROVAL; event PROCESSING | explicit supervised GET-first reconciliation only |
| version drift (CAS) | same attempt `RECONCILIATION_REQUIRED`; no publish | restore exact approved WP state and resume same attempt if provable, else supervised terminal failure |

Round 7 error codes include `APPROVAL_NOT_ELIGIBLE`, `APPROVAL_IDENTITY_CONFLICT`,
`APPROVAL_AMBIGUOUS`, `APPROVAL_PROMPT_NOT_SENT`, `APPROVAL_STATE_MISMATCH`,
`PUBLISH_ATTEMPT_CONFLICT`, `WORDPRESS_PUBLISH_BLOCKED`,
`WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED`, `PUBLISH_CAS_CONFLICT`, and reuse of
`WORDPRESS_STATE_MISMATCH`. Audit events follow snake_case:
`story_approval_requested`, `story_approval_rejected`, `story_approval_bound`,
`story_publish_started`, `story_publish_succeeded`,
`story_publish_reconciliation_required`, `story_publish_blocked`. AuditLog is
evidence, never state. Metadata is limited to IDs, version, applied-version,
numeric WP ids, statuses, and transitions. Errors/audits/logs never contain
headline/body/byline/caption, phone, token/secret, temporary URL, raw provider
payload, or bytes.

## 15. Security and production prerequisites

Preserve: HMAC-only separated draft/media authority with NO publish authority in
the draft/media surfaces; HTTPS DNS-pinned transport; manual redirects/no
cross-host HMAC; no Reporter URL; durable byte verification; ownership/ACTIVE/CAS
isolation; separate preview secret, token non-persistence; content-free telemetry;
canonical lock order; no external I/O in PostgreSQL transactions.

Activation requires, in addition to all Round 6 gates: deployed Round 7 publish
controller, isolated publication ledger, and frozen dedicated publisher identity;
deployed publish HMAC credential
(namespace `newsroom-publish-hmac-v1`); `ROUND7_CONTROL_CUTOVER_AT` present and
valid; publish driver backed by an always-running durable scheduler; WordPress
running the schema-version-bumped bridge; and the Round 8 generic recovery gate
for anything not reclaimable through Round 6/7 durable linkage. No activation
before all gates.

## 16. Future test/proof matrix

Require: bound ID and exact `/approve`; Phase-0 authoritative full-state WordPress
verification failure produces no Approval/attempt/transition; `/approve` pre-cutover/equal/after on
`receivedAt`; interactive reply-id only when bound prefix + prompt; text fallback
zero/one/multiple resolution (`APPROVAL_AMBIGUOUS`); `PENDING`/`SENDING`/`FAILED`
prompt cannot approve, `SENT`/`DELIVERED` can later qualify; second `/approve`
for same Story/event/prep impossible; `/revise` concurrently with `/approve` both
orders, exactly one wins, no deadlock, review blocked after approval; every
handoff (Round 6 §16) failure fails closed; durable Approval ⊣ PublishAttempt
binding; CAS `STALE_VERSION`/`STATE_MISMATCH`; cases A–E; publish crash matrix;
POST exact-PUBLISHED replay, conflicting-key rejection, RESERVED fail-closed GET/
POST behavior; operation/approvalId CHECK fresh/adopted/repeated/drift proof;
post-Approval category deactivation non-revocation and direct Story/category/media
mutation corruption;
expired-preview does not delay publishing and no token after `APPROVED`; no
external I/O in PG tx in approval; WordPress always draft until publish and never
any status other than `draft → publish` through publish surface; old draft/media
HMAC allowlists unchanged and cannot publish; frozen protected hashes unchanged;
fresh/adopted/repeated/drift PostgreSQL migration with `Approval` guard; Round 5/6
regressions; test before/equal/after cutover and no historical replay of
`PROCESSED` events.

## 17. Frozen minimum implementation plan

### 7B.0 — persistence/config prerequisites

Scope: approved Prisma delta (reserved Approval/PublishAttempt additions), env
`ROUND7_CONTROL_CUTOVER_AT`, migration/client with the `Approval`-row guard.
Non-goals: runtime approval, publish, controls. Schema: yes. WordPress: no.
Proof: fresh/adopted/repeated/drift PostgreSQL, constraints/concurrency,
startup-closed config. `/approve`: disabled.

### 7B.1 — WordPress publish authority and client

Scope: new publication table/upgrade, publish controller, publish HMAC
allowlist/client/canonical, frozen publisher identity/capability, bridge version
bump, Node publish client/transport. Non-goals: approval, saga. Prisma schema: no;
WordPress schema: yes, isolated. WordPress source: new non-frozen files only.
Proof: contract KATs, allowlist, capability denial, CAS, status transitions, DNS
pinning, disposable WP. `/approve`: disabled.

### 7B.2 — `/approve` control and approval transaction

Scope: exact routing/cutover, bound resolution, approval transaction, Approval and
PublishAttempt creation, Phase A driver re-entry, PROCESSING recovery for owned
events. Non-goals: WordPress publish call. Schema/WP source: no. Proof: handoff
matrix, races, prompt-status gate, idempotency, audit. `/approve`: disabled until
proof passes.

### 7B.3 — durable publish saga

Scope: claim, Conversation `AWAITING_APPROVAL → PUBLISHING → IDLE`, CAS GET/POST,
cases A–E, crash matrix, PENDING scan driver. Schema/WP source: no. Proof: full
case/crash matrix, concurrency, disposable WP, injected transport.

### 7B.4 — integration and activation

Scope: end-to-end behind all config gates, full matrix, regressions. Non-goals:
new editing controls, generic Round 8 recovery. Schema/WP source: no. Proof: all
§16 items plus Round 5/6 regressions. Controls stay disabled until this passes;
only then enable behind `ROUND7_CONTROL_CUTOVER_AT`.

## 18. Threat review

- TOCTOU between approval revalidation and publish: closed by server-side CAS
  (`expected_applied_version`) plus GET-before-action; a drifted draft can never
  publish as approved content.
- Duplicate publish: unique attempt idempotency + `approvalId` FK + immutable
  WordPress ledger binding; GET-before-retry prevents a second successful action.
- Stale approval after `/revise`: superseded preparation cannot resolve; Story
  status/version checks fail closed (§10).
- Lost HTTP response: Case A GET reads durable ledger authority; no blind retry.
- Pre-published post: Case C blocks; never un-publishes.
- PROCESSING recovery widening: only Round 7-owned events with durable
  Approval lineage resume (§12).
- Reconciliation widening: the ordinary scheduler never claims
  `RECONCILIATION_REQUIRED`; explicit supervision can only finalize the same
  attempt from ledger proof, resume it after exact safe repair, leave it blocked,
  or terminally fail it.
- Blind capabilities: publish-only credential + allowlist; draft/media surfaces
  cannot publish; no App Password/generic root.
- Deadlock: single canonical lock order shared by `/approve` and `/revise`.
- Cross-Reporter ownership: every transaction re-checks Reporter identity and
  Conversation ownership under lock.
- Reconciliation running inside PG transactions: none; all remote calls occur
  outside transactions.

## 19. Supervisor decisions

Decisions resolved by this document (freeze checklist):

1. `ROUND7_CONTROL_CUTOVER_AT` exists and gates approval controls: YES.
2. PublishAttempt carries durable Approval binding (`approvalId`): YES.
3. Minimal schema delta reserved in 7B.0: YES (Approval usage + publishing FK).
4. Protected CREATE files remain frozen; publish authority in new non-frozen
   files with new HMAC namespace: YES.
5. Isolated WordPress publish surface enforces CAS and the `draft → publish`
   state machine only: YES.
6. GET-before-retry for every uncertain publish outcome: YES.
7. `/revise` vs `/approve` race resolves by shared canonical lock order, exactly
   one wins: YES.
8. PROCESSING recovery restricted to Round-7-owned events with durable Approval
   lineage: YES.
9. Preview expiry does not force revision and does not gate publishing: YES.
10. Dedicated newsroom publisher service identity plus
    `publish_newsroom_publications`, usable only through the HMAC-controlled route,
    with existing technical author preserved: YES.
11. WordPress publication ledger distinguishes newsroom publication from manual
    publication and is created/upgraded only in approved 7B.1: YES.

BLOCKING SUPERVISOR DECISIONS: NONE

PRE-PRODUCTION ONLY: select/confirm the production publish-driver scheduler.
Publisher identity and capability are frozen here, not deferred choices.

## 20. Handoff from Round 6

Round 7 may act only when all Round 6 §16 conditions hold (ACTIVE Reporter; owned
`AWAITING_APPROVAL` Conversation pointing at Story; Story `AWAITING_APPROVAL`
for the Reporter; exactly one current `READY_FOR_APPROVAL`, non-SUPERSEDED
preparation matching Story version; reconciled post id; HMAC state GET with draft
status and matching applied version; all media reconciled; categories exact; safe
preview for the same epoch; explicit linked prompt `SENT`/`DELIVERED`; no blocked/
uncertain/reconciliation work remains) AND the approval control is cutover-eligible.
Only then may Round 7 create `Approval` bound to preparation, Story version, and
applied version. Never "approve whatever is current."

## 21. Deliverable and final report format

Round 7A produces exactly this document (the only worktree change) and one concise
consolidated correction report covering the supervisor's 15 requested items. The
verdict line reads exactly one of:

- `ROUND 7A APPROVAL/PUBLICATION ARCHITECTURE PASSED — READY FOR SUPERVISOR FREEZE`
- `ROUND 7A APPROVAL/PUBLICATION ARCHITECTURE BLOCKED — SUPERVISOR DECISION REQUIRED`

No implementation, commit, push, or deployment is part of Round 7A.
