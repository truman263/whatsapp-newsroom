import { Injectable } from "@nestjs/common";
import { AuditActorType, type Prisma } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { validateTransition } from "./conversation-state-machine";
import { REPORTER_WORKFLOW_AUDIT } from "./reporter-workflow.audit";
import { ReporterWorkflowError } from "./reporter-workflow.errors";
import type {
  ConversationTransitionCommand,
  TransitionResult,
} from "./reporter-workflow.types";

@Injectable()
export class ConversationStateMachineService {
  constructor(private readonly prisma: PrismaService) {}

  transition(
    command: ConversationTransitionCommand,
  ): Promise<TransitionResult> {
    return this.prisma.$transaction((tx) =>
      this.transitionInTransaction(tx, command),
    );
  }

  async transitionInTransaction(
    tx: Prisma.TransactionClient,
    command: ConversationTransitionCommand,
  ): Promise<TransitionResult> {
    if (
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 0
    )
      throw new ReporterWorkflowError("INVALID_EXPECTED_VERSION");
    validateTransition(
      command.expectedState,
      command.targetState,
      command.storyMutation,
    );

    let storyId: string | null | undefined;
    if (command.storyMutation.kind === "ATTACH") {
      const story = await tx.story.findFirst({
        where: {
          id: command.storyMutation.storyId,
          reporterId: command.reporterId,
        },
        select: { id: true },
      });
      if (!story)
        throw new ReporterWorkflowError("STORY_NOT_FOUND_OR_NOT_OWNED");
      storyId = story.id;
    } else if (command.storyMutation.kind === "CLEAR") {
      storyId = null;
    }
    if (command.inboundEventId) {
      const provenance = await tx.inboundEvent.findFirst({
        where: { id: command.inboundEventId, reporterId: command.reporterId },
        select: { id: true },
      });
      if (!provenance)
        throw new ReporterWorkflowError("INBOUND_EVENT_ASSOCIATION_CONFLICT");
    }
    const result = await tx.conversation.updateMany({
      where: {
        id: command.conversationId,
        reporterId: command.reporterId,
        state: command.expectedState,
        version: command.expectedVersion,
        ...(command.storyMutation.kind === "PRESERVE"
          ? { currentStoryId: { not: null } }
          : command.storyMutation.kind === "ATTACH"
            ? { currentStoryId: null }
            : {}),
      },
      data: {
        state: command.targetState,
        version: { increment: 1 },
        ...(storyId !== undefined ? { currentStoryId: storyId } : {}),
      },
    });
    if (result.count === 0) {
      const owned = await tx.conversation.findFirst({
        where: { id: command.conversationId, reporterId: command.reporterId },
        select: { id: true },
      });
      return owned
        ? { outcome: "STALE" }
        : { outcome: "NOT_FOUND_OR_NOT_OWNED" };
    }
    const version = command.expectedVersion + 1;
    await tx.auditLog.create({
      data: {
        eventType: REPORTER_WORKFLOW_AUDIT.CONVERSATION_TRANSITIONED,
        actorType: command.inboundEventId
          ? AuditActorType.REPORTER
          : AuditActorType.SYSTEM,
        reporterId: command.reporterId,
        storyId: storyId === undefined ? undefined : storyId,
        inboundEventId: command.inboundEventId,
        entityType: "Conversation",
        entityId: command.conversationId,
        metadata: {
          from: command.expectedState,
          to: command.targetState,
          versionBefore: command.expectedVersion,
          versionAfter: version,
        },
      },
    });
    return { outcome: "TRANSITIONED", version };
  }
}
