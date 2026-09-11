# Round 4 — Reporter authorisation and deterministic conversation state machine

**Status: ARCHITECTURE FREEZE — awaiting supervisor review**

## 1. Scope and non-goals

Round 4 establishes database-backed Reporter authorisation, controlled operator provisioning, exactly one Conversation per authorised Reporter, a deterministic transition primitive, and replay-safe downstream handling of durable Round 3 `InboundEvent` records.

Round 4 is database-only. It does not interpret messages as headlines, bodies, categories, media, approvals, or publication instructions. It creates no Story, StoryMedia, Approval, OutboundMessage, or PublishAttempt record and makes no Meta, WordPress, Simbidzebasa, Supabase, AI, or other external call. Round 3 webhook authentication, normalisation, persistence, acknowledgement, and deduplication remain unchanged.

## 2. Existing architecture and Round 3 handoff

The schema already contains `Reporter`, `Conversation`, `InboundEvent`, `Story`, and `AuditLog`, with the relevant enums `ReporterStatus`, `ConversationState`, and `InboundProcessingStatus`.

The frozen persistence primitives are:

- `Reporter.phoneNumber` is unique.
- `Conversation.reporterId` is unique, enforcing at most one Conversation per Reporter.
- `Conversation.currentStoryId` is nullable and unique, preventing one Story from being current in two Conversations.
- `Conversation.version` defaults to zero and is the optimistic-concurrency token.
- `InboundEvent(provider, providerMessageId)` is unique.
- indexes support work discovery by processing status and time.

The current exact lifecycle is: the controller authenticates the raw Meta request signature, the normaliser validates and canonicalises the sender as E.164 `senderPhone`, and ingestion performs `InboundEvent.createMany({ skipDuplicates: true })`. New rows default to `RECEIVED`; ingestion explicitly writes `reporterId: null`. Only after durable persistence does the webhook return its acknowledgement. Duplicate provider messages produce no second row.

Round 4B must add a downstream, non-HTTP processing service. That service—not the webhook controller or ingestion service—owns event claiming, Reporter authorisation, association, Conversation provisioning, and terminal processing status for the Round 4 responsibility. Round 3 source remains unchanged.

## 3. Reporter authorisation model

`Reporter` is an explicit database allowlist. The sole identity key is the canonical E.164 `InboundEvent.senderPhone` emitted by Round 3. No sender may self-register through a webhook.

| Lookup result | Authorised | Associate `InboundEvent.reporterId` | Provision Conversation | Event result |
| --- | --- | --- | --- | --- |
| no Reporter for phone | no | no | no | `IGNORED` / `REPORTER_UNKNOWN` |
| Reporter is `INACTIVE` | no | no | no | `IGNORED` / `REPORTER_INACTIVE` |
| Reporter is `ACTIVE` | yes | yes | get or create | `PROCESSED` after Round 4 work succeeds |

Authorisation is checked for every claimed event. An existing Conversation does not bypass the check: once a Reporter is inactive, later events are ignored and the existing Conversation remains durable but inaccessible to message processing. Reactivation restores authorisation without replacing either Reporter or Conversation.

An event's authorised identity is immutable after association. A processing attempt must fail closed if a non-null `reporterId` differs from the Reporter resolved from the event's frozen `senderPhone`; it must never rewrite the association. A phone change is not an update to identity: provision the new unique E.164 number as a deliberate operator action and deactivate the old Reporter. Automatic phone reassignment or merging is out of scope because it would weaken historical attribution.

## 4. Controlled Reporter provisioning

Round 4B should expose operator-only local application commands, not HTTP endpoints:

- `reporter provision --phone <E.164> --display-name <name> [--editorial-byline <byline>]`
- `reporter deactivate --phone <E.164>`
- `reporter reactivate --phone <E.164>`

