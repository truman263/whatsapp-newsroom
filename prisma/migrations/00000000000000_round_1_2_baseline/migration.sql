-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ReporterStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('IDLE', 'AWAITING_HEADLINE', 'AWAITING_BODY', 'COLLECTING_MEDIA', 'AWAITING_APPROVAL', 'PUBLISHING');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "InboundEventType" AS ENUM ('TEXT', 'IMAGE', 'INTERACTIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "InboundProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "OutboundMessageType" AS ENUM ('TEXT', 'INTERACTIVE');

-- CreateEnum
CREATE TYPE "OutboundMessageStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('COLLECTING', 'READY', 'DRAFT_CREATING', 'DRAFT_CREATED', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "StoryMediaType" AS ENUM ('IMAGE');

-- CreateEnum
CREATE TYPE "MediaProcessingStatus" AS ENUM ('RECEIVED', 'FETCHING', 'FETCHED', 'UPLOADING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED');

-- CreateEnum
CREATE TYPE "PublishOperation" AS ENUM ('CREATE_DRAFT', 'PUBLISH');

-- CreateEnum
CREATE TYPE "PublishAttemptStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('REPORTER', 'SYSTEM');

-- CreateTable
CREATE TABLE "Reporter" (
    "id" UUID NOT NULL,
    "phoneNumber" VARCHAR(16) NOT NULL,
    "displayName" VARCHAR(200) NOT NULL,
    "status" "ReporterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Reporter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'IDLE',
    "currentStoryId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "providerMessageId" VARCHAR(191) NOT NULL,
    "reporterId" UUID,
    "senderPhone" VARCHAR(16) NOT NULL,
    "eventType" "InboundEventType" NOT NULL,
    "processingStatus" "InboundProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "rawPayload" JSONB NOT NULL,
    "providerOccurredAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMPTZ(3),
    "processedAt" TIMESTAMPTZ(3),
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(100),
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "storyId" UUID,
    "type" "OutboundMessageType" NOT NULL,
    "status" "OutboundMessageStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" VARCHAR(191),
    "correlationKey" VARCHAR(191) NOT NULL,
    "payload" JSONB NOT NULL,
    "sendAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(100),
    "lastErrorMessage" TEXT,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Story" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "status" "StoryStatus" NOT NULL DEFAULT 'COLLECTING',
    "headline" VARCHAR(500),
    "body" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "wordpressPostId" BIGINT,
    "wordpressDraftKey" UUID NOT NULL,
    "wordpressPostUrl" TEXT,
    "draftCreatedAt" TIMESTAMPTZ(3),
    "approvedAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryMedia" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "providerMediaId" VARCHAR(191) NOT NULL,
    "mediaType" "StoryMediaType" NOT NULL,
    "status" "MediaProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "mimeType" VARCHAR(150),
    "fileSizeBytes" BIGINT,
    "sha256" CHAR(64),
    "wordpressMediaId" BIGINT,
    "position" INTEGER NOT NULL,
    "caption" TEXT,
    "altText" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StoryMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "inboundEventId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'APPROVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" UUID NOT NULL,
    "storyId" UUID NOT NULL,
    "operation" "PublishOperation" NOT NULL,
    "status" "PublishAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(191) NOT NULL,
    "wordpressPostId" BIGINT,
    "httpStatus" INTEGER,
    "errorCode" VARCHAR(100),
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "reporterId" UUID,
    "storyId" UUID,
    "inboundEventId" UUID,
    "entityType" VARCHAR(100),
    "entityId" UUID,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- Prisma does not model PostgreSQL CHECK constraints declaratively. These
-- guards enforce non-negative counters/positions and positive attempt numbers.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_version_nonnegative" CHECK ("version" >= 0);

ALTER TABLE "InboundEvent"
    ADD CONSTRAINT "InboundEvent_processingAttempts_nonnegative" CHECK ("processingAttempts" >= 0);

ALTER TABLE "OutboundMessage"
    ADD CONSTRAINT "OutboundMessage_sendAttempts_nonnegative" CHECK ("sendAttempts" >= 0);

ALTER TABLE "Story"
    ADD CONSTRAINT "Story_version_nonnegative" CHECK ("version" >= 0);

ALTER TABLE "StoryMedia"
    ADD CONSTRAINT "StoryMedia_fileSizeBytes_nonnegative" CHECK ("fileSizeBytes" >= 0),
    ADD CONSTRAINT "StoryMedia_position_nonnegative" CHECK ("position" >= 0);

ALTER TABLE "PublishAttempt"
    ADD CONSTRAINT "PublishAttempt_attemptNumber_positive" CHECK ("attemptNumber" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "Reporter_phoneNumber_key" ON "Reporter"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_reporterId_key" ON "Conversation"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_currentStoryId_key" ON "Conversation"("currentStoryId");

-- CreateIndex
CREATE INDEX "InboundEvent_processingStatus_receivedAt_idx" ON "InboundEvent"("processingStatus", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundEvent_processingStatus_processingStartedAt_idx" ON "InboundEvent"("processingStatus", "processingStartedAt");

-- CreateIndex
CREATE INDEX "InboundEvent_senderPhone_idx" ON "InboundEvent"("senderPhone");

-- CreateIndex
CREATE INDEX "InboundEvent_reporterId_idx" ON "InboundEvent"("reporterId");

-- CreateIndex
CREATE INDEX "InboundEvent_receivedAt_idx" ON "InboundEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_provider_providerMessageId_key" ON "InboundEvent"("provider", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_providerMessageId_key" ON "OutboundMessage"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_correlationKey_key" ON "OutboundMessage"("correlationKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_requestedAt_idx" ON "OutboundMessage"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_reporterId_idx" ON "OutboundMessage"("reporterId");

-- CreateIndex
CREATE INDEX "OutboundMessage_storyId_idx" ON "OutboundMessage"("storyId");

-- CreateIndex
CREATE INDEX "OutboundMessage_requestedAt_idx" ON "OutboundMessage"("requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Story_wordpressPostId_key" ON "Story"("wordpressPostId");

-- CreateIndex
CREATE UNIQUE INDEX "Story_wordpressDraftKey_key" ON "Story"("wordpressDraftKey");

-- CreateIndex
CREATE INDEX "Story_reporterId_idx" ON "Story"("reporterId");

-- CreateIndex
CREATE INDEX "Story_status_createdAt_idx" ON "Story"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Story_createdAt_idx" ON "Story"("createdAt");

-- CreateIndex
CREATE INDEX "Story_publishedAt_idx" ON "Story"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoryMedia_providerMediaId_key" ON "StoryMedia"("providerMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "StoryMedia_wordpressMediaId_key" ON "StoryMedia"("wordpressMediaId");

-- CreateIndex
CREATE INDEX "StoryMedia_status_idx" ON "StoryMedia"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StoryMedia_storyId_position_key" ON "StoryMedia"("storyId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_storyId_key" ON "Approval"("storyId");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_inboundEventId_key" ON "Approval"("inboundEventId");

-- CreateIndex
CREATE INDEX "Approval_reporterId_idx" ON "Approval"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_idempotencyKey_key" ON "PublishAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishAttempt_storyId_createdAt_idx" ON "PublishAttempt"("storyId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishAttempt_status_createdAt_idx" ON "PublishAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PublishAttempt_operation_status_idx" ON "PublishAttempt"("operation", "status");

-- CreateIndex
CREATE INDEX "PublishAttempt_createdAt_idx" ON "PublishAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishAttempt_storyId_operation_attemptNumber_key" ON "PublishAttempt"("storyId", "operation", "attemptNumber");

-- CreateIndex
CREATE INDEX "AuditLog_storyId_occurredAt_idx" ON "AuditLog"("storyId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_reporterId_occurredAt_idx" ON "AuditLog"("reporterId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_inboundEventId_idx" ON "AuditLog"("inboundEventId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_currentStoryId_fkey" FOREIGN KEY ("currentStoryId") REFERENCES "Story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Story" ADD CONSTRAINT "Story_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryMedia" ADD CONSTRAINT "StoryMedia_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_inboundEventId_fkey" FOREIGN KEY ("inboundEventId") REFERENCES "InboundEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Reporter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_inboundEventId_fkey" FOREIGN KEY ("inboundEventId") REFERENCES "InboundEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- CreateEnum
CREATE TYPE "EditorialCategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Reporter" ADD COLUMN     "editorialByline" VARCHAR(200);

-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "byline" VARCHAR(200);

-- CreateTable
CREATE TABLE "EditorialCategory" (
    "id" UUID NOT NULL,
    "wordpressCategoryId" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(200) NOT NULL,
    "status" "EditorialCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EditorialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoryCategory" (
    "storyId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryCategory_pkey" PRIMARY KEY ("storyId","categoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EditorialCategory_wordpressCategoryId_key" ON "EditorialCategory"("wordpressCategoryId");

-- CreateIndex
CREATE INDEX "EditorialCategory_status_idx" ON "EditorialCategory"("status");

-- CreateIndex
CREATE INDEX "EditorialCategory_slug_idx" ON "EditorialCategory"("slug");

-- CreateIndex
CREATE INDEX "StoryCategory_categoryId_idx" ON "StoryCategory"("categoryId");

-- AddForeignKey
ALTER TABLE "StoryCategory" ADD CONSTRAINT "StoryCategory_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoryCategory" ADD CONSTRAINT "StoryCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "EditorialCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
