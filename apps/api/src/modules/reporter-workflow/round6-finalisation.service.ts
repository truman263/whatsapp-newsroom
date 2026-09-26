import { Injectable } from "@nestjs/common";
import {
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Prisma,
  ReporterStatus,
  StoryStatus,
  type DraftPreparation,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { DraftPreparationError } from "../draft-preparation/draft-preparation.errors";
import { DraftPreparationService } from "../draft-preparation/draft-preparation.service";
import type { PreparedAuthority } from "../draft-preparation/draft-preparation.types";
import { ApprovalPromptService } from "../whatsapp-outbound/approval-prompt.service";
import { WhatsappOutboundDispatcher } from "../whatsapp-outbound/whatsapp-outbound.dispatcher";
import { ConversationStateMachineService } from "./conversation-state-machine.service";
import type { EventProcessingResult } from "./reporter-workflow.types";
import {
  readInboundProcessingClaim,
  requireInboundProcessingClaim,
  type InboundProcessingClaim,
} from "./inbound-processing-contract";

@Injectable()
export class Round6FinalisationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preparations: DraftPreparationService,
    private readonly prompts: ApprovalPromptService,
    private readonly dispatcher: WhatsappOutboundDispatcher,
    private readonly conversations: ConversationStateMachineService,
  ) {}

  async resume(
    preparationId: string,
    claim: InboundProcessingClaim,
  ): Promise<EventProcessingResult> {
    const prepared = await this.preparations.prepare(preparationId, claim);
    if (
      prepared.outcome === "BLOCKED" ||
      prepared.outcome === "RECONCILIATION_REQUIRED"
    )
      return {
        outcome: "RETRY_REQUIRED",
        reason: prepared.errorCode ?? prepared.outcome,
      };
    if (prepared.outcome === "FAILED")
      return {
        outcome: "FAILED",
        reason: prepared.errorCode ?? "DRAFT_PREPARATION_FAILED",
      };
    let authority: PreparedAuthority;
    try {
      authority = await this.preparations.verifyPreparedAuthority(
        preparationId,
        claim,
      );
    } catch (error) {
      const reason =
        error instanceof DraftPreparationError
          ? error.code
          : "WORDPRESS_STATE_MISMATCH";
      return { outcome: "RETRY_REQUIRED", reason };
    }
    const completed = await this.prisma.$transaction((tx) =>
      this.completeApprovalPostureInTransaction(tx, authority, claim),
    );
    await this.dispatcher.dispatchOne(completed.promptId);
    return {
      outcome: "PROCESSED",
      reporterId: completed.reporterId,
      conversationId: completed.conversationId,
    };
  }

  async completeApprovalPostureInTransaction(
    tx: Prisma.TransactionClient,
    authority: PreparedAuthority,
    expectedClaim?: InboundProcessingClaim,
  ): Promise<{ promptId: string; reporterId: string; conversationId: string }> {
    const prepHint = await tx.draftPreparation.findUnique({
      where: { id: authority.preparationId },
      select: { inboundEventId: true, storyId: true },
    });
    if (!prepHint || prepHint.storyId !== authority.storyId)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${prepHint.inboundEventId}::uuid FOR UPDATE`;
    if (!expectedClaim) {
      const event = await tx.inboundEvent.findUniqueOrThrow({
        where: { id: prepHint.inboundEventId },
      });
      if (event.processingStatus === InboundProcessingStatus.PROCESSING)
        expectedClaim = await readInboundProcessingClaim(tx, event.id);
    }
    const storyHint = await tx.story.findUnique({
      where: { id: authority.storyId },
      select: { reporterId: true },
    });
    if (!storyHint)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    const conversationHint = await tx.conversation.findUnique({
      where: { reporterId: storyHint.reporterId },
      select: { id: true },
    });
    if (!conversationHint)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    if (expectedClaim && prepHint.inboundEventId !== expectedClaim.eventId)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    if (expectedClaim) await requireInboundProcessingClaim(tx, expectedClaim);
    await tx.$queryRaw`SELECT "id" FROM "Reporter" WHERE "id"=${storyHint.reporterId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${conversationHint.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${authority.storyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT ec."id" FROM "EditorialCategory" ec JOIN "StoryCategory" sc ON sc."categoryId"=ec."id" WHERE sc."storyId"=${authority.storyId}::uuid ORDER BY ec."id" FOR UPDATE OF ec`;
    await tx.$queryRaw`SELECT "storyId","categoryId" FROM "StoryCategory" WHERE "storyId"=${authority.storyId}::uuid ORDER BY "categoryId" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "storyId"=${authority.storyId}::uuid ORDER BY "position","id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${authority.preparationId}::uuid FOR UPDATE`;
    const preparation = await tx.draftPreparation.findUniqueOrThrow({
      where: { id: authority.preparationId },
      include: {
        story: {
          include: {
            reporter: true,
            activeInConversation: true,
            categories: { include: { category: true } },
            media: true,
          },
        },
        inboundEvent: true,
        approvalPromptOutboundMessage: true,
      },
    });
    const story = preparation.story;
    const conversation = story.activeInConversation;
    const alreadyComplete =
      preparation.status === DraftPreparationStatus.READY_FOR_APPROVAL &&
      story.status === StoryStatus.AWAITING_APPROVAL &&
      conversation?.state === ConversationState.AWAITING_APPROVAL &&
      preparation.inboundEvent.processingStatus ===
        InboundProcessingStatus.PROCESSED;
    if (alreadyComplete) {
      const prompt = await this.prompts.queueApprovalPromptInTransaction(
        tx,
        authority,
      );
      return {
        promptId: prompt.id,
        reporterId: story.reporterId,
        conversationId: conversation.id,
      };
    }
    if (
      preparation.status !== DraftPreparationStatus.ACTIVE ||
      preparation.storyVersion !== authority.storyVersion ||
      preparation.wordpressAppliedVersion !==
        authority.wordpressAppliedVersion ||
      preparation.wordpressPostId !== BigInt(authority.wordpressPostId) ||
      preparation.inboundEvent.processingStatus !==
        InboundProcessingStatus.PROCESSING ||
      (expectedClaim &&
        (preparation.inboundEvent.processingAttempts !==
          expectedClaim.processingAttempt ||
          preparation.inboundEvent.processingContractVersion !==
            expectedClaim.processingContractVersion)) ||
      preparation.inboundEvent.reporterId !== story.reporterId ||
      story.reporter.status !== ReporterStatus.ACTIVE ||
      story.status !== StoryStatus.DRAFT_CREATED ||
      story.version !== authority.storyVersion ||
      story.wordpressPostId !== preparation.wordpressPostId ||
      !conversation ||
      conversation.state !== ConversationState.COLLECTING_MEDIA ||
      conversation.currentStoryId !== story.id ||
      conversation.reporterId !== story.reporterId ||
      story.categories.length === 0 ||
      story.categories.some(
        ({ category }) => category.status !== EditorialCategoryStatus.ACTIVE,
      ) ||
      story.media.some(
        (media) =>
          media.status !== MediaProcessingStatus.UPLOADED ||
          !media.wordpressMediaId ||
          media.wordpressMediaId <= 0n,
      )
    )
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    const prompt = await this.prompts.queueApprovalPromptInTransaction(
      tx,
      authority,
    );
    const now = new Date();
    await tx.draftPreparation.update({
      where: { id: preparation.id },
      data: {
        status: DraftPreparationStatus.READY_FOR_APPROVAL,
        readyAt: now,
        lastErrorCode: null,
      },
    });
    await tx.story.update({
      where: { id: story.id },
      data: { status: StoryStatus.AWAITING_APPROVAL },
    });
    const transition = await this.conversations.transitionInTransaction(tx, {
      conversationId: conversation.id,
      reporterId: story.reporterId,
      expectedState: ConversationState.COLLECTING_MEDIA,
      expectedVersion: conversation.version,
      targetState: ConversationState.AWAITING_APPROVAL,
      storyMutation: { kind: "PRESERVE" },
      inboundEventId: preparation.inboundEventId,
    });
    if (transition.outcome !== "TRANSITIONED")
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    await tx.inboundEvent.update({
      where: { id: preparation.inboundEventId },
      data: {
        processingStatus: InboundProcessingStatus.PROCESSED,
        processedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    await tx.auditLog.create({
      data: {
        eventType: "story_ready_for_approval",
        actorType: AuditActorType.SYSTEM,
        reporterId: story.reporterId,
        storyId: story.id,
        inboundEventId: preparation.inboundEventId,
        entityType: "DraftPreparation",
        entityId: preparation.id,
        metadata: {
          storyVersion: preparation.storyVersion,
          status: "READY_FOR_APPROVAL",
        },
      },
    });
    return {
      promptId: prompt.id,
      reporterId: story.reporterId,
      conversationId: conversation.id,
    };
  }

  async preparationForProcessingEvent(
    eventId: string,
  ): Promise<DraftPreparation | null> {
    return this.prisma.draftPreparation.findUnique({
      where: { inboundEventId: eventId },
    });
  }
}