The command adapter calls a `ReporterProvisioningService`; it contains no database logic itself. Inputs are explicit allowlisted fields rather than an arbitrary object. Phone validation uses `^\+[1-9][0-9]{6,14}$`, trims human-readable fields, rejects blank or overlength values, never accepts an ID/status/relationship through mass assignment, and never prints secrets or raw records.

Provision has create-only semantics. A new phone creates an `ACTIVE` Reporter and an AuditLog in one transaction. An existing phone is a deterministic conflict: if supplied fields match, report `ALREADY_EXISTS` without mutation; otherwise report `REPORTER_CONFLICT`. It must not silently reactivate or overwrite names. Deactivate and reactivate use conditional status updates, preserve the Reporter ID, are idempotent when already in the requested state, and audit only actual changes. Display/byline changes, if later required, need a separate explicit command.

Conversation creation is lazy on the first successfully authorised newsroom event. This avoids durable Conversations for provisioned Reporters who never interact, keeps provisioning focused on allowlist administration, and exercises the same concurrency-safe path for every first interaction.

## 5. Conversation provisioning

Within the authorisation transaction, Round 4B first locks the resolved Reporter row (`SELECT ... FOR UPDATE`) and verifies it is still `ACTIVE`. Reporter deactivate/reactivate operations lock or update that same row, so authorisation and status changes serialize at the Reporter boundary under PostgreSQL `READ COMMITTED`.

The provisioning service then attempts to create an `IDLE`, version-zero Conversation for the Reporter. `Conversation.reporterId @unique` is the authority under concurrency. The required explicit, testable strategy is one parameterised Prisma raw statement using PostgreSQL conflict handling:

1. generate the candidate UUID in application code;
2. execute `INSERT INTO "Conversation" (...) VALUES (...) ON CONFLICT ("reporterId") DO NOTHING RETURNING ...` inside the transaction;
3. if a row is returned, this transaction provisioned it and writes the provisioning audit;
4. if none is returned, read the committed winner by unique `reporterId` in the same transaction;
5. validate that the returned Conversation belongs to the locked Reporter.

The query must use Prisma's tagged-template parameterisation, name the `reporterId` conflict target, and set all required ID/timestamp/default values explicitly. No arbitrary SQL fragments are accepted. A caught Prisma `P2002` is not used as the in-transaction recovery mechanism because PostgreSQL aborts the transaction after an unhandled unique-violation statement. No check-then-create result is trusted, no empty-update upsert is allowed to touch `updatedAt`, and no process-local lock is used. Concurrent transactions may observe a unique-conflict wait, but after the winner commits every loser reads the same durable row. The result is exactly one Conversation per Reporter.

## 6. State-machine transition graph

Round 4B implements and proves the primitive but invokes no workflow transition for inbound content. Later rounds own the following allowlist:

| From | To | Owning round/purpose | `currentStoryId` rule |
| --- | --- | --- | --- |
| `IDLE` | `AWAITING_HEADLINE` | Round 5 starts collection | later domain service atomically creates/attaches the Reporter's Story |
| `AWAITING_HEADLINE` | `AWAITING_BODY` | Round 5 | preserve same Story |
| `AWAITING_BODY` | `COLLECTING_MEDIA` | Round 5 | preserve same Story |
| `COLLECTING_MEDIA` | `AWAITING_APPROVAL` | Round 6 completeness/preview boundary | preserve same Story |
| `AWAITING_APPROVAL` | `COLLECTING_MEDIA` | Round 6 explicit revision path | preserve same Story |
| `AWAITING_APPROVAL` | `PUBLISHING` | Round 7 explicit approval path | preserve same Story |
| `AWAITING_HEADLINE`, `AWAITING_BODY`, `COLLECTING_MEDIA`, `AWAITING_APPROVAL` | `IDLE` | later explicit cancel/terminal reset | atomically clear Story |
| `PUBLISHING` | `IDLE` | Round 7 only after reconciled terminal outcome | atomically clear Story |

