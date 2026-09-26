import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AuditActorType,
  InboundProcessingStatus,
  MediaProcessingStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import {
  readInboundProcessingClaim,
  requireInboundProcessingClaim,
  type InboundProcessingClaim,
} from "../reporter-workflow/inbound-processing-contract";
import { MEDIA_STAGING_AUDIT } from "./media-staging.audit";
import { MediaStagingError } from "./media-staging.errors";
import {
  MEDIA_OBJECT_STORE,
  MEDIA_PROVIDER_CLIENT,
  mediaObjectKey,
  type MediaAuthority,
  type MediaObjectStore,
  type MediaProviderClient,
} from "./media-staging.types";

export type MediaStageResult =
  | { outcome: "PROCESSED" }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "RETRY_REQUIRED"; reason: string };

@Injectable()
export class MediaStagingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_PROVIDER_CLIENT)
    private readonly provider: MediaProviderClient,
    @Inject(MEDIA_OBJECT_STORE) private readonly store: MediaObjectStore,
  ) {}

  async stage(
    mediaId: string,
    claimOrEventId: InboundProcessingClaim | string,
    authority: MediaAuthority,
  ): Promise<MediaStageResult> {
    const claim =
      typeof claimOrEventId === "string"
        ? await readInboundProcessingClaim(this.prisma, claimOrEventId)
        : claimOrEventId;
    const claimed = await this.prisma.$transaction(async (tx) => {
      await requireInboundProcessingClaim(tx, claim);
      return tx.storyMedia.updateMany({
        where: { id: mediaId, status: MediaProcessingStatus.RECEIVED },
        data: { status: MediaProcessingStatus.FETCHING },
      });
    });
    if (claimed.count !== 1) return this.reconcile(mediaId, claim);
    try {
      const downloaded = await this.provider.fetch(authority);
      const key = mediaObjectKey(mediaId);
      const existing = await this.store.head(key);
      if (existing && !matches(existing, downloaded))
        throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
      if (!existing) await this.store.putIfAbsent(key, downloaded);
      const verified = await this.verify(key, downloaded.mimeType);
      if (!matches(verified, downloaded))
        throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
      return await this.complete(mediaId, claim, verified);
    } catch (error: unknown) {
      const failure =
        error instanceof MediaStagingError
          ? error
          : new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
      if (!failure.definitive)
        return { outcome: "RETRY_REQUIRED", reason: failure.code };
      await this.fail(mediaId, claim, failure.code);
      return { outcome: "FAILED", reason: failure.code };
    }
  }

  async reconcile(
    mediaId: string,
    claimOrEventId: InboundProcessingClaim | string,
  ): Promise<MediaStageResult> {
    if (typeof claimOrEventId === "string") {
      const terminal = await this.prisma.storyMedia.findUnique({
        where: { id: mediaId },
        select: { status: true },
      });
      if (terminal?.status === MediaProcessingStatus.FETCHED) {
        const event = await this.prisma.inboundEvent.findUnique({
          where: { id: claimOrEventId },
          select: { processingStatus: true },
        });
        if (event?.processingStatus === InboundProcessingStatus.PROCESSED)
          return { outcome: "PROCESSED" };
      }
    }
    const claim =
      typeof claimOrEventId === "string"
        ? await readInboundProcessingClaim(this.prisma, claimOrEventId)
        : claimOrEventId;
    const media = await this.prisma.storyMedia.findUniqueOrThrow({
      where: { id: mediaId },
    });
    if (media.status === MediaProcessingStatus.FETCHED) {
      await this.ensureEventProcessed(claim);
      return { outcome: "PROCESSED" };
    }
    if (media.status === MediaProcessingStatus.FAILED)
      return { outcome: "FAILED", reason: "MEDIA_PREVIOUSLY_FAILED" };
    if (!media.mimeType)
      return { outcome: "RETRY_REQUIRED", reason: "MEDIA_OBJECT_UNAVAILABLE" };
    try {
      const verified = await this.verify(
        mediaObjectKey(media.id),
        media.mimeType,
      );
      return await this.complete(media.id, claim, verified);
    } catch (error: unknown) {
      const failure =
        error instanceof MediaStagingError
          ? error
          : new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
      return { outcome: "RETRY_REQUIRED", reason: failure.code };
    }
  }

  private async verify(
    key: string,
    mimeType: string,
  ): Promise<{ size: number; sha256: string; mimeType: string }> {
    return verifyStagedObject(this.store, key, mimeType);
  }

  private async complete(
    mediaId: string,
    claim: InboundProcessingClaim,
    verified: { size: number; sha256: string; mimeType: string },
  ): Promise<MediaStageResult> {
    return this.prisma.$transaction(async (tx) => {
      await requireInboundProcessingClaim(tx, claim);
      await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "id" = ${mediaId}::uuid FOR UPDATE`;
      const media = await tx.storyMedia.findUniqueOrThrow({
        where: { id: mediaId },
      });
      if (media.status === MediaProcessingStatus.FETCHED)
        return { outcome: "PROCESSED" } as const;
      if (
        media.status !== MediaProcessingStatus.FETCHING &&
        media.status !== MediaProcessingStatus.RECEIVED
      )
        throw new MediaStagingError("MEDIA_COMPLETION_CONFLICT", false);
      await tx.storyMedia.update({
        where: { id: media.id },
        data: {
          status: MediaProcessingStatus.FETCHED,
          mimeType: verified.mimeType,
          fileSizeBytes: BigInt(verified.size),
          sha256: verified.sha256,
        },
      });
      const association = await tx.auditLog.findFirstOrThrow({
        where: {
          inboundEventId: claim.eventId,
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
          actorType: AuditActorType.REPORTER,
          reporterId: association.reporterId,
          storyId: media.storyId,
          inboundEventId: claim.eventId,
          entityType: "StoryMedia",
          entityId: media.id,
          metadata: {
            mimeType: verified.mimeType,
            size: verified.size,
            sha256: verified.sha256,
          },
        },
      });
      await tx.inboundEvent.updateMany({
        where: {
          id: claim.eventId,
          processingStatus: InboundProcessingStatus.PROCESSING,
          processingAttempts: claim.processingAttempt,
          processingContractVersion: claim.processingContractVersion,
        },
        data: {
          processingStatus: InboundProcessingStatus.PROCESSED,
          processedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      return { outcome: "PROCESSED" } as const;
    });
  }

  private async fail(
    mediaId: string,
    claim: InboundProcessingClaim,
    code: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await requireInboundProcessingClaim(tx, claim);
      const media = await tx.storyMedia.update({
        where: { id: mediaId },
        data: { status: MediaProcessingStatus.FAILED },
      });
      const association = await tx.auditLog.findFirstOrThrow({
        where: {
          inboundEventId: claim.eventId,
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_FAILED,
          actorType: AuditActorType.REPORTER,
          reporterId: association.reporterId,
          storyId: media.storyId,
          inboundEventId: claim.eventId,
          entityType: "StoryMedia",
          entityId: media.id,
          metadata: { code },
        },
      });
      await tx.inboundEvent.update({
        where: { id: claim.eventId },
        data: {
          processingStatus: InboundProcessingStatus.FAILED,
          processedAt: new Date(),
          lastErrorCode: code,
          lastErrorMessage: null,
        },
      });
    });
  }

  private async ensureEventProcessed(
    claim: InboundProcessingClaim,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await requireInboundProcessingClaim(tx, claim);
      await tx.inboundEvent.update({
        where: { id: claim.eventId },
        data: {
          processingStatus: InboundProcessingStatus.PROCESSED,
          processedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
  }
}

export async function verifyStagedObject(
  store: MediaObjectStore,
  key: string,
  mimeType: string,
): Promise<{ size: number; sha256: string; mimeType: string }> {
  const head = await store.head(key);
  if (!head || head.size < 1)
    throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
  const bytes = await store.read(key);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== head.size ||
    sha256 !== head.sha256 ||
    head.mimeType !== mimeType
  )
    throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
  return { size: bytes.length, sha256, mimeType };
}

function matches(
  left: { size: number; sha256: string; mimeType: string },
  right: { size: number; sha256: string; mimeType: string },
): boolean {
  return (
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.mimeType === right.mimeType
  );
}
