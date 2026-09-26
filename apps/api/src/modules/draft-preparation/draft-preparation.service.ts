import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Prisma,
  PublishAttemptStatus,
  PublishOperation,
  ReporterStatus,
  StoryStatus,
  type DraftPreparation,
  type PublishAttempt,
  type StoryMedia,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../../config/configuration";
import { PrismaService } from "../../database/prisma.service";
import {
  readInboundProcessingClaim,
  requireInboundProcessingClaim,
  type InboundProcessingClaim,
} from "../reporter-workflow/inbound-processing-contract";
import {
  MEDIA_OBJECT_STORE,
  mediaObjectKey,
  type MediaObjectStore,
} from "../media-staging/media-staging.types";
import { UnconfiguredMediaObjectStore } from "../media-staging/unconfigured-media-object-store";
import {
  draftStateFingerprint,
  type CanonicalDraftState,
} from "../wordpress-draft/wordpress-draft-state";
import { WordPressDraftClient } from "../wordpress-draft/wordpress-draft.client";
import { WordPressDraftError } from "../wordpress-draft/wordpress-draft.errors";
import { WordPressMediaClient } from "../wordpress-media/wordpress-media.client";
import { WordPressMediaError } from "../wordpress-media/wordpress-media.errors";
import {
  DraftPreparationError,
  type DraftPreparationCode,
} from "./draft-preparation.errors";
import type {
  FinalizeDraftInput,
  FinalizeDraftResult,
  PreparationOutcome,
  PreparedAuthority,
} from "./draft-preparation.types";

const APPROVED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9a-f]{64}$/u;

type Aggregate = Prisma.StoryGetPayload<{
  include: {
    reporter: true;
    activeInConversation: true;
    categories: { include: { category: true } };
    media: true;
  };
}>;