Every other edge, including self-transitions and backward transitions not listed above, is invalid and fails closed before issuing an update. `PUBLISHING` must never be rolled back to an earlier collection state because external publication outcome may be uncertain. Later rounds must specify their domain preconditions in addition to this graph; inclusion here grants no Round 4 permission to perform Story work.

## 7. Compare-and-set contract

The authoritative database API is transaction-scoped and narrowly typed:

```text
transitionInTransaction(
  tx,
  {
    conversationId,
    reporterId,
    expectedState,
    expectedVersion,
    targetState,
    storyMutation: PRESERVE | ATTACH(storyId) | CLEAR,
    inboundEventId? (provenance only)
  }
)
```

`tx` is an existing Prisma transaction client. The primitive must not unconditionally open an independent transaction. This permits a later domain service to compose Story creation, ownership validation, attachment, Conversation CAS, and audit as one atomic transaction. A convenience wrapper may open a transaction for standalone callers, but it must delegate to `transitionInTransaction`; the transaction-scoped primitive is authoritative.

It rejects a negative/non-integer version, a disallowed edge, an incompatible Story mutation, or absent caller ownership before touching the Conversation. For `ATTACH(storyId)`, the primitive itself queries with the supplied `tx` and requires a Story matching both `id = storyId` and `reporterId = reporterId`. A missing Story or cross-Reporter Story fails closed before CAS. The ownership read, Conversation CAS, and transition audit therefore share the caller's transaction. The database operation is a conditional `updateMany` equivalent to:

```sql
UPDATE "Conversation"
SET state = :target_state,
    version = version + 1,
    "currentStoryId" = :validated_story_value,
    "updatedAt" = now()
WHERE id = :conversation_id
  AND "reporterId" = :reporter_id
  AND state = :expected_state
  AND version = :expected_version;
```

Exactly one affected row is success. Zero rows is `STALE_CONVERSATION` unless a diagnostic read establishes `NOT_FOUND` or ownership mismatch; neither condition causes a write. Each success increments version exactly once. There is no last-write-wins path.

For 20 identical contenders, one succeeds and 19 receive a stale conflict. For conflicting targets from the same expected state/version, one valid contender succeeds and all others receive a stale conflict. A caller may reread and reconsider only from fresh state; it must not blindly retry the old command or automatically translate the user's original intent. CAS conflicts are expected control outcomes, not `FAILED` InboundEvents by themselves; the owning workflow decides whether fresh-state replay means already satisfied, ignored, or a new explicit transition.

## 8. `currentStoryId` invariants

An `IDLE` Conversation has `currentStoryId = NULL`. Every non-`IDLE` workflow state requires one non-null current Story. That Story must have `Story.reporterId = Conversation.reporterId`.

The state-machine API cannot accept an arbitrary nullable Story field. `ATTACH` is required and legal only on `IDLE -> AWAITING_HEADLINE`; `PRESERVE` is required on every non-IDLE to non-IDLE transition and must retain the current value; `CLEAR` is required on every transition to `IDLE`. The Round 4B primitive—not a future caller—must validate an attached Story's existence and matching Reporter ownership inside the same transaction as CAS. A database foreign key alone does not prove same-Reporter ownership. General callers and provisioning services cannot bypass the discriminated mutation operation.

Round 4B does not create Stories and its production inbound path does not attach one. Its database tests use fixtures to prove same-Reporter attachment, missing/cross-Reporter rejection, and atomic rollback. Round 5 owns Story creation and invokes the already-safe `transitionInTransaction` within the transaction that creates the Story.

## 9. InboundEvent claim, replay, and association

Work discovery is only a hint. Ownership is obtained with one conditional database update:

```text
where: id = eventId AND processingStatus = RECEIVED
set: processingStatus = PROCESSING,
     processingStartedAt = now,
     processingAttempts = processingAttempts + 1,
     processedAt = null,
     lastErrorCode = null,
     lastErrorMessage = null
```

