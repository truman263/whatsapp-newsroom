import { Injectable, Optional } from "@nestjs/common";
import {
  AuditActorType,
  InboundProcessingStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { MediaStagingService } from "../media-staging/media-staging.service";
import { Round7PublishSagaService } from "../publishing/round7-publish-saga.service";
import { supportsInboundProcessingContractVersion } from "./inbound-processing-contract";
import { InboundEventProcessingService } from "./inbound-event-processing.service";
import type {
  InboundRecoveryResult,
  InboundRecoveryRoute,
} from "./reporter-workflow.types";
import { Round6FinalisationService } from "./round6-finalisation.service";
import { Round7ApprovalService } from "./round7-approval.service";

const INTEGER_MAX = 2_147_483_647;

@Injectable()
export class InboundEventRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processing: InboundEventProcessingService,
    @Optional() private readonly media?: MediaStagingService,
    @Optional() private readonly round6?: Round6FinalisationService,
    @Optional() private readonly approvals?: Round7ApprovalService,
    @Optional() private readonly publishing?: Round7PublishSagaService,
  ) {}

  async recoverStale(
    eventId: string,
    staleBefore: Date,
    maxAttempts: number,
  ): Promise<InboundRecoveryResult> {
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 2 ||
      maxAttempts > INTEGER_MAX
    )
      throw new Error("INVALID_RECOVERY_MAX_ATTEMPTS");
    if (
      !(staleBefore instanceof Date) ||
      !Number.isFinite(staleBefore.getTime())
    )
      throw new Error("INVALID_STALE_BEFORE");

    const reclaimed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${eventId}::uuid FOR UPDATE`;
      const event = await tx.inboundEvent.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          reporterId: true,
          processingStatus: true,
          processingStartedAt: true,
          processingAttempts: true,
          processingContractVersion: true,
          senderPhone: true,
          senderIngestSequence: true,
        },
      });
      if (
        !event ||
        event.processingStatus !== InboundProcessingStatus.PROCESSING
      )
        return { outcome: "NOT_PROCESSING" } as const;
      if (
        !event.processingStartedAt ||
        event.processingStartedAt >= staleBefore
      )
        return { outcome: "NOT_STALE" } as const;
      if (
        !supportsInboundProcessingContractVersion(
          event.processingContractVersion,
        )
      ) {
        await this.auditHold(
          tx,
          event.id,
          "UNSUPPORTED_PROCESSING_CONTRACT",
          event.processingAttempts,
          event.processingContractVersion,
        );
        return {
          outcome: "UNSUPPORTED_PROCESSING_CONTRACT",
          operatorHeld: true,
        } as const;
      }
      if (
        event.processingAttempts < 1 ||
        event.processingAttempts >= maxAttempts ||
        event.processingAttempts >= INTEGER_MAX
      ) {
        await this.auditHold(
          tx,
          event.id,
          "RECOVERY_ATTEMPTS_EXHAUSTED",
          event.processingAttempts,
          event.processingContractVersion,
        );
        return {
          outcome: "RECOVERY_ATTEMPTS_EXHAUSTED",
          operatorHeld: true,
        } as const;
      }
      const earlier = await tx.inboundEvent.findFirst({
        where: {
          senderPhone: event.senderPhone,
          senderIngestSequence: { lt: event.senderIngestSequence },
          processingStatus: {
            in: [
              InboundProcessingStatus.RECEIVED,
              InboundProcessingStatus.PROCESSING,
            ],
          },
        },
        select: { id: true },
      });
      if (earlier) return { outcome: "ORDER_BLOCKED" } as const;

      const approval = await tx.approval.findUnique({
        where: { inboundEventId: event.id },
        select: { id: true, publishAttempt: { select: { id: true } } },
      });
      const preparation = await tx.draftPreparation.findUnique({
        where: { inboundEventId: event.id },
        select: { id: true },
      });
      const mediaAudits = await tx.auditLog.findMany({
        where: {
          inboundEventId: event.id,
          eventType: "story_media_associated",
        },
        select: {
          entityId: true,
          entityType: true,
          inboundEventId: true,
          storyId: true,
          reporterId: true,
        },
        take: 2,
      });
      let route: InboundRecoveryRoute;
      let lineageId: string | null = null;
      if (approval) {
        if (!approval.publishAttempt) {
          await this.auditHold(
            tx,
            event.id,
            "LINEAGE_CONFLICT",
            event.processingAttempts,
            event.processingContractVersion,
          );
          return { outcome: "LINEAGE_CONFLICT", operatorHeld: true } as const;
        }
        route = "APPROVAL_PUBLISH";
        lineageId = approval.publishAttempt.id;
      } else if (preparation) {
        route = "DRAFT_PREPARATION";
        lineageId = preparation.id;
      } else if (mediaAudits.length) {
        const audit = mediaAudits[0];
        const media = audit?.entityId
          ? await tx.storyMedia.findUnique({
              where: { id: audit.entityId },
              select: {
                id: true,
                storyId: true,
                story: { select: { reporterId: true } },
              },
            })
          : null;
        if (
          mediaAudits.length !== 1 ||
          !audit ||
          !media ||
          audit.entityType !== "StoryMedia" ||
          audit.inboundEventId !== event.id ||
          !audit.storyId ||
          media.storyId !== audit.storyId ||
          (event.reporterId !== null &&
            event.reporterId !== media.story.reporterId) ||
          (audit.reporterId !== null &&
            audit.reporterId !== media.story.reporterId)
        ) {
          await this.auditHold(
            tx,
            event.id,
            "LINEAGE_CONFLICT",
            event.processingAttempts,
            event.processingContractVersion,
          );
          return { outcome: "LINEAGE_CONFLICT", operatorHeld: true } as const;
        }
        route = "STORY_MEDIA";
        lineageId = audit.entityId;
      } else route = "NO_LINEAGE";

      const before = event.processingAttempts;
      const now = new Date();
      const changed = await tx.inboundEvent.updateMany({
        where: {
          id: event.id,
          processingStatus: InboundProcessingStatus.PROCESSING,
          processingAttempts: before,
          processingContractVersion: event.processingContractVersion,
          processingStartedAt: { lt: staleBefore },
        },
        data: {
          processingAttempts: { increment: 1 },
          processingStartedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (changed.count !== 1) return { outcome: "FENCE_LOST" } as const;
      const claim = {
        eventId: event.id,
        processingAttempt: before + 1,
        processingContractVersion: event.processingContractVersion!,
      };
      await tx.auditLog.create({
        data: {
          eventType: "inbound_recovery_claimed",
          actorType: AuditActorType.SYSTEM,
          inboundEventId: event.id,
          entityType: "InboundEvent",
          entityId: event.id,
          metadata: {
            attemptBefore: before,
            attemptAfter: before + 1,
            processingContractVersion: event.processingContractVersion,
            route,
          },
        },
      });
      return { outcome: "CLAIMED", route, lineageId, claim } as const;
    });

    if (reclaimed.outcome !== "CLAIMED") return reclaimed;
    if (reclaimed.route === "APPROVAL_PUBLISH") {
      const approval = await this.approvals?.recover(reclaimed.claim);
      if (!approval || approval.publishAttemptId !== reclaimed.lineageId)
        return { outcome: "LINEAGE_CONFLICT", operatorHeld: true };
      await this.publishing?.run(approval.publishAttemptId, reclaimed.claim);
    } else if (reclaimed.route === "DRAFT_PREPARATION") {
      if (!this.round6 || !reclaimed.lineageId)
        return { outcome: "LINEAGE_CONFLICT", operatorHeld: true };
      await this.round6.resume(reclaimed.lineageId, reclaimed.claim);
    } else if (reclaimed.route === "STORY_MEDIA") {
      if (!this.media || !reclaimed.lineageId)
        return { outcome: "LINEAGE_CONFLICT", operatorHeld: true };
      await this.media.reconcile(reclaimed.lineageId, reclaimed.claim);
    } else await this.processing.processClaimed(reclaimed.claim);
    return {
      outcome: "RECOVERED",
      route: reclaimed.route,
      claim: reclaimed.claim,
    };
  }

  private async auditHold(
    tx: Prisma.TransactionClient,
    eventId: string,
    reason: string,
    processingAttempt: number,
    processingContractVersion: number | null,
  ): Promise<void> {
    const exists = await tx.auditLog.findFirst({
      where: {
        inboundEventId: eventId,
        eventType: "inbound_recovery_operator_hold",
        metadata: { path: ["reason"], equals: reason },
      },
      select: { id: true },
    });
    if (!exists)
      await tx.auditLog.create({
        data: {
          eventType: "inbound_recovery_operator_hold",
          actorType: AuditActorType.SYSTEM,
          inboundEventId: eventId,
          entityType: "InboundEvent",
          entityId: eventId,
          metadata: { reason, processingAttempt, processingContractVersion },
        },
      });
  }
}
