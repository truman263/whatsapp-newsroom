import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  AuditActorType,
  OutboundMessageStatus,
  OutboundMessageType,
  Prisma,
  type OutboundMessage,
} from "@prisma/client";
import { WhatsappOutboundError } from "./whatsapp-outbound.errors";
import type { ApprovalPromptPayload } from "./whatsapp-outbound.types";

export type QueueAuthority = {
  preparationId: string;
  storyId: string;
  storyVersion: number;
  wordpressAppliedVersion: string;
};

@Injectable()
export class ApprovalPromptService {
  async queueApprovalPromptInTransaction(
    tx: Prisma.TransactionClient,
    authority: QueueAuthority,
  ): Promise<OutboundMessage> {
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${authority.storyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${authority.preparationId}::uuid FOR UPDATE`;
    const preparation = await tx.draftPreparation.findUnique({
      where: { id: authority.preparationId },
      include: { story: true, approvalPromptOutboundMessage: true },
    });
    if (
      !preparation ||
      preparation.storyId !== authority.storyId ||
      preparation.storyVersion !== authority.storyVersion ||
      preparation.wordpressAppliedVersion !== authority.wordpressAppliedVersion
    )
      throw new WhatsappOutboundError("WHATSAPP_PROMPT_IDENTITY_CONFLICT");
    const payload: ApprovalPromptPayload = {
      kind: "APPROVAL_PROMPT_V1",
      draftPreparationId: preparation.id,
      storyId: preparation.storyId,
      storyVersion: preparation.storyVersion,
      wordpressAppliedVersion: preparation.wordpressAppliedVersion,
    };
    if (preparation.approvalPromptOutboundMessage) {
      if (
        !matches(
          preparation.approvalPromptOutboundMessage,
          preparation.story.reporterId,
          preparation.approvalPromptCorrelationKey,
          payload,
        )
      )
        throw new WhatsappOutboundError("WHATSAPP_PROMPT_IDENTITY_CONFLICT");
      return preparation.approvalPromptOutboundMessage;
    }
    const existing = await tx.outboundMessage.findUnique({
      where: { correlationKey: preparation.approvalPromptCorrelationKey },
    });
    let message: OutboundMessage;
    if (existing) {
      if (
        !matches(
          existing,
          preparation.story.reporterId,
          preparation.approvalPromptCorrelationKey,
          payload,
        )
      )
        throw new WhatsappOutboundError("WHATSAPP_PROMPT_IDENTITY_CONFLICT");
      message = existing;
    } else {
      message = await tx.outboundMessage.create({
        data: {
          id: randomUUID(),
          reporterId: preparation.story.reporterId,
          storyId: preparation.storyId,
          type: OutboundMessageType.INTERACTIVE,
          status: OutboundMessageStatus.PENDING,
          correlationKey: preparation.approvalPromptCorrelationKey,
          payload,
          sendAttempts: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: "approval_prompt_queued",
          actorType: AuditActorType.SYSTEM,
          reporterId: message.reporterId,
          storyId: message.storyId,
          inboundEventId: preparation.inboundEventId,
          entityType: "OutboundMessage",
          entityId: message.id,
          metadata: { status: "PENDING" },
        },
      });
    }
    await tx.draftPreparation.update({
      where: { id: preparation.id },
      data: { approvalPromptOutboundMessageId: message.id },
    });
    return message;
  }
}

function matches(
  message: OutboundMessage,
  reporterId: string,
  correlationKey: string,
  payload: ApprovalPromptPayload,
): boolean {
  const value = message.payload as Record<string, unknown>;
  return (
    message.reporterId === reporterId &&
    message.storyId === payload.storyId &&
    message.type === OutboundMessageType.INTERACTIVE &&
    message.correlationKey === correlationKey &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([
        "draftPreparationId",
        "kind",
        "storyId",
        "storyVersion",
        "wordpressAppliedVersion",
      ]) &&
    value.kind === payload.kind &&
    value.draftPreparationId === payload.draftPreparationId &&
    value.storyId === payload.storyId &&
    value.storyVersion === payload.storyVersion &&
    value.wordpressAppliedVersion === payload.wordpressAppliedVersion
  );
}