Exactly one affected row owns the attempt. Zero means another worker won or the event is already terminal/in progress; the caller performs no side effect. Service code continues only from its own successful claim. Round 3's provider-message unique key prevents duplicate durable events, while the conditional claim prevents two workers from processing one durable event concurrently.

Claim is a short transaction and commits before work. A crash after claim intentionally leaves `PROCESSING` evidence; Round 4 must not pretend this is exactly once. Round 8 will select stale claims using `processingStartedAt`, apply a bounded recovery policy, and conditionally reset/reclaim them while preserving/incrementing attempt history. Until then, stale `PROCESSING` rows require explicit operator diagnosis and are never automatically stolen.

After claim, a second transaction locks the event row, requires `PROCESSING`, and resolves Reporter by the event's stored canonical phone. For an active Reporter it locks the Reporter row, rechecks status, conditionally associates `reporterId` only if null (or verifies the identical existing ID), provisions/reads the Conversation, creates the appropriate non-sensitive audits, and marks the event `PROCESSED` with `processedAt = now` atomically. Thus no committed state can claim successful Round 4 processing without its association and Conversation.

`InboundEvent.PROCESSED` means: **all processing stages enabled in the current application pipeline completed successfully for this event.** In Round 4B, the enabled downstream pipeline ends after claim, authorisation, Reporter association, Conversation provisioning, and Round 4 audits, so it may then mark the event `PROCESSED`. When Round 5 enables Story/message handling, the same orchestrator must execute that stage before the same terminal `PROCESSED` transition. Round 5 must not introduce a second processor that scans historical Round 4 `PROCESSED` events. Previously processed events remain historical evidence and are not implicitly replayed merely because new capability is deployed.

For unknown/inactive senders, that same second transaction leaves `reporterId` null, creates one ignored-event audit, and marks the event `IGNORED` with `processedAt = now` and a fixed reason code. A retry sees a terminal status and performs no second audit or side effect. Concurrent operator provisioning has a deterministic serialization point: the event is authorised only if the service locks an active Reporter during its authorisation transaction; an unknown lookup may be ignored even if provisioning commits just afterward, which accurately records the allowlist decision at processing time.

## 10. Transaction boundaries

| Boundary | Atomic operations | Reason |
| --- | --- | --- |
| operator provisioning/status transaction | lock/create/update Reporter plus AuditLog | status and its audit cannot diverge |
| claim transaction | conditional `RECEIVED -> PROCESSING`, timestamp, attempt increment, prior diagnostic clear | one claimant; transaction stays short |
| authorised processing transaction | lock event; active Reporter lookup/lock; immutable association; Conversation get-or-create; authorisation/conversation audits; `PROCESSING -> PROCESSED` | successful terminal event cannot exist without its authorised identity and Conversation |
| ignored processing transaction | lock event; negative/inactive decision; ignored audit; `PROCESSING -> IGNORED` | decision, durable evidence, and terminal status agree |
| later workflow transaction | lock/read required domain rows; validate Story ownership; CAS transition; transition audit; workflow mutation | domain write and state transition cannot partially commit |

No external HTTP or slow application work belongs in a transaction. Default PostgreSQL `READ COMMITTED`, row locks on the event/Reporter where described, unique constraints, and conditional updates are sufficient; global `SERIALIZABLE` isolation is neither required nor recommended.

A transient database error rolls back the current transaction. If the claim transaction failed, the row remains `RECEIVED`; if a later transaction failed, it remains `PROCESSING` for Round 8 recovery. The processor does not respond to Meta; webhook acknowledgement already ended at durable Round 3 ingestion.

Round 4B implements the deterministic downstream services and database behavior, but worker scheduling and operational activation are separate from Round 3's durable-ingestion contract. Round 4B must not modify the webhook, launch a fire-and-forget promise after HTTP acknowledgement, or make webhook success depend on downstream authorisation. Integration/runtime acceptance invokes the processor directly. A later approved worker/runner may schedule it without changing the webhook contract; it still may not place Meta or WordPress calls in this pipeline.

