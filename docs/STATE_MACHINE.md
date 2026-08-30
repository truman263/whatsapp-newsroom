# Proposed state machines and concurrency contract

Round 1 persists high-level states but implements no transition service. Events, guards, authorization, recovery, and allowed transition graphs require later approval.

## Conversation states

- `IDLE`
- `AWAITING_HEADLINE`
- `AWAITING_BODY`
- `COLLECTING_MEDIA`
- `AWAITING_APPROVAL`
- `PUBLISHING`

Normal behavior requires `currentStoryId = null` while `IDLE`. During an active workflow it identifies a Story owned by the same Reporter. These cross-field and cross-row rules belong to deterministic application transitions.

## Story states

- `COLLECTING`
- `READY`
- `DRAFT_CREATING`
- `DRAFT_CREATED`
- `AWAITING_APPROVAL`
- `APPROVED`
- `PUBLISHING`
- `PUBLISHED`
- `CANCELLED`
- `FAILED`

## Optimistic compare-and-set

`Conversation.version` and `Story.version` start at zero. A later transition will use Prisma `updateMany` or an equivalent short transactional statement matching the identifier, expected status, and expected version while incrementing the version:

```sql
UPDATE "Story"
SET "status" = $next, "version" = "version" + 1
WHERE "id" = $id
  AND "status" = $expected_status
  AND "version" = $expected_version;
```

Exactly one affected row means the caller won the transition. Zero means it lost a race or used stale state and must reload and re-evaluate. This contract is not implemented as a generic optimistic-locking framework.

External WordPress or Meta calls must never be placed inside the PostgreSQL transaction that performs a compare-and-set transition.

Round 1.2 adds no state or transition. Later Story creation snapshots `Reporter.editorialByline ?? Reporter.displayName` into `Story.byline`; category collection supports multiple assignments and assumes no primary category. A later publication guard must require at least one `ACTIVE` category, but that guard is intentionally deferred.
