import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditActorType, InboundProcessingStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import type { ApplicationConfiguration } from "../../config/configuration";
import { DraftPreparationError } from "../draft-preparation/draft-preparation.errors";
import { DraftPreparationService } from "../draft-preparation/draft-preparation.service";
import { MediaStagingService } from "../media-staging/media-staging.service";
import type { MediaAuthority } from "../media-staging/media-staging.types";
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
import { Round6FinalisationService } from "./round6-finalisation.service";
import {
  Round6RevisionError,
  Round6RevisionService,
} from "./round6-revision.service";
import type {
  EventClaimResult,
  EventProcessingResult,
} from "./reporter-workflow.types";
import {
  approvalControl,
  Round7ApprovalError,
  Round7ApprovalService,
} from "./round7-approval.service";
import { Round7PublishSagaService } from "../publishing/round7-publish-saga.service";

type ProcessingPhase =
  | EventProcessingResult
  | {
      outcome: "MEDIA_INTENT";
      mediaId: string;
      storyId: string;
      authority: MediaAuthority;
      reporterId: string;
      conversationId: string;
    }
  | {
      outcome: "FINALISATION_INTENT";
      preparationId: string;
    };

@Injectable()
export class InboundEventProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: ReporterAuthorizationService,
    private readonly conversations: ConversationProvisioningService,
    private readonly storedEvents: StoredWhatsappEventParser,
    private readonly stories: StoryEventProcessor,
    @Optional() private readonly mediaStaging?: MediaStagingService,
    @Optional()
    private readonly config?: ConfigService<ApplicationConfiguration, true>,
    @Optional() private readonly draftPreparations?: DraftPreparationService,
    @Optional() private readonly round6?: Round6FinalisationService,
    @Optional() private readonly revisions?: Round6RevisionService,
    @Optional() private readonly approvals?: Round7ApprovalService,
    @Optional() private readonly publishing?: Round7PublishSagaService,
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
    if (claim.outcome !== "CLAIMED") {
      if (claim.outcome !== "NOT_CLAIMED") return claim;
      const approval = await this.approvals?.recover(eventId);
      if (approval)
        return this.publishing
          ? this.publishing.run(approval.publishAttemptId)
          : approval;
      if (this.publishing && this.approvals) {
        const blocked = await this.prisma.approval.findUnique({
          where: { inboundEventId: eventId },
          select: {
            publishAttempt: { select: { id: true, status: true } },
          },
        });
        if (blocked?.publishAttempt?.status === "RECONCILIATION_REQUIRED")
          return {
            outcome: "PUBLISH_RECONCILIATION_REQUIRED",
            publishAttemptId: blocked.publishAttempt.id,
            reason: "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
          };
      }
      if (!this.round6) return claim;
      const existing = await this.round6.preparationForProcessingEvent(eventId);
      if (!existing) return claim;
      const event = await this.prisma.inboundEvent.findUnique({
        where: { id: eventId },
        select: { processingStatus: true },
      });
      if (event?.processingStatus !== InboundProcessingStatus.PROCESSING)
        return claim;
      return this.round6.resume(existing.id);
    }
    if (this.approvals) {
      const event = await this.prisma.inboundEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: {
          providerMessageId: true,
          senderPhone: true,
          eventType: true,
          providerOccurredAt: true,
          rawPayload: true,
        },
      });
      let control = null;
      try {
        control = approvalControl(this.storedEvents.parse(event));
      } catch {
        // Preserve the established transactional malformed-event handling below.
      }
      if (control) {
        try {
          const approval = await this.approvals.process(eventId, control);
          return this.publishing
            ? this.publishing.run(approval.publishAttemptId)
            : approval;
        } catch (error) {
          if (!(error instanceof Round7ApprovalError)) throw error;
          if (
            error.code === "CONTROL_NOT_ENABLED" ||
            error.code === "APPROVAL_AMBIGUOUS" ||
            error.code === "APPROVAL_IDENTITY_CONFLICT" ||
            error.code === "APPROVAL_PROMPT_NOT_SENT" ||
            error.code === "APPROVAL_STATE_MISMATCH"
          ) {
            await this.prisma.inboundEvent.update({
              where: { id: eventId },
              data: {
                processingStatus: InboundProcessingStatus.IGNORED,
                processedAt: new Date(),
                lastErrorCode: error.code,
                lastErrorMessage: null,
              },
            });
            return { outcome: "IGNORED", reason: error.code };
          }
          return { outcome: "RETRY_REQUIRED", reason: error.code };
        }
      }
    }
    const phase = await this.prisma.$transaction<ProcessingPhase>(
      async (tx) => {
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
            receivedAt: true,
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
            throw new ReporterWorkflowError(
              "INBOUND_EVENT_ASSOCIATION_CONFLICT",
            );
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
          round6DoneEnabled:
            event.receivedAt.getTime() >=
            (
              this.config?.get("round6.controlCutoverAt", { infer: true }) ??
              new Date("9999-12-31T23:59:59.999Z")
            ).getTime(),
        });
        if (storyResult.outcome === "FINALISATION_INTENT") {
          if (!this.draftPreparations)
            throw new ReporterWorkflowError("INBOUND_EVENT_STATE_CONFLICT");
          try {
            const preparation =
              await this.draftPreparations.finalizeInTransaction(tx, {
                inboundEventId: event.id,
                reporterId: authorization.reporterId,
                conversationId: conversation.id,
                storyId: storyResult.storyId,
                expectedStoryVersion: expectedStoryVersion!,
              });
            return {
              outcome: "FINALISATION_INTENT",
              preparationId: preparation.preparationId,
            };
          } catch (error) {
            if (
              error instanceof DraftPreparationError &&
              [
                "COMPLETENESS_NOT_SATISFIED",
                "CATEGORY_SELECTION_NO_LONGER_ACTIVE",
                "STORY_FINALISATION_CONFLICT",
              ].includes(error.code)
            ) {
              await tx.inboundEvent.update({
                where: { id: event.id },
                data: {
                  processingStatus: InboundProcessingStatus.IGNORED,
                  processedAt: new Date(),
                  lastErrorCode: error.code,
                  lastErrorMessage: null,
                },
              });
              const reason:
                | "COMPLETENESS_NOT_SATISFIED"
                | "CATEGORY_SELECTION_NO_LONGER_ACTIVE"
                | "STORY_FINALISATION_CONFLICT" = error.code as
                | "COMPLETENESS_NOT_SATISFIED"
                | "CATEGORY_SELECTION_NO_LONGER_ACTIVE"
                | "STORY_FINALISATION_CONFLICT";
              return { outcome: "IGNORED", reason };
            }
            throw error;
          }
        }
        if (storyResult.outcome === "REVISION_INTENT") {
          if (!this.revisions)
            throw new ReporterWorkflowError("INBOUND_EVENT_STATE_CONFLICT");
          try {
            const revised = await this.revisions.reviseInTransaction(tx, {
              inboundEventId: event.id,
              reporterId: authorization.reporterId,
              conversationId: conversation.id,
              storyId: storyResult.storyId,
              expectedStoryVersion: expectedStoryVersion!,
            });
            return { outcome: "PROCESSED", ...revised };
          } catch (error) {
            if (error instanceof Round6RevisionError) {
              await tx.inboundEvent.update({
                where: { id: event.id },
                data: {
                  processingStatus: InboundProcessingStatus.IGNORED,
                  processedAt: new Date(),
                  lastErrorCode: error.code,
                  lastErrorMessage: null,
                },
              });
              return { outcome: "IGNORED", reason: error.code };
            }
            throw error;
          }
        }
        if (storyResult.outcome === "MEDIA_INTENT") {
          return {
            ...storyResult,
            reporterId: authorization.reporterId,
            conversationId: conversation.id,
          };
        }
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
      },
    );
    if (phase.outcome === "FINALISATION_INTENT")
      return this.round6
        ? this.round6.resume(phase.preparationId)
        : {
            outcome: "RETRY_REQUIRED",
            reason: "DRAFT_PREPARATION_UNAVAILABLE",
          };
    if (phase.outcome !== "MEDIA_INTENT") return phase;
    if (!this.mediaStaging)
      return { outcome: "RETRY_REQUIRED", reason: "MEDIA_STAGING_UNAVAILABLE" };
    const staged = await this.mediaStaging.stage(
      phase.mediaId,
      eventId,
      phase.authority,
    );
    if (staged.outcome !== "PROCESSED") return staged;
    return {
      outcome: "PROCESSED",
      reporterId: phase.reporterId,
      conversationId: phase.conversationId,
    };
  }
}