## 11. Ignored and failure semantics

- `IGNORED` is an intentional terminal policy outcome: unknown Reporter, inactive Reporter, or (in later workflow code) an explicitly unsupported/non-actionable event. It is not retried automatically.
- `FAILED` is a terminal processing failure after a bounded retry/recovery policy or a deterministic poison/invariant condition that cannot safely continue. Round 4B should not mark transient database errors `FAILED` if its failure transaction cannot be made atomically; leave the claimed event `PROCESSING` for Round 8 recovery.
- `STALE_CONVERSATION` is an expected CAS control result. It is neither an event status nor automatically an application failure.
- temporary database errors are retriable infrastructure failures; transaction rollback and claim state determine the recovery path.
- programming/invariant errors fail closed, emit redacted operational diagnostics, and do not guess a replacement transition. A safe, explicit failure marker may be added only when the event row can be updated in a separate controlled transaction.

The existing `lastErrorCode` is the only machine-readable terminal diagnostic field and is sufficient for both ignored reason codes and failure codes. For `IGNORED`, use fixed values such as `REPORTER_UNKNOWN` and `REPORTER_INACTIVE`; keep `lastErrorMessage` null. For actual failures, use a fixed code and a redacted bounded message—never raw payload, message content, phone number, or secrets. `processedAt` records terminal handling for `PROCESSED`, `IGNORED`, and `FAILED`.

## 12. Audit strategy

Audit event names are compile-time constants and metadata is built by the service, never accepted from CLI/webhook input.

| Action | `actorType` | IDs/metadata | Audit policy |
| --- | --- | --- | --- |
| Reporter provisioned/deactivated/reactivated | `SYSTEM` | `reporterId`, entity Reporter; old/new status where applicable | one record per actual mutation |
| inbound authorised | `REPORTER` | `reporterId`, `inboundEventId`, entity InboundEvent | one record in terminal processing transaction |
| inbound ignored | `SYSTEM` | `inboundEventId`, entity InboundEvent, fixed reason code | one record; no Reporter ID for unknown/inactive actor |
| Conversation provisioned | `SYSTEM` | `reporterId`, entity Conversation | only the transaction that creates the row |
| Conversation transitioned | `REPORTER` for an attributed inbound action, otherwise `SYSTEM` | Reporter/Story/InboundEvent IDs as applicable; from/to/version before/version after | only on successful CAS, in the domain transaction |

Routine CAS conflicts create structured redacted logs/metrics, not durable AuditLog rows: they made no state change and race tests would create misleading noise. Escalated invariant/security violations may receive a separate fixed system audit event. Audit metadata contains no raw WhatsApp payload, message body, secrets, or duplicate phone number.

## 13. Security analysis

| Threat/finding | Control | Classification after control |
| --- | --- | --- |
| webhook self-registration | no Reporter creation in inbound path; operator-only CLI | LOW |
| inactive Reporter bypass | status check on every event while Reporter row is locked | LOW |
| confused deputy/cross-Reporter Conversation access | command includes Reporter identity and CAS predicate includes `reporterId` | LOW |
| cross-Reporter Story attachment | Round 4B primitive validates Story ID and Reporter ownership using the caller's transaction before CAS | LOW after required Round 4B proof |
| stale overwrite | state-and-version CAS; affected-row count must equal one | LOW |
| replay duplicate side effects | ingestion uniqueness, conditional event claim, terminal status, atomic effects/completion | LOW, with abandoned `PROCESSING` recovery explicitly deferred |
| concurrent Conversation creation | PostgreSQL unique constraint plus conflict handling | LOW |
| audit spoofing | fixed event names/metadata allowlists; actor derived from authorisation | LOW |
| sensitive logging | redacted fixed diagnostics; no payload/body/phone in audit metadata | LOW |
| mass assignment | explicit typed command fields and state-machine mutation union | LOW |
| unsafe Prisma upsert/error recovery | parameterised `INSERT ... ON CONFLICT ("reporterId") DO NOTHING RETURNING`; no empty update and no catch-after-abort | LOW |

