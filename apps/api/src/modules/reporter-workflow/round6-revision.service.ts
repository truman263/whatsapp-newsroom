import { Injectable, Optional } from "@nestjs/common";
import {
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  InboundProcessingStatus,
  OutboundMessageType,
  Prisma,
  ReporterStatus,
  StoryStatus,
} from "@prisma/client";
import { ConversationStateMachineService } from "./conversation-state-machine.service";

const SHA256 = /^[0-9a-f]{64}$/u;

export class Round6RevisionError extends Error {
  readonly code = "STORY_REVISION_CONFLICT";

  constructor() {
    super("Story revision authority conflict.");
  }
}

export type ReviseInput = {
  inboundEventId: string;
  reporterId: string;
  conversationId: string;
  storyId: string;
  expectedStoryVersion: number;
};

@Injectable()
export class Round6RevisionService {
  constructor(
    private readonly conversations: ConversationStateMachineService,
    @Optional() private readonly authorityLocked?: () => void,
  ) {}

  async reviseInTransaction(
    tx: Prisma.TransactionClient,
    input: ReviseInput,
  ): Promise<{ reporterId: string; conversationId: string }> {
    const preparationHint = await tx.draftPreparation.findUnique({
      where: {
        storyId_storyVersion: {
          storyId: input.storyId,
          storyVersion: input.expectedStoryVersion,
        },
      },
      select: { id: true, approvalPromptOutboundMessageId: true },
    });
    if (!preparationHint?.approvalPromptOutboundMessageId)
      throw new Round6RevisionError();

    await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${input.inboundEventId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Reporter" WHERE "id"=${input.reporterId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${input.conversationId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${input.storyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT ec."id" FROM "EditorialCategory" ec JOIN "StoryCategory" sc ON sc."categoryId"=ec."id" WHERE sc."storyId"=${input.storyId}::uuid ORDER BY ec."id" FOR UPDATE OF ec`;
    await tx.$queryRaw`SELECT "storyId","categoryId" FROM "StoryCategory" WHERE "storyId"=${input.storyId}::uuid ORDER BY "storyId","categoryId" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "storyId"=${input.storyId}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${preparationHint.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${preparationHint.approvalPromptOutboundMessageId}::uuid FOR UPDATE`;
    const approvals = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "Approval" WHERE "storyId"=${input.storyId}::uuid ORDER BY "id" FOR UPDATE`;
    const publishAttempts = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "PublishAttempt" WHERE "storyId"=${input.storyId}::uuid AND "operation"='PUBLISH'::"PublishOperation" ORDER BY "id" FOR UPDATE`;
    this.authorityLocked?.();

    const event = await tx.inboundEvent.findUnique({
      where: { id: input.inboundEventId },
    });
    const reporter = await tx.reporter.findUnique({
      where: { id: input.reporterId },
    });
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
    });
    const story = await tx.story.findUnique({ where: { id: input.storyId } });
    const preparation = await tx.draftPreparation.findUnique({
      where: { id: preparationHint.id },
      include: { approvalPromptOutboundMessage: true },
    });
    const prompt = preparation?.approvalPromptOutboundMessage;
    const payload = prompt?.payload as Record<string, unknown> | undefined;
    if (
      approvals.length !== 0 ||
      publishAttempts.length !== 0 ||
      !event ||
      event.processingStatus !== InboundProcessingStatus.PROCESSING ||
      event.reporterId !== input.reporterId ||
      !reporter ||
      reporter.status !== ReporterStatus.ACTIVE ||
      !conversation ||
      conversation.reporterId !== input.reporterId ||
      conversation.currentStoryId !== input.storyId ||
      conversation.state !== ConversationState.AWAITING_APPROVAL ||
      !story ||
      story.reporterId !== input.reporterId ||
      story.status !== StoryStatus.AWAITING_APPROVAL ||
      story.version !== input.expectedStoryVersion ||
      !story.wordpressPostId ||
      !preparation ||
      preparation.status !== DraftPreparationStatus.READY_FOR_APPROVAL ||
      preparation.storyId !== story.id ||
      preparation.storyVersion !== story.version ||
      preparation.wordpressPostId !== story.wordpressPostId ||
      !preparation.wordpressAppliedVersion ||
      !SHA256.test(preparation.wordpressAppliedVersion) ||
      preparation.approvalPromptOutboundMessageId !== prompt?.id ||
      !prompt ||
      prompt.reporterId !== reporter.id ||
      prompt.storyId !== story.id ||
      prompt.type !== OutboundMessageType.INTERACTIVE ||
      prompt.correlationKey !== preparation.approvalPromptCorrelationKey ||
      payload?.kind !== "APPROVAL_PROMPT_V1" ||
      payload.draftPreparationId !== preparation.id ||
      payload.storyId !== story.id ||
      payload.storyVersion !== story.version ||
      payload.wordpressAppliedVersion !== preparation.wordpressAppliedVersion
    )
      throw new Round6RevisionError();

    const now = new Date();
    await tx.draftPreparation.update({
      where: { id: preparation.id },
      data: {
        status: DraftPreparationStatus.SUPERSEDED,
        supersededAt: now,
      },
    });
    const storyChanged = await tx.story.updateMany({
      where: {
        id: story.id,
        reporterId: reporter.id,
        status: StoryStatus.AWAITING_APPROVAL,
        version: story.version,
      },
      data: {
        status: StoryStatus.COLLECTING,
        version: { increment: 1 },
      },
    });
    if (storyChanged.count !== 1) throw new Round6RevisionError();
    const transition = await this.conversations.transitionInTransaction(tx, {
      conversationId: conversation.id,
      reporterId: reporter.id,
      expectedState: ConversationState.AWAITING_APPROVAL,
      expectedVersion: conversation.version,
      targetState: ConversationState.COLLECTING_MEDIA,
      storyMutation: { kind: "PRESERVE" },
      inboundEventId: event.id,
    });
    if (transition.outcome !== "TRANSITIONED") throw new Round6RevisionError();
    await tx.inboundEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: InboundProcessingStatus.PROCESSED,
        processedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    const metadata = {
      oldPreparationId: preparation.id,
      storyId: story.id,
      versionBefore: story.version,
      versionAfter: story.version + 1,
      wordpressPostId: Number(story.wordpressPostId),
    };
    await tx.auditLog.createMany({
      data: [
        {
          eventType: "story_revision_requested",
          actorType: AuditActorType.REPORTER,
          reporterId: reporter.id,
          storyId: story.id,
          inboundEventId: event.id,
          entityType: "Story",
          entityId: story.id,
          metadata,
        },
        {
          eventType: "draft_preparation_superseded",
          actorType: AuditActorType.SYSTEM,
          reporterId: reporter.id,
          storyId: story.id,
          inboundEventId: event.id,
          entityType: "DraftPreparation",
          entityId: preparation.id,
          metadata,
        },
      ],
    });
    return { reporterId: reporter.id, conversationId: conversation.id };
  }
}
