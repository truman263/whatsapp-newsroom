BEGIN;

-- Existing approvals have no trustworthy preparation epoch or WordPress state
-- fingerprint. Stop before any Round 6B.0 DDL rather than inventing authority.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "Approval" LIMIT 1) THEN
        RAISE EXCEPTION 'ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED';
    END IF;
END
$$;

CREATE TYPE "DraftPreparationStatus" AS ENUM (
    'ACTIVE',
    'RECONCILIATION_REQUIRED',
    'BLOCKED',
    'READY_FOR_APPROVAL',
    'SUPERSEDED',
    'FAILED'
);

ALTER TYPE "PublishOperation" ADD VALUE 'SYNC_DRAFT' BEFORE 'PUBLISH';

CREATE TABLE "DraftPreparation" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "inboundEventId" UUID NOT NULL,
    "storyVersion" INTEGER NOT NULL,
    "status" "DraftPreparationStatus" NOT NULL DEFAULT 'ACTIVE',
    "wordpressPostId" BIGINT,
    "wordpressAppliedVersion" CHAR(64),
    "approvalPromptCorrelationKey" VARCHAR(191) NOT NULL,
    "approvalPromptOutboundMessageId" UUID,
    "previewExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastErrorCode" VARCHAR(100),
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMPTZ(3),
    "supersededAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DraftPreparation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DraftPreparation_storyVersion_nonnegative" CHECK ("storyVersion" >= 0),
    CONSTRAINT "DraftPreparation_wordpressPostId_positive" CHECK ("wordpressPostId" IS NULL OR "wordpressPostId" > 0),
    CONSTRAINT "DraftPreparation_wordpressAppliedVersion_format" CHECK ("wordpressAppliedVersion" IS NULL OR "wordpressAppliedVersion" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "DraftPreparation_previewExpiresAt_after_startedAt" CHECK ("previewExpiresAt" > "startedAt")
);

ALTER TABLE "Approval"
    ADD COLUMN "draftPreparationId" UUID NOT NULL,
    ADD COLUMN "storyVersion" INTEGER NOT NULL,
    ADD COLUMN "wordpressAppliedVersion" CHAR(64) NOT NULL,
    ADD CONSTRAINT "Approval_storyVersion_nonnegative" CHECK ("storyVersion" >= 0),
    ADD CONSTRAINT "Approval_wordpressAppliedVersion_format" CHECK ("wordpressAppliedVersion" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "DraftPreparation_inboundEventId_key" ON "DraftPreparation"("inboundEventId");
CREATE UNIQUE INDEX "DraftPreparation_approvalPromptCorrelationKey_key" ON "DraftPreparation"("approvalPromptCorrelationKey");
CREATE UNIQUE INDEX "DraftPreparation_approvalPromptOutboundMessageId_key" ON "DraftPreparation"("approvalPromptOutboundMessageId");
CREATE UNIQUE INDEX "DraftPreparation_storyId_storyVersion_key" ON "DraftPreparation"("storyId", "storyVersion");
CREATE INDEX "DraftPreparation_status_updatedAt_idx" ON "DraftPreparation"("status", "updatedAt");
CREATE INDEX "DraftPreparation_storyId_status_idx" ON "DraftPreparation"("storyId", "status");

CREATE UNIQUE INDEX "Approval_draftPreparationId_key" ON "Approval"("draftPreparationId");
CREATE INDEX "Approval_storyVersion_idx" ON "Approval"("storyVersion");
CREATE INDEX "Approval_wordpressAppliedVersion_idx" ON "Approval"("wordpressAppliedVersion");

ALTER TABLE "DraftPreparation"
    ADD CONSTRAINT "DraftPreparation_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DraftPreparation_inboundEventId_fkey" FOREIGN KEY ("inboundEventId") REFERENCES "InboundEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "DraftPreparation_approvalPromptOutboundMessageId_fkey" FOREIGN KEY ("approvalPromptOutboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Approval"
    ADD CONSTRAINT "Approval_draftPreparationId_fkey" FOREIGN KEY ("draftPreparationId") REFERENCES "DraftPreparation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