No CRITICAL, HIGH, or blocking MEDIUM architecture finding remains. Cross-Reporter and missing-Story rejection are required Round 4B properties of the primitive and must be proven before Round 4B can pass. Abandoned `PROCESSING` recovery is a non-blocking MEDIUM deliberately deferred to Round 8.

## 14. Schema sufficiency verdict

**Decision A: the existing Prisma schema is sufficient for Round 4B.**

Existing statuses, timestamps, attempt/error fields, nullable Reporter association, uniqueness constraints, indexes, version token, relationships, and AuditLog fields support the design. No schema or migration change is justified for Round 4B.

The schema does not encode `Conversation.reporterId = Story.reporterId` as a composite database constraint. The Round 4B transaction-scoped primitive is sufficient because it must query the Story by both ID and Reporter and perform attachment CAS with the same transaction client. Round 4B production processing creates and attaches no Story, while its database fixtures prove this invariant. If a later supervisor requires a database-level composite constraint in addition to this service invariant, that would be a separate schema decision and must not be smuggled into Round 4B.

## 15. Exact Round 4B implementation plan

Add one isolated Nest module, leaving `whatsapp-webhook` untouched:

- `apps/api/src/modules/reporter-workflow/reporter-workflow.module.ts` — provider wiring only; no public controller.
- `reporter-provisioning.service.ts` — create/deactivate/reactivate transactions and audits.
- `reporter-authorization.service.ts` — canonical-phone lookup, row locking, ACTIVE decision, immutable association.
- `conversation-provisioning.service.ts` — parameterised insert-on-conflict/read exactly-one logic.
- `conversation-state-machine.ts` — pure transition graph and typed Story mutation validation.
- `conversation-state-machine.service.ts` — authoritative `transitionInTransaction(tx, command)`, Story existence/ownership validation, database CAS, successful-transition audit, and an optional delegating transaction wrapper.
- `inbound-event-processing.service.ts` — claim and terminal Round 4 authorisation orchestration.
- `reporter-workflow.errors.ts` and `reporter-workflow.types.ts` — stable internal result/error contracts.
- `apps/api/src/commands/reporter.command.ts` (and the smallest command bootstrap required by repository conventions) — operator-only adapter with explicit validated arguments.

Modify only `apps/api/src/app.module.ts` to import the module and the root/package command wiring needed to expose the local command. Do not import Round 4 services into the webhook module and do not add an HTTP controller.

Add unit tests beside each pure/service file for validation, status decisions, transition allowlist, invalid edges, transaction-client delegation, error mapping, redaction, and no-op idempotency. Add `apps/api/test/reporter-workflow.db-spec.ts` for disposable PostgreSQL transaction and concurrency proofs, including Story ownership validation and CAS sharing one rollback boundary. Add a focused CLI integration test proving local invocation, deterministic exit/result codes, and absence of secret/phone leakage beyond the operator's intentional input policy. Update operational documentation only as necessary for local command use. Processor tests invoke the service directly; Round 4B adds no webhook-triggered background execution.

## 16. Round 4B runtime and concurrency acceptance matrix

All database races use disposable PostgreSQL and independent Prisma clients/connections—not mocked Prisma and not promises sharing one transaction.

