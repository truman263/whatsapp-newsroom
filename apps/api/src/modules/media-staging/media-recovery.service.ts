import { Injectable } from "@nestjs/common";
import { MediaProcessingStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { MediaStagingService } from "./media-staging.service";
import type { MediaStageResult } from "./media-staging.service";
import type { InboundProcessingClaim } from "../reporter-workflow/inbound-processing-contract";
import { readInboundProcessingClaim } from "../reporter-workflow/inbound-processing-contract";

@Injectable()
export class MediaRecoveryService {
  constructor(
    private readonly staging: MediaStagingService,
    private readonly prisma: PrismaService,
  ) {}
  recover(
    mediaId: string,
    claimOrEventId: InboundProcessingClaim | string,
  ): Promise<MediaStageResult> {
    return this.staging.reconcile(mediaId, claimOrEventId);
  }

  async recoverPending(limit: number): Promise<MediaStageResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("INVALID_MEDIA_RECOVERY_LIMIT");
    const rows = await this.prisma.storyMedia.findMany({
      where: {
        status: {
          in: [MediaProcessingStatus.RECEIVED, MediaProcessingStatus.FETCHING],
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, storyId: true, story: { select: { reporterId: true } } },
    });
    const results: MediaStageResult[] = [];
    for (const row of rows) {
      const lineages = await this.prisma.auditLog.findMany({
        where: {
          entityType: "StoryMedia",
          entityId: row.id,
          eventType: "story_media_associated",
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: 2,
        select: {
          storyId: true,
          reporterId: true,
          inboundEventId: true,
          inboundEvent: { select: { reporterId: true } },
        },
      });
      if (lineages.length !== 1) continue;
      const [lineage] = lineages;
      if (
        !lineage ||
        lineage.storyId !== row.storyId ||
        !lineage.inboundEventId ||
        !lineage.inboundEvent ||
        (lineage.reporterId !== null &&
          lineage.reporterId !== row.story.reporterId) ||
        (lineage.inboundEvent.reporterId !== null &&
          lineage.inboundEvent.reporterId !== row.story.reporterId)
      )
        continue;
      let claim: InboundProcessingClaim;
      try {
        claim = await readInboundProcessingClaim(
          this.prisma,
          lineage.inboundEventId,
        );
      } catch {
        // Stale-inbound recovery/operator handling remains the authority.
        continue;
      }
      results.push(await this.recover(row.id, claim));
    }
    return results;
  }
}
