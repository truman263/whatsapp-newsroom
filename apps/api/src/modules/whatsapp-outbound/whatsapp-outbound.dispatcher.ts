import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  OutboundMessageStatus,
  StoryStatus,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../../config/configuration";
import { PrismaService } from "../../database/prisma.service";
import { PreviewTokenService } from "../newsroom-preview/newsroom-preview-token.service";
import { WhatsappOutboundClient } from "./whatsapp-outbound.client";
import {
  WhatsappOutboundError,
  type WhatsappOutboundCode,
} from "./whatsapp-outbound.errors";
import type {
  ApprovalPromptPayload,
  DispatchResult,
  StaleSendingRecoveryResult,
} from "./whatsapp-outbound.types";

const UNCERTAIN_CODE = "WHATSAPP_SEND_OUTCOME_UNCERTAIN" as const;

@Injectable()
export class WhatsappOutboundDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PreviewTokenService,
    private readonly client: WhatsappOutboundClient,
    private readonly config: ConfigService<ApplicationConfiguration, true>,
  ) {}

  async dispatchOne(messageId: string): Promise<DispatchResult> {
    const initial = await this.prisma.outboundMessage.findUnique({
      where: { id: messageId },
      include: { draftPreparationApprovalPrompt: true },
    });
    if (
      !initial ||
      initial.status !== OutboundMessageStatus.PENDING ||
      !initial.draftPreparationApprovalPrompt
    )
      return "NOT_CLAIMED";
    const payload = parsePayload(initial.payload);
    if (
      !payload ||
      payload.draftPreparationId !== initial.draftPreparationApprovalPrompt.id
    )
      return this.failPending(messageId, "WHATSAPP_PROMPT_CONTRACT_FAILURE");
    let token: string;
    try {
      token = await this.tokens.issue(payload.draftPreparationId);
    } catch {
      return "NOT_CLAIMED";
    }
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${messageId}::uuid FOR UPDATE`;
      const message = await tx.outboundMessage.findUnique({
        where: { id: messageId },
        include: {
          reporter: true,
          story: { include: { activeInConversation: true } },
          draftPreparationApprovalPrompt: true,
        },
      });
      const prep = message?.draftPreparationApprovalPrompt;
      if (
        !message ||
        message.status !== OutboundMessageStatus.PENDING ||
        !message.story ||
        !prep ||
        prep.status !== DraftPreparationStatus.READY_FOR_APPROVAL ||
        message.story.status !== StoryStatus.AWAITING_APPROVAL ||
        message.story.activeInConversation?.state !==
          ConversationState.AWAITING_APPROVAL ||
        message.story.activeInConversation.currentStoryId !==
          message.story.id ||
        message.story.version !== prep.storyVersion ||
        prep.wordpressAppliedVersion !== payload.wordpressAppliedVersion ||
        message.reporterId !== message.story.reporterId ||
        prep.approvalPromptOutboundMessageId !== message.id
      )
        return null;
      return tx.outboundMessage.update({
        where: { id: message.id },
        data: {
          status: OutboundMessageStatus.SENDING,
          sendAttempts: { increment: 1 },
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        include: { reporter: true },
      });
    });
    if (!claimed) return "NOT_CLAIMED";
    const previewUrl = `${this.config.get("preview.publicOrigin", { infer: true })}/preview#token=${token}`;
    let providerMessageId: string;
    try {
      providerMessageId = await this.client.sendApprovalPrompt({
        to: claimed.reporter.phoneNumber,
        previewUrl,
        controlId: `newsroom:v1:story:approve:${claimed.id}`,
      });
    } catch (error) {
      const failure =
        error instanceof WhatsappOutboundError
          ? error
          : new WhatsappOutboundError("WHATSAPP_SEND_OUTCOME_UNCERTAIN", true);
      if (failure.uncertain) {
        await this.holdUncertainSend(messageId);
        return "OUTCOME_UNCERTAIN";
      }
      await this.finishFailure(messageId, failure.code);
      return "FAILED";
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${messageId}::uuid FOR UPDATE`;
      const current = await tx.outboundMessage.findUniqueOrThrow({
        where: { id: messageId },
      });
      if (
        current.status !== OutboundMessageStatus.SENDING ||
        (current.providerMessageId &&
          current.providerMessageId !== providerMessageId)
      )
        throw new WhatsappOutboundError("WHATSAPP_PROMPT_IDENTITY_CONFLICT");
      await tx.outboundMessage.update({
        where: { id: messageId },
        data: {
          status: OutboundMessageStatus.SENT,
          providerMessageId,
          sentAt: current.sentAt ?? new Date(),
          failedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: "approval_prompt_sent",
          actorType: AuditActorType.SYSTEM,
          reporterId: current.reporterId,
          storyId: current.storyId,
          entityType: "OutboundMessage",
          entityId: current.id,
          metadata: { status: "SENT", sendAttempts: current.sendAttempts },
        },
      });
    });
    return "SENT";
  }

  async dispatchPending(limit: number): Promise<DispatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("INVALID_DISPATCH_LIMIT");
    const rows = await this.prisma.outboundMessage.findMany({
      where: { status: OutboundMessageStatus.PENDING },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    const results: DispatchResult[] = [];
    for (const row of rows) results.push(await this.dispatchOne(row.id));
    return results;
  }

  async recoverUncertainSend(messageId: string): Promise<DispatchResult> {
    return this.holdUncertainSend(messageId);
  }

  async recoverStaleSending(
    staleBefore: Date,
    limit: number,
  ): Promise<StaleSendingRecoveryResult[]> {
    if (
      !(staleBefore instanceof Date) ||
      Number.isNaN(staleBefore.getTime()) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("INVALID_RECOVERY_SCAN");
    const rows = await this.prisma.outboundMessage.findMany({
      where: {
        status: OutboundMessageStatus.SENDING,
        updatedAt: { lt: staleBefore },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    const results: StaleSendingRecoveryResult[] = [];
    for (const row of rows)
      results.push({
        messageId: row.id,
        result: await this.holdUncertainSend(row.id, staleBefore),
      });
    return results;
  }

  private async failPending(
    messageId: string,
    code: WhatsappOutboundCode,
  ): Promise<DispatchResult> {
    await this.prisma.outboundMessage.updateMany({
      where: { id: messageId, status: OutboundMessageStatus.PENDING },
      data: {
        status: OutboundMessageStatus.FAILED,
        failedAt: new Date(),
        lastErrorCode: code,
        lastErrorMessage: null,
      },
    });
    return "FAILED";
  }

  private async finishFailure(
    messageId: string,
    code: WhatsappOutboundCode,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${messageId}::uuid FOR UPDATE`;
      const row = await tx.outboundMessage.findUniqueOrThrow({
        where: { id: messageId },
      });
      if (row.status !== OutboundMessageStatus.SENDING) return;
      await tx.outboundMessage.update({
        where: { id: messageId },
        data: {
          status: OutboundMessageStatus.FAILED,
          failedAt: new Date(),
          lastErrorCode: code,
          lastErrorMessage: null,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: "approval_prompt_failed",
          actorType: AuditActorType.SYSTEM,
          reporterId: row.reporterId,
          storyId: row.storyId,
          entityType: "OutboundMessage",
          entityId: row.id,
          metadata: {
            status: "FAILED",
            sendAttempts: row.sendAttempts,
            errorCode: code,
          },
        },
      });
    });
  }

  private async holdUncertainSend(
    messageId: string,
    staleBefore?: Date,
  ): Promise<"MANUAL_RECONCILIATION_REQUIRED" | "NOT_CLAIMED"> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${messageId}::uuid FOR UPDATE`;
      const row = await tx.outboundMessage.findUnique({
        where: { id: messageId },
      });
      if (
        !row ||
        row.status !== OutboundMessageStatus.SENDING ||
        (staleBefore && row.updatedAt >= staleBefore)
      )
        return "NOT_CLAIMED";
      if (
        row.lastErrorCode === UNCERTAIN_CODE &&
        row.lastErrorMessage === null &&
        row.failedAt === null
      )
        return "MANUAL_RECONCILIATION_REQUIRED";
      await tx.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: OutboundMessageStatus.SENDING,
          lastErrorCode: UNCERTAIN_CODE,
          lastErrorMessage: null,
          failedAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: "approval_prompt_send_uncertain",
          actorType: AuditActorType.SYSTEM,
          reporterId: row.reporterId,
          storyId: row.storyId,
          entityType: "OutboundMessage",
          entityId: row.id,
          metadata: {
            status: "SENDING",
            errorCode: UNCERTAIN_CODE,
            sendAttempts: row.sendAttempts,
          },
        },
      });
      return "MANUAL_RECONCILIATION_REQUIRED";
    });
  }
}

function parsePayload(value: unknown): ApprovalPromptPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort()) !==
    JSON.stringify([
      "draftPreparationId",
      "kind",
      "storyId",
      "storyVersion",
      "wordpressAppliedVersion",
    ])
  )
    return null;
  return row.kind === "APPROVAL_PROMPT_V1" &&
    typeof row.draftPreparationId === "string" &&
    typeof row.storyId === "string" &&
    Number.isSafeInteger(row.storyVersion) &&
    typeof row.wordpressAppliedVersion === "string" &&
    /^[0-9a-f]{64}$/.test(row.wordpressAppliedVersion)
    ? (row as ApprovalPromptPayload)
    : null;
}
