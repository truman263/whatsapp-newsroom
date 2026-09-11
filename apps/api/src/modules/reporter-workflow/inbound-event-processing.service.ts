import { Injectable } from "@nestjs/common";
import { AuditActorType, InboundProcessingStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { StoredWhatsappEventParser } from "../story-collection/stored-whatsapp-event.parser";
import { StoryCollectionError } from "../story-collection/story-collection.errors";
import { StoryEventProcessor } from "../story-collection/story-event-processor.service";
import { ConversationProvisioningService } from "./conversation-provisioning.service";
import {
  IGNORED_REASON,
  REPORTER_WORKFLOW_AUDIT,
} from "./reporter-workflow.audit";
import { ReporterAuthorizationService } from "./reporter-authorization.service";
import { ReporterWorkflowError } from "./reporter-workflow.errors";
import type {
  EventClaimResult,
  EventProcessingResult,
} from "./reporter-workflow.types";

@Injectable()
export class InboundEventProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: ReporterAuthorizationService,
    private readonly conversations: ConversationProvisioningService,
    private readonly storedEvents: StoredWhatsappEventParser,
    private readonly stories: StoryEventProcessor,
  ) {}

  async claim(eventId: string): Promise<EventClaimResult> {
    const now = new Date();
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "InboundEvent" AS candidate
      SET "processingStatus" = 'PROCESSING'::"InboundProcessingStatus",
          "processingStartedAt" = ${now},
          "processingAttempts" = candidate."processingAttempts" + 1,
          "processedAt" = NULL,
          "lastErrorCode" = NULL,
          "lastErrorMessage" = NULL,
          "updatedAt" = ${now}
      WHERE candidate."id" = ${eventId}::uuid
        AND candidate."processingStatus" = 'RECEIVED'::"InboundProcessingStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "InboundEvent" AS earlier
          WHERE earlier."senderPhone" = candidate."senderPhone"
            AND earlier."senderIngestSequence" < candidate."senderIngestSequence"
            AND earlier."processingStatus" IN ('RECEIVED'::"InboundProcessingStatus", 'PROCESSING'::"InboundProcessingStatus")
        )
      RETURNING candidate."id"
    `;
    if (claimed.length === 1) return { outcome: "CLAIMED" };
    const blocked = await this.prisma.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "InboundEvent" AS candidate
        JOIN "InboundEvent" AS earlier
          ON earlier."senderPhone" = candidate."senderPhone"
         AND earlier."senderIngestSequence" < candidate."senderIngestSequence"
         AND earlier."processingStatus" IN ('RECEIVED'::"InboundProcessingStatus", 'PROCESSING'::"InboundProcessingStatus")
        WHERE candidate."id" = ${eventId}::uuid
          AND candidate."processingStatus" = 'RECEIVED'::"InboundProcessingStatus"
      ) AS blocked
    `;
    return blocked[0]?.blocked
      ? { outcome: "ORDER_BLOCKED" }
      : { outcome: "NOT_CLAIMED" };
  }

  async process(eventId: string): Promise<EventProcessingResult> {
    const claim = await this.claim(eventId);
    if (claim.outcome !== "CLAIMED") return claim;
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "InboundEvent" WHERE "id" = ${eventId}::uuid FOR UPDATE
      `;
      if (!locked[0])
        throw new ReporterWorkflowError("INBOUND_EVENT_STATE_CONFLICT");
      const event = await tx.inboundEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: {
          id: true,
          senderPhone: true,
          reporterId: true,
          processingStatus: true,
          providerMessageId: true,
          eventType: true,
          rawPayload: true,
          providerOccurredAt: true,
        },
      });
      if (event.processingStatus !== InboundProcessingStatus.PROCESSING)
        throw new ReporterWorkflowError("INBOUND_EVENT_STATE_CONFLICT");
      const authorization = await this.authorization.authorizeInTransaction(
        tx,
        event.senderPhone,
      );
      if (authorization.outcome !== "ACTIVE") {
        if (event.reporterId !== null)
          throw new ReporterWorkflowError("INBOUND_EVENT_ASSOCIATION_CONFLICT");
        const reason =
          authorization.outcome === "UNKNOWN"
            ? IGNORED_REASON.UNKNOWN
            : IGNORED_REASON.INACTIVE;
        const now = new Date();
        await tx.auditLog.create({
          data: {
            eventType: REPORTER_WORKFLOW_AUDIT.INBOUND_EVENT_IGNORED,
            actorType: AuditActorType.SYSTEM,
            inboundEventId: event.id,
            entityType: "InboundEvent",
            entityId: event.id,
            metadata: { reason },
          },
        });
        await tx.inboundEvent.update({
          where: { id: event.id },
          data: {
            processingStatus: InboundProcessingStatus.IGNORED,
            processedAt: now,
            lastErrorCode: reason,
            lastErrorMessage: null,
          },
        });
        return { outcome: "IGNORED", reason };
      }
      if (
        event.reporterId !== null &&
        event.reporterId !== authorization.reporterId
      )
        throw new ReporterWorkflowError("INBOUND_EVENT_ASSOCIATION_CONFLICT");
      await tx.inboundEvent.update({
        where: { id: event.id },
        data: { reporterId: authorization.reporterId },
      });
      let parsed;
      try {
        parsed = this.storedEvents.parse({
          providerMessageId: event.providerMessageId,
          senderPhone: event.senderPhone,
          eventType: event.eventType,
          providerOccurredAt: event.providerOccurredAt,
          rawPayload: event.rawPayload,
        });
      } catch (error: unknown) {
        if (
          error instanceof StoryCollectionError &&
          error.code === "MALFORMED_STORED_EVENT"
        ) {
          await tx.inboundEvent.update({
            where: { id: event.id },
            data: {
              processingStatus: InboundProcessingStatus.FAILED,
              processedAt: new Date(),
              lastErrorCode: error.code,
              lastErrorMessage: null,
            },
          });
          return { outcome: "FAILED", reason: error.code };
        }
        throw error;
      }
      const conversation = await this.conversations.getOrCreateInTransaction(
        tx,
        authorization.reporterId,
      );
      const expectedStoryVersion = conversation.currentStoryId
        ? (
            await tx.story.findUniqueOrThrow({
              where: { id: conversation.currentStoryId },
              select: { version: true },
            })
          ).version
        : null;
      const storyResult = await this.stories.process(tx, {
        eventId: event.id,
        reporterId: authorization.reporterId,
        conversationId: conversation.id,
        conversationState: conversation.state,
        conversationVersion: conversation.version,
        expectedStoryVersion,
        parsed,
      });
      if (storyResult.outcome === "IGNORED") {
        await tx.auditLog.create({
          data: {
            eventType: REPORTER_WORKFLOW_AUDIT.INBOUND_EVENT_IGNORED,
            actorType: AuditActorType.REPORTER,
            reporterId: authorization.reporterId,
            inboundEventId: event.id,
            entityType: "InboundEvent",
            entityId: event.id,
            metadata: { reason: storyResult.reason },
          },
        });
        await tx.inboundEvent.update({
          where: { id: event.id },
          data: {
            processingStatus: InboundProcessingStatus.IGNORED,
            processedAt: new Date(),
            lastErrorCode: storyResult.reason,
            lastErrorMessage: null,
          },
        });
        return { outcome: "IGNORED", reason: storyResult.reason };
      }
      await tx.auditLog.create({
        data: {
          eventType: REPORTER_WORKFLOW_AUDIT.INBOUND_EVENT_AUTHORIZED,
          actorType: AuditActorType.REPORTER,
          reporterId: authorization.reporterId,
          inboundEventId: event.id,
          entityType: "InboundEvent",
          entityId: event.id,
        },
      });
      await tx.inboundEvent.update({
        where: { id: event.id },
        data: {
          processingStatus: InboundProcessingStatus.PROCESSED,
          processedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      return {
        outcome: "PROCESSED",
        reporterId: authorization.reporterId,
        conversationId: conversation.id,
      };
    });
  }
}