@Injectable()
export class DraftPreparationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ApplicationConfiguration, true>,
    @Inject(MEDIA_OBJECT_STORE) private readonly objects: MediaObjectStore,
    private readonly drafts: WordPressDraftClient,
    private readonly mediaClient: WordPressMediaClient,
  ) {}

  async finalizeInTransaction(
    tx: Prisma.TransactionClient,
    input: FinalizeDraftInput,
  ): Promise<FinalizeDraftResult> {
    await this.lockPhaseA(tx, input);
    const event = await tx.inboundEvent.findUnique({
      where: { id: input.inboundEventId },
    });
    const reporter = await tx.reporter.findUnique({
      where: { id: input.reporterId },
    });
    const conversation = await tx.conversation.findUnique({
      where: { id: input.conversationId },
    });
    const story = await tx.story.findUnique({
      where: { id: input.storyId },
      include: {
        categories: {
          include: { category: true },
          orderBy: { categoryId: "asc" },
        },
        media: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      },
    });
    if (
      !event ||
      event.processingStatus !== InboundProcessingStatus.PROCESSING ||
      event.reporterId !== input.reporterId ||
      !reporter ||
      reporter.status !== ReporterStatus.ACTIVE ||
      !conversation ||
      conversation.reporterId !== input.reporterId ||
      conversation.currentStoryId !== input.storyId ||
      conversation.state !== ConversationState.COLLECTING_MEDIA ||
      !story ||
      story.reporterId !== input.reporterId ||
      story.status !== StoryStatus.COLLECTING ||
      story.version !== input.expectedStoryVersion
    )
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    const supersededAuthority = await tx.draftPreparation.findFirst({
      where: {
        storyId: story.id,
        status: DraftPreparationStatus.SUPERSEDED,
        storyVersion: { lt: story.version },
        wordpressPostId: story.wordpressPostId,
        wordpressAppliedVersion: { not: null },
        approvalPromptOutboundMessageId: { not: null },
      },
      orderBy: { storyVersion: "desc" },
      select: { wordpressAppliedVersion: true },
    });
    const retainedMediaAuthority =
      !!story.wordpressPostId &&
      !!supersededAuthority?.wordpressAppliedVersion &&
      VERSION.test(supersededAuthority.wordpressAppliedVersion);
    const incomplete =
      !story.headline?.trim() ||
      !story.body?.trim() ||
      !story.byline?.trim() ||
      story.categories.length === 0 ||
      story.media.some(
        (item) =>
          !item.mimeType ||
          !APPROVED_MIME.has(item.mimeType) ||
          item.fileSizeBytes === null ||
          item.fileSizeBytes <= 0n ||
          !item.sha256 ||
          !SHA256.test(item.sha256) ||
          (item.status !== MediaProcessingStatus.FETCHED &&
            !(
              item.status === MediaProcessingStatus.UPLOADED &&
              retainedMediaAuthority &&
              item.wordpressMediaId !== null &&
              item.wordpressMediaId > 0n
            )),
      );
    if (incomplete) {
      await this.audit(tx, "story_finalisation_rejected_incomplete", input, {
        count: story.media.length,
      });
      throw new DraftPreparationError("COMPLETENESS_NOT_SATISFIED");
    }
    if (
      story.categories.some(
        (item) =>
          !item.category ||
          item.category.status !== EditorialCategoryStatus.ACTIVE,
      )
    ) {
      await this.audit(
        tx,
        "story_finalisation_rejected_inactive_category",
        input,
        { categoryIds: story.categories.map((item) => item.categoryId) },
      );
      throw new DraftPreparationError("CATEGORY_SELECTION_NO_LONGER_ACTIVE");
    }
    const existing = await tx.draftPreparation.findFirst({
      where: { storyId: story.id, storyVersion: { gte: story.version + 1 } },
      orderBy: { storyVersion: "desc" },
    });
    if (existing)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    const id = randomUUID();
    const storyVersion = story.version + 1;
    const previewExpiresAt = new Date(
      Date.now() +
        this.config.get("preview.ttlSeconds", { infer: true }) * 1000,
    );
    const changed = await tx.story.updateMany({
      where: {
        id: story.id,
        status: StoryStatus.COLLECTING,
        version: story.version,
      },
      data: { status: StoryStatus.READY, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
    const preparation = await tx.draftPreparation.create({
      data: {
        id,
        storyId: story.id,
        inboundEventId: event.id,
        storyVersion,
        status: DraftPreparationStatus.ACTIVE,
        approvalPromptCorrelationKey: `round6:approval-prompt:${id}`,
        previewExpiresAt,
      },
    });
    await this.audit(tx, "story_finalisation_requested", input, {
      storyVersionBefore: story.version,
      storyVersionAfter: storyVersion,
    });
    await this.audit(
      tx,
      "draft_preparation_started",
      input,
      {
        draftPreparationId: preparation.id,
        storyVersion,
        mediaIds: story.media.map((item) => item.id),
      },
      "DraftPreparation",
      preparation.id,
    );
    return {
      preparationId: preparation.id,
      storyId: story.id,
      storyVersion,
      previewExpiresAt,
    };
  }

  async prepare(
    preparationId: string,
    claim?: InboundProcessingClaim,
  ): Promise<PreparationOutcome> {
    if (!claim) {
      const row = await this.prisma.draftPreparation.findUniqueOrThrow({
        where: { id: preparationId },
      });
      if (
        [
          DraftPreparationStatus.FAILED,
          DraftPreparationStatus.READY_FOR_APPROVAL,
          DraftPreparationStatus.SUPERSEDED,
        ].some((status) => status === row.status)
      )
        return { preparationId, outcome: "TERMINAL" };
      claim = await readInboundProcessingClaim(this.prisma, row.inboundEventId);
    }
    try {
      let aggregate = await this.revalidate(preparationId, true, false, claim);
      if (
        aggregate.preparation.status === DraftPreparationStatus.FAILED ||
        aggregate.preparation.status ===
          DraftPreparationStatus.READY_FOR_APPROVAL ||
        aggregate.preparation.status === DraftPreparationStatus.SUPERSEDED
      )
        return { preparationId, outcome: "TERMINAL" };
      if (aggregate.story.status === StoryStatus.READY) {
        await this.prisma.$transaction(async (tx) => {
          await this.lockStoryPreparation(
            tx,
            aggregate.story.id,
            preparationId,
            claim,
          );
          await tx.story.updateMany({
            where: {
              id: aggregate.story.id,
              version: aggregate.preparation.storyVersion,
              status: StoryStatus.READY,
            },
            data: { status: StoryStatus.DRAFT_CREATING },
          });
          await tx.draftPreparation.update({
            where: { id: preparationId },
            data: {
              status: DraftPreparationStatus.ACTIVE,
              lastErrorCode: null,
            },
          });
        });
      }
      aggregate = await this.revalidate(preparationId, true, false, claim);
      for (const item of aggregate.story.media)
        await this.reconcileMedia(aggregate.preparation, item, claim);
      aggregate = await this.revalidate(preparationId, true, false, claim);
      const postId = await this.reconcileDraftIdentity(aggregate, claim);
      aggregate = await this.revalidate(preparationId, true, false, claim);
      const desired = this.desiredState(aggregate.story);
      await this.reconcileDraftState(
        aggregate.preparation,
        aggregate.story.id,
        aggregate.story.wordpressDraftKey,
        postId,
        desired,
        claim,
      );
      return { preparationId, outcome: "PREPARED" };
    } catch (error) {
      if (error instanceof DraftPreparationError)
        return this.persistFailure(preparationId, error.code, claim);
      return this.persistFailure(
        preparationId,
        "WORDPRESS_DRAFT_RECONCILIATION_REQUIRED",
        claim,
      );
    }
  }

  async recoverPreparation(preparationId: string): Promise<PreparationOutcome> {
    const row = await this.prisma.draftPreparation.findUniqueOrThrow({
      where: { id: preparationId },
      select: { inboundEventId: true },
    });
    const claim = await readInboundProcessingClaim(
      this.prisma,
      row.inboundEventId,
    );
    return this.prepare(preparationId, claim);
  }

  async recoverUnfinished(limit: number): Promise<PreparationOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("INVALID_RECOVERY_LIMIT");
    const rows = await this.prisma.draftPreparation.findMany({
      where: {
        status: {
          in: [
            DraftPreparationStatus.ACTIVE,
            DraftPreparationStatus.RECONCILIATION_REQUIRED,
          ],
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    const results: PreparationOutcome[] = [];
    for (const row of rows) results.push(await this.recoverPreparation(row.id));
    return results;
  }

  async verifyPreparedAuthority(
    preparationId: string,
    claim?: InboundProcessingClaim,
  ): Promise<PreparedAuthority> {
    if (!claim) {
      const row = await this.prisma.draftPreparation.findUniqueOrThrow({
        where: { id: preparationId },
        include: { inboundEvent: true },
      });
      if (
        row.inboundEvent.processingStatus === InboundProcessingStatus.PROCESSING
      )
        claim = await readInboundProcessingClaim(
          this.prisma,
          row.inboundEventId,
        );
    }
    const aggregate = await this.revalidate(preparationId, false, true, claim);
    const prep = aggregate.preparation;
    if (
      !new Set<DraftPreparationStatus>([
        DraftPreparationStatus.ACTIVE,
        DraftPreparationStatus.READY_FOR_APPROVAL,
      ]).has(prep.status) ||
      !prep.wordpressAppliedVersion ||
      !VERSION.test(prep.wordpressAppliedVersion) ||
      !new Set<StoryStatus>([
        StoryStatus.DRAFT_CREATED,
        StoryStatus.AWAITING_APPROVAL,
      ]).has(aggregate.story.status) ||
      !aggregate.story.wordpressPostId ||
      prep.wordpressPostId !== aggregate.story.wordpressPostId ||
      aggregate.story.media.some(
        (item) =>
          item.status !== MediaProcessingStatus.UPLOADED ||
          !item.wordpressMediaId ||
          item.wordpressMediaId <= 0n,
      )
    )
      throw new DraftPreparationError("WORDPRESS_STATE_MISMATCH");
    const desired = this.desiredState(aggregate.story);
    try {
      const remote = await this.drafts.getDraftState(
        aggregate.story.wordpressDraftKey,
      );
      if (
        remote.post_id !== Number(prep.wordpressPostId) ||
        remote.applied_version !== prep.wordpressAppliedVersion ||
        !stateEqual(remote, desired)
      )
        throw new Error("mismatch");
    } catch {
      await this.persistFailure(
        preparationId,
        "WORDPRESS_STATE_MISMATCH",
        claim,
      );
      throw new DraftPreparationError("WORDPRESS_STATE_MISMATCH");
    }
    return {
      preparationId,
      storyId: aggregate.story.id,
      storyVersion: prep.storyVersion,
      wordpressPostId: Number(prep.wordpressPostId),
      wordpressAppliedVersion: prep.wordpressAppliedVersion,
      previewExpiresAt: prep.previewExpiresAt,
      state: desired,
    };
  }

  private async revalidate(
    preparationId: string,
    retryBlocked: boolean,
    allowPhaseE = false,
    claim?: InboundProcessingClaim,
  ): Promise<{ preparation: DraftPreparation; story: Aggregate }> {
    return this.prisma.$transaction(async (tx) => {
      const prepRow = await tx.draftPreparation.findUnique({
        where: { id: preparationId },
        select: { storyId: true },
      });
      if (!prepRow)
        throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
      if (claim) await requireInboundProcessingClaim(tx, claim);
      await this.lockWorkerAggregate(tx, preparationId, prepRow.storyId);
      const preparation = await tx.draftPreparation.findUniqueOrThrow({
        where: { id: preparationId },
      });
      const story = await tx.story.findUnique({
        where: { id: preparation.storyId },
        include: {
          reporter: true,
          activeInConversation: true,
          categories: {
            include: { category: true },
            orderBy: { categoryId: "asc" },
          },
          media: { orderBy: [{ position: "asc" }, { id: "asc" }] },
        },
      });
      const event = await tx.inboundEvent.findUnique({
        where: { id: preparation.inboundEventId },
      });
      const phaseBPosture =
        new Set<StoryStatus>([
          StoryStatus.READY,
          StoryStatus.DRAFT_CREATING,
          StoryStatus.DRAFT_CREATED,
        ]).has(story?.status as StoryStatus) &&
        event?.processingStatus === InboundProcessingStatus.PROCESSING &&
        story?.activeInConversation?.state ===
          ConversationState.COLLECTING_MEDIA;
      const phaseEPosture =
        allowPhaseE &&
        preparation.status === DraftPreparationStatus.READY_FOR_APPROVAL &&
        story?.status === StoryStatus.AWAITING_APPROVAL &&
        event?.processingStatus === InboundProcessingStatus.PROCESSED &&
        story?.activeInConversation?.state ===
          ConversationState.AWAITING_APPROVAL;
      if (
        !story ||
        story.version !== preparation.storyVersion ||
        (!phaseBPosture && !phaseEPosture) ||
        !event ||
        event.reporterId !== story.reporterId ||
        story.reporter.status !== ReporterStatus.ACTIVE ||
        !story.activeInConversation ||
        story.activeInConversation.reporterId !== story.reporterId ||
        story.activeInConversation.currentStoryId !== story.id
      ) {
        if (story?.reporter.status === ReporterStatus.INACTIVE)
          throw new DraftPreparationError("REPORTER_NOT_ACTIVE");
        throw new DraftPreparationError("STORY_FINALISATION_CONFLICT");
      }
      if (
        preparation.status === DraftPreparationStatus.BLOCKED &&
        !retryBlocked
      )
        throw new DraftPreparationError(
          (preparation.lastErrorCode as DraftPreparationCode | null) ??
            "STORY_FINALISATION_CONFLICT",
        );
      if (
        story.categories.some(
          (item) => item.category.status !== EditorialCategoryStatus.ACTIVE,
        )
      )
        throw new DraftPreparationError("CATEGORY_SELECTION_NO_LONGER_ACTIVE");
      return { preparation, story };
    });
  }

  private async reconcileMedia(
    preparation: DraftPreparation,
    item: StoryMedia,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    if (this.objects instanceof UnconfiguredMediaObjectStore)
      throw new DraftPreparationError("MEDIA_OBJECT_STORE_UNCONFIGURED");
    if (
      !item.mimeType ||
      !APPROVED_MIME.has(item.mimeType) ||
      item.fileSizeBytes === null ||
      item.fileSizeBytes <= 0n ||
      !item.sha256 ||
      !SHA256.test(item.sha256)
    )
      throw new DraftPreparationError("MEDIA_BYTES_INTEGRITY_FAILURE");
    if (item.status === MediaProcessingStatus.UPLOADED) {
      if (!item.wordpressMediaId || item.wordpressMediaId <= 0n)
        throw new DraftPreparationError("WORDPRESS_MEDIA_IDENTITY_CONFLICT");
      try {
        const remote = await this.mediaClient.getMediaByKey(item.id);
        if (remote.attachmentId !== Number(item.wordpressMediaId))
          throw new DraftPreparationError("WORDPRESS_MEDIA_IDENTITY_CONFLICT");
        return;
      } catch (error) {
        throw mapMediaError(error, true);
      }
    }
    let recoveryNotFound = item.status === MediaProcessingStatus.FETCHED;
    if (item.status === MediaProcessingStatus.UPLOADING) {
      try {
        const remote = await this.mediaClient.getMediaByKey(item.id);
        await this.persistMedia(preparation, item, remote.attachmentId, claim);
        return;
      } catch (error) {
        if (error instanceof WordPressMediaError && error.code === "NOT_FOUND")
          recoveryNotFound = true;
        else throw mapMediaError(error, false);
      }
    }
    if (!recoveryNotFound)
      throw new DraftPreparationError("MEDIA_BYTES_INTEGRITY_FAILURE");
    const bytes = await this.verifiedBytes(item);
    if (item.status === MediaProcessingStatus.FETCHED)
      await this.prisma.$transaction(async (tx) => {
        await this.lockStoryPreparation(
          tx,
          item.storyId,
          preparation.id,
          claim,
        );
        await tx.storyMedia.updateMany({
          where: {
            id: item.id,
            storyId: item.storyId,
            status: MediaProcessingStatus.FETCHED,
          },
          data: { status: MediaProcessingStatus.UPLOADING },
        });
      });
    try {
      const result = await this.mediaClient.uploadMedia({
        mediaKey: item.id,
        filename: `${item.id}.${MIME_EXTENSION[item.mimeType]}`,
        mimeType: item.mimeType,
        body: bytes,
      });
      await this.persistMedia(preparation, item, result.attachmentId, claim);
    } catch (error) {
      throw mapMediaError(error, false);
    }
  }

  private async verifiedBytes(item: StoryMedia): Promise<Buffer> {
    const key = mediaObjectKey(item.id);
    let head;
    let bytes: Buffer;
    try {
      head = await this.objects.head(key);
      if (!head) throw new DraftPreparationError("MEDIA_BYTES_UNAVAILABLE");
      bytes = await this.objects.read(key);
    } catch (error) {
      if (error instanceof DraftPreparationError) throw error;
      throw new DraftPreparationError("MEDIA_BYTES_UNAVAILABLE");
    }
    const expected = Number(item.fileSizeBytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      head.size !== expected ||
      bytes.length !== expected ||
      head.mimeType !== item.mimeType ||
      head.sha256 !== item.sha256 ||
      digest !== item.sha256
    )
      throw new DraftPreparationError("MEDIA_BYTES_INTEGRITY_FAILURE");
    return bytes;
  }

  private async persistMedia(
    preparation: DraftPreparation,
    item: StoryMedia,
    attachmentId: number,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockStoryPreparation(tx, item.storyId, preparation.id, claim);
      await tx.storyMedia.update({
        where: { id: item.id },
        data: {
          wordpressMediaId: BigInt(attachmentId),
          status: MediaProcessingStatus.UPLOADED,
        },
      });
      await tx.auditLog.create({
        data: {
          eventType: "wordpress_media_reconciled",
          actorType: AuditActorType.SYSTEM,
          storyId: item.storyId,
          inboundEventId: preparation.inboundEventId,
          entityType: "StoryMedia",
          entityId: item.id,
          metadata: { position: item.position, wordpressMediaId: attachmentId },
        },
      });
    });
  }

  private async reconcileDraftIdentity(
    aggregate: {
      preparation: DraftPreparation;
      story: Aggregate;
    },
    claim?: InboundProcessingClaim,
  ): Promise<number> {
    const { preparation, story } = aggregate;
    if (story.wordpressPostId) {
      if (
        preparation.wordpressPostId &&
        preparation.wordpressPostId !== story.wordpressPostId
      )
        throw new DraftPreparationError("WORDPRESS_DRAFT_IDENTITY_CONFLICT");
      try {
        const remote = await this.drafts.getDraftByKey(story.wordpressDraftKey);
        if (remote.wordpressPostId !== Number(story.wordpressPostId))
          throw new DraftPreparationError("WORDPRESS_DRAFT_IDENTITY_CONFLICT");
        const existingAttempt = await this.prisma.publishAttempt.findUnique({
          where: { idempotencyKey: `draft-create:${preparation.id}` },
        });
        await this.persistDraftIdentity(
          preparation,
          story.id,
          remote.wordpressPostId,
          existingAttempt?.id ?? null,
          claim,
        );
        return remote.wordpressPostId;
      } catch (error) {
        throw mapDraftError(error, true);
      }
    }
    const attempt = await this.claimAttempt(
      preparation,
      PublishOperation.CREATE_DRAFT,
      `draft-create:${preparation.id}`,
      claim,
    );
    let result;
    try {
      try {
        const found = await this.drafts.getDraftByKey(story.wordpressDraftKey);
        result = { wordpressPostId: found.wordpressPostId };
      } catch (error) {
        if (error instanceof WordPressDraftError && error.code === "NOT_FOUND")
          result = await this.drafts.createDraft({
            wordpressDraftKey: story.wordpressDraftKey,
            headline: story.headline!,
            body: story.body!,
            excerpt: "",
            wordpressCategoryIds: wordpressCategories(story),
          });
        else throw error;
      }
    } catch (error) {
      await this.updateAttempt(
        attempt.id,
        mapDraftError(error, false).code,
        claim,
      );
      throw mapDraftError(error, false);
    }
    await this.persistDraftIdentity(
      preparation,
      story.id,
      result.wordpressPostId,
      attempt.id,
      claim,
    );
    return result.wordpressPostId;
  }

  private async persistDraftIdentity(
    preparation: DraftPreparation,
    storyId: string,
    postId: number,
    attemptId: string | null,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockStoryPreparation(tx, storyId, preparation.id, claim);
      const story = await tx.story.findUniqueOrThrow({
        where: { id: storyId },
      });
      if (story.wordpressPostId && story.wordpressPostId !== BigInt(postId))
        throw new DraftPreparationError("WORDPRESS_DRAFT_IDENTITY_CONFLICT");
      await tx.story.update({
        where: { id: storyId },
        data: {
          wordpressPostId: BigInt(postId),
          status: StoryStatus.DRAFT_CREATED,
          draftCreatedAt: story.draftCreatedAt ?? new Date(),
        },
      });
      await tx.draftPreparation.update({
        where: { id: preparation.id },
        data: {
          wordpressPostId: BigInt(postId),
          status: DraftPreparationStatus.ACTIVE,
          lastErrorCode: null,
        },
      });
      if (attemptId)
        await tx.publishAttempt.update({
          where: { id: attemptId },
          data: {
            status: PublishAttemptStatus.SUCCEEDED,
            wordpressPostId: BigInt(postId),
            completedAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
      await tx.auditLog.create({
        data: {
          eventType: "wordpress_draft_created",
          actorType: AuditActorType.SYSTEM,
          storyId,
          inboundEventId: preparation.inboundEventId,
          entityType: "DraftPreparation",
          entityId: preparation.id,
          metadata: { wordpressPostId: postId },
        },
      });
    });
  }

  private async reconcileDraftState(
    preparation: DraftPreparation,
    storyId: string,
    key: string,
    postId: number,
    desired: CanonicalDraftState,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    const attempt = await this.claimAttempt(
      preparation,
      PublishOperation.SYNC_DRAFT,
      `draft-sync:${preparation.id}:${preparation.storyVersion}`,
      claim,
    );
    try {
      let current = await this.drafts.getDraftState(key);
      if (current.post_id !== postId)
        throw new DraftPreparationError("WORDPRESS_DRAFT_IDENTITY_CONFLICT");
      if (!stateEqual(current, desired)) {
        try {
          await this.drafts.syncDraft({
            wordpressDraftKey: key,
            headline: desired.title,
            body: desired.content,
            excerpt: desired.excerpt,
            wordpressCategoryIds: desired.categories,
            editorialByline: desired.editorial_byline,
            featuredMediaKey: desired.featured_media_key,
            expectedVersion: current.applied_version,
          });
        } catch (error) {
          if (
            !(error instanceof WordPressDraftError) ||
            error.code !== "STALE_VERSION"
          )
            throw error;
          current = await this.drafts.getDraftState(key);
          if (!stateEqual(current, desired))
            await this.drafts.syncDraft({
              wordpressDraftKey: key,
              headline: desired.title,
              body: desired.content,
              excerpt: desired.excerpt,
              wordpressCategoryIds: desired.categories,
              editorialByline: desired.editorial_byline,
              featuredMediaKey: desired.featured_media_key,
              expectedVersion: current.applied_version,
            });
        }
      }
      const final = await this.drafts.getDraftState(key);
      const version = draftStateFingerprint(desired);
      if (
        final.post_id !== postId ||
        final.applied_version !== version ||
        !stateEqual(final, desired)
      )
        throw new DraftPreparationError("WORDPRESS_STATE_MISMATCH");
      await this.prisma.$transaction(async (tx) => {
        await this.lockStoryPreparationAttempt(
          tx,
          storyId,
          preparation.id,
          attempt.id,
          claim,
        );
        await tx.draftPreparation.update({
          where: { id: preparation.id },
          data: {
            wordpressAppliedVersion: version,
            status: DraftPreparationStatus.ACTIVE,
            lastErrorCode: null,
          },
        });
        await tx.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PublishAttemptStatus.SUCCEEDED,
            wordpressPostId: BigInt(postId),
            completedAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
        await tx.auditLog.create({
          data: {
            eventType: "wordpress_draft_reconciled",
            actorType: AuditActorType.SYSTEM,
            storyId,
            inboundEventId: preparation.inboundEventId,
            entityType: "DraftPreparation",
            entityId: preparation.id,
            metadata: { wordpressPostId: postId },
          },
        });
      });
    } catch (error) {
      const mapped =
        error instanceof DraftPreparationError
          ? error
          : mapDraftError(error, false);
      await this.updateAttempt(attempt.id, mapped.code, claim);
      throw mapped;
    }
  }

  private desiredState(story: Aggregate): CanonicalDraftState {
    if (
      !story.headline?.trim() ||
      !story.body?.trim() ||
      !story.byline?.trim() ||
      [...story.byline].length > 200
    )
      throw new DraftPreparationError("COMPLETENESS_NOT_SATISFIED");
    return {
      title: story.headline,
      content: story.body,
      excerpt: "",
      categories: wordpressCategories(story),
      editorial_byline: story.byline,
      featured_media_key: story.media[0]?.id ?? null,
    };
  }

  private async claimAttempt(
    preparation: DraftPreparation,
    operation: PublishOperation,
    idempotencyKey: string,
    claim?: InboundProcessingClaim,
  ): Promise<PublishAttempt> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockStoryPreparation(
        tx,
        preparation.storyId,
        preparation.id,
        claim,
      );
      let attempt = await tx.publishAttempt.findUnique({
        where: { idempotencyKey },
      });
      if (!attempt) {
        const latest = await tx.publishAttempt.aggregate({
          where: { storyId: preparation.storyId, operation },
          _max: { attemptNumber: true },
        });
        attempt = await tx.publishAttempt.create({
          data: {
            storyId: preparation.storyId,
            operation,
            attemptNumber: (latest._max.attemptNumber ?? 0) + 1,
            idempotencyKey,
            status: PublishAttemptStatus.PENDING,
            errorMessage: null,
          },
        });
      }
      if (attempt.status !== PublishAttemptStatus.SUCCEEDED)
        attempt = await tx.publishAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PublishAttemptStatus.IN_PROGRESS,
            startedAt: attempt.startedAt ?? new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
      return attempt;
    });
  }

  private async updateAttempt(
    id: string,
    code: DraftPreparationCode,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (claim) await requireInboundProcessingClaim(tx, claim);
      await tx.publishAttempt.update({
        where: { id },
        data: {
          status:
            statusFor(code) === DraftPreparationStatus.RECONCILIATION_REQUIRED
              ? PublishAttemptStatus.RECONCILIATION_REQUIRED
              : PublishAttemptStatus.FAILED,
          errorCode: code,
          errorMessage: null,
        },
      });
    });
  }

  private async persistFailure(
    preparationId: string,
    code: DraftPreparationCode,
    claim?: InboundProcessingClaim,
  ): Promise<PreparationOutcome> {
    const status = statusFor(code);
    const existing = await this.prisma.draftPreparation.findUnique({
      where: { id: preparationId },
      select: { storyId: true, inboundEventId: true },
    });
    if (existing)
      await this.prisma.$transaction(async (tx) => {
        await this.lockStoryPreparation(
          tx,
          existing.storyId,
          preparationId,
          claim,
        );
        await tx.draftPreparation.update({
          where: { id: preparationId },
          data: {
            status,
            lastErrorCode: code,
            failedAt:
              status === DraftPreparationStatus.FAILED ? new Date() : null,
          },
        });
        if (
          status === DraftPreparationStatus.FAILED &&
          [
            "MEDIA_BYTES_INTEGRITY_FAILURE",
            "WORDPRESS_MEDIA_IDENTITY_CONFLICT",
            "WORDPRESS_DRAFT_IDENTITY_CONFLICT",
          ].includes(code)
        )
          await tx.story.update({
            where: { id: existing.storyId },
            data: { status: StoryStatus.FAILED, failedAt: new Date() },
          });
        await tx.auditLog.create({
          data: {
            eventType:
              status === DraftPreparationStatus.BLOCKED
                ? "draft_preparation_blocked"
                : "draft_preparation_reconciliation_required",
            actorType: AuditActorType.SYSTEM,
            storyId: existing.storyId,
            inboundEventId: existing.inboundEventId,
            entityType: "DraftPreparation",
            entityId: preparationId,
            metadata: { errorCode: code },
          },
        });
      });
    return {
      preparationId,
      outcome:
        status === DraftPreparationStatus.BLOCKED
          ? "BLOCKED"
          : status === DraftPreparationStatus.FAILED
            ? "FAILED"
            : "RECONCILIATION_REQUIRED",
      errorCode: code,
    };
  }

  private async lockPhaseA(
    tx: Prisma.TransactionClient,
    input: FinalizeDraftInput,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${input.inboundEventId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Reporter" WHERE "id"=${input.reporterId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${input.conversationId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${input.storyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT ec."id" FROM "EditorialCategory" ec JOIN "StoryCategory" sc ON sc."categoryId"=ec."id" WHERE sc."storyId"=${input.storyId}::uuid ORDER BY ec."id" FOR UPDATE OF ec`;
    await tx.$queryRaw`SELECT "storyId","categoryId" FROM "StoryCategory" WHERE "storyId"=${input.storyId}::uuid ORDER BY "categoryId" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "storyId"=${input.storyId}::uuid ORDER BY "position","id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "storyId"=${input.storyId}::uuid ORDER BY "storyVersion","id" FOR UPDATE`;
  }

  private async lockWorkerAggregate(
    tx: Prisma.TransactionClient,
    preparationId: string,
    storyId: string,
  ): Promise<void> {
    const event = await tx.draftPreparation.findUniqueOrThrow({
      where: { id: preparationId },
      select: { inboundEventId: true },
    });
    const story = await tx.story.findUniqueOrThrow({
      where: { id: storyId },
      select: { reporterId: true },
    });
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { reporterId: story.reporterId },
      select: { id: true },
    });
    await this.lockPhaseA(tx, {
      inboundEventId: event.inboundEventId,
      reporterId: story.reporterId,
      conversationId: conversation.id,
      storyId,
      expectedStoryVersion: 0,
    });
    await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "storyId"=${storyId}::uuid ORDER BY "operation","attemptNumber","id" FOR UPDATE`;
  }

  private async lockStoryPreparation(
    tx: Prisma.TransactionClient,
    storyId: string,
    preparationId: string,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    if (claim) await requireInboundProcessingClaim(tx, claim);
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${storyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${preparationId}::uuid FOR UPDATE`;
  }
  private async lockStoryPreparationAttempt(
    tx: Prisma.TransactionClient,
    storyId: string,
    preparationId: string,
    attemptId: string,
    claim?: InboundProcessingClaim,
  ): Promise<void> {
    await this.lockStoryPreparation(tx, storyId, preparationId, claim);
    await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "id"=${attemptId}::uuid FOR UPDATE`;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    eventType: string,
    input: FinalizeDraftInput,
    metadata: Prisma.InputJsonObject,
    entityType = "Story",
    entityId = input.storyId,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        eventType,
        actorType: AuditActorType.SYSTEM,
        reporterId: input.reporterId,
        storyId: input.storyId,
        inboundEventId: input.inboundEventId,
        entityType,
        entityId,
        metadata,
      },
    });
  }
}

function wordpressCategories(story: Aggregate): number[] {
  const values = story.categories.map((item) =>
    Number(item.category.wordpressCategoryId),
  );
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new DraftPreparationError("CATEGORY_SELECTION_NO_LONGER_ACTIVE");
  return [...new Set(values)].sort((a, b) => a - b);
}
function stateEqual(
  actual: CanonicalDraftState,
  expected: CanonicalDraftState,
): boolean {
  return (
    actual.title === expected.title &&
    actual.content === expected.content &&
    actual.excerpt === expected.excerpt &&
    actual.editorial_byline === expected.editorial_byline &&
    actual.featured_media_key === expected.featured_media_key &&
    actual.categories.length === expected.categories.length &&
    actual.categories.every(
      (value, index) => value === expected.categories[index],
    )
  );
}
function statusFor(code: DraftPreparationCode): DraftPreparationStatus {
  if (
    [
      "MEDIA_BYTES_INTEGRITY_FAILURE",
      "WORDPRESS_MEDIA_IDENTITY_CONFLICT",
      "WORDPRESS_DRAFT_IDENTITY_CONFLICT",
    ].includes(code)
  )
    return DraftPreparationStatus.FAILED;
  if (
    [
      "REPORTER_NOT_ACTIVE",
      "CATEGORY_SELECTION_NO_LONGER_ACTIVE",
      "MEDIA_OBJECT_STORE_UNCONFIGURED",
      "MEDIA_BYTES_UNAVAILABLE",
      "WORDPRESS_MEDIA_BLOCKED",
      "WORDPRESS_DRAFT_BLOCKED",
    ].includes(code)
  )
    return DraftPreparationStatus.BLOCKED;
  return DraftPreparationStatus.RECONCILIATION_REQUIRED;
}
function mapMediaError(
  error: unknown,
  existing: boolean,
): DraftPreparationError {
  if (error instanceof DraftPreparationError) return error;
  if (!(error instanceof WordPressMediaError))
    return new DraftPreparationError("WORDPRESS_MEDIA_RECONCILIATION_REQUIRED");
  if (error.code === "CONFLICT" || (existing && error.code === "NOT_FOUND"))
    return new DraftPreparationError("WORDPRESS_MEDIA_IDENTITY_CONFLICT");
  if (
    ["AUTHENTICATION_FAILURE", "CONTRACT_FAILURE", "PAYLOAD_REJECTED"].includes(
      error.code,
    )
  )
    return new DraftPreparationError("WORDPRESS_MEDIA_BLOCKED");
  return new DraftPreparationError("WORDPRESS_MEDIA_RECONCILIATION_REQUIRED");
}
function mapDraftError(
  error: unknown,
  existing: boolean,
): DraftPreparationError {
  if (error instanceof DraftPreparationError) return error;
  if (!(error instanceof WordPressDraftError))
    return new DraftPreparationError("WORDPRESS_DRAFT_RECONCILIATION_REQUIRED");
  if (error.code === "CONFLICT" || (existing && error.code === "NOT_FOUND"))
    return new DraftPreparationError("WORDPRESS_DRAFT_IDENTITY_CONFLICT");
  if (["AUTHENTICATION_FAILURE", "CONTRACT_FAILURE"].includes(error.code))
    return new DraftPreparationError("WORDPRESS_DRAFT_BLOCKED");
  return new DraftPreparationError("WORDPRESS_DRAFT_RECONCILIATION_REQUIRED");
}
