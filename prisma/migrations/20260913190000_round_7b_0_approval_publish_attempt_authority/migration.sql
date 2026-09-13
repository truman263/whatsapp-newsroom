BEGIN;

-- Existing approvals predate the approved one-to-one publication authority.
-- Stop rather than infer a PublishAttempt relationship from Story identity.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "Approval" LIMIT 1) THEN
        RAISE EXCEPTION 'ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "PublishAttempt"
        WHERE "operation" = 'PUBLISH'::"PublishOperation"
        LIMIT 1
    ) THEN
        RAISE EXCEPTION 'ROUND_7B_0_PUBLISH_AUTHORITY_BACKFILL_REQUIRED';
    END IF;
END
$$;

ALTER TABLE "PublishAttempt"
    ADD COLUMN "approvalId" UUID;

CREATE UNIQUE INDEX "PublishAttempt_approvalId_key"
    ON "PublishAttempt"("approvalId");

ALTER TABLE "PublishAttempt"
    ADD CONSTRAINT "PublishAttempt_approvalId_fkey"
        FOREIGN KEY ("approvalId") REFERENCES "Approval"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "PublishAttempt_operation_approval_authority_check"
        CHECK (
            (
                "operation" = 'PUBLISH'::"PublishOperation"
                AND "approvalId" IS NOT NULL
            )
            OR
            (
                "operation" IN (
                    'CREATE_DRAFT'::"PublishOperation",
                    'SYNC_DRAFT'::"PublishOperation"
                )
                AND "approvalId" IS NULL
            )
        );

COMMIT;