| Proof | Required observation |
| --- | --- |
| unknown Reporter | event becomes `IGNORED/REPORTER_UNKNOWN`; null Reporter; no Conversation |
| inactive Reporter | event becomes `IGNORED/REPORTER_INACTIVE`; null association; existing/no Conversation unchanged |
| active Reporter | deterministic association; one `IDLE` Conversation; event `PROCESSED` |
| duplicate provisioning | one Reporter; identical retry `ALREADY_EXISTS`; conflicting fields `REPORTER_CONFLICT`; no silent update |
| deactivate/reactivate | conditional idempotency; only actual changes audited; ID preserved; authorisation follows current status |
| concurrent Conversation provisioning | at least 20 independent contenders all return the same Conversation ID; table count is one |
| CAS success | matching ID/Reporter/state/version changes allowed state and increments version exactly once |
| stale CAS | zero writes, stable `STALE_CONVERSATION`, no transition audit |
| 20-way identical CAS | exactly one success, 19 stale results, one version increment, one audit |
| 20-way conflicting CAS | exactly one allowed target commits, 19 stale results, no overwritten winner |
| invalid transition | rejected before write; state/version unchanged |
| cross-Reporter isolation | wrong Reporter cannot read-transition another Conversation or attach its Story |
| same-Reporter `ATTACH` | `IDLE -> AWAITING_HEADLINE` succeeds with an existing Story owned by the command Reporter |
| cross-Reporter `ATTACH` | fails closed; Conversation state/version/current Story and audit remain unchanged |
| nonexistent-Story `ATTACH` | fails closed with the same no-write guarantee |
| misplaced `ATTACH` | any transition other than `IDLE -> AWAITING_HEADLINE` fails before CAS |
| required `ATTACH` | `IDLE -> AWAITING_HEADLINE` without `ATTACH` fails before CAS |
| `PRESERVE` | required for non-IDLE to non-IDLE and cannot silently change `currentStoryId` |
| `CLEAR` | required for every return to `IDLE`; other mutation operations fail |
| ownership/CAS atomicity | injected failure proves Story lookup/domain work, CAS, and audit roll back together through the supplied transaction client |
| conditional claim race | 20 contenders yield exactly one `RECEIVED -> PROCESSING` winner and one attempt increment |
| replay/terminal event | duplicate provider message has one row; reprocessor cannot reclaim terminal/in-progress event; no duplicate audit/effect |
| immutable association | same Reporter retry is accepted as existing provenance; different Reporter fails closed and does not rewrite |
| transaction rollback | injected failure before terminal update rolls back association, Conversation, audit, and terminal status together; claimed row remains `PROCESSING` |
| status-change race | Reporter lock serializes deactivate/reactivate with authorisation; committed result matches lock order |
| ignored versus failed | fixed reason codes and terminal timestamps are distinct; transient DB error is not mislabeled ignored/failed |
| scope negatives | zero Story, StoryMedia, Approval, OutboundMessage, and PublishAttempt creation |
| integration negatives | no Meta/WordPress/Supabase/network calls and no public endpoint |
| redaction | logs/audits contain no secrets, raw payload, message content, or unnecessary phone duplication |

Also run typecheck, focused unit tests, focused e2e/DB tests, `git diff --check`, and a final source-boundary audit. Do not run `prisma db push`; apply the existing migration baseline to the disposable database by the repository's approved test setup.

## 17. Deferred responsibilities

Round 4B owns the safe, transaction-aware attachment primitive and its Story existence/ownership checks, but creates no production Story. Round 5 owns Story creation, headline/body/category/media interpretation, and composes that creation with the already-safe Round 4B primitive in one transaction. Round 6 owns completeness, draft preview/review, and revision movement. Round 7 owns approval and publication transitions. Round 8 owns stale `PROCESSING` detection/recovery, bounded retries, hardening, and operational alerting. None is implied by this architecture freeze.

## 18. Architecture freeze

Round 4B must preserve these decisions: explicit allowlist; no inbound self-registration; authorise every event; lazy Conversation provisioning; PostgreSQL uniqueness as concurrency authority; short conditional claim; atomic association/provision/completion; state-and-version CAS; restricted Story mutation; fail-closed errors; fixed redacted audits; no external calls; and no Round 5+ behavior.
