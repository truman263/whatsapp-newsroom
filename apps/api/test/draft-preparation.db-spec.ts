import { createHash, randomUUID } from "node:crypto";
import {
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Provider,
  PublishAttemptStatus,
  PublishOperation,
  ReporterStatus,
  StoryMediaType,
  StoryStatus,
} from "@prisma/client";
import type { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../src/config/configuration";
import { PrismaService } from "../src/database/prisma.service";
import { DraftPreparationService } from "../src/modules/draft-preparation/draft-preparation.service";
import type { FinalizeDraftResult } from "../src/modules/draft-preparation/draft-preparation.types";
import {
  mediaObjectKey,
  type DownloadedMedia,
  type MediaObjectStore,
  type StoredObjectHead,
} from "../src/modules/media-staging/media-staging.types";
import { UnconfiguredMediaObjectStore } from "../src/modules/media-staging/unconfigured-media-object-store";
import {
  draftStateFingerprint,
  type CanonicalDraftState,
  type WordPressDraftState,
} from "../src/modules/wordpress-draft/wordpress-draft-state";
import type { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import { WordPressDraftError } from "../src/modules/wordpress-draft/wordpress-draft.errors";
import type { WordPressMediaClient } from "../src/modules/wordpress-media/wordpress-media.client";
import { WordPressMediaError } from "../src/modules/wordpress-media/wordpress-media.errors";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required; this suite never reads .env");
jest.setTimeout(120_000);
const prisma = new PrismaService();
const objects = new Map<string, DownloadedMedia>();
let nextPostId = Date.now() * 100;
let nextAttachmentId = Date.now() * 100 + 1_000_000;
let nextCategoryId = BigInt(Date.now()) * 1_000n;
let nextIngestSequence = BigInt(Date.now()) * 10_000n;

class Store implements MediaObjectStore {
  calls: string[] = [];
  putIfAbsent(
    key: string,
    media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS"> {
    objects.set(key, media);
    return Promise.resolve("CREATED");
  }
  head(key: string): Promise<StoredObjectHead | null> {
    this.calls.push(`head:${key}`);
    const value = objects.get(key);
    return Promise.resolve(
      value
        ? { size: value.size, sha256: value.sha256, mimeType: value.mimeType }
        : null,
    );
  }
  read(key: string): Promise<Buffer> {
    this.calls.push(`read:${key}`);
    const value = objects.get(key);
    return value
      ? Promise.resolve(value.bytes)
      : Promise.reject(new Error("missing"));
  }
}

class DraftAuthority {
  calls: string[] = [];
  posts = new Map<string, { postId: number; state?: CanonicalDraftState }>();
  createError?: WordPressDraftError;
  syncError?: WordPressDraftError;
  getDraftByKey(key: string): Promise<{
    wordpressDraftKey: string;
    wordpressPostId: number;
    status: "draft";
  }> {
    this.calls.push(`get:${key}`);
    const value = this.posts.get(key);
    if (!value)
      return Promise.reject(
        new WordPressDraftError("NOT_FOUND", "not found", 404),
      );
    return Promise.resolve({
      wordpressDraftKey: key,
      wordpressPostId: value.postId,
      status: "draft",
    });
  }
  createDraft(input: { wordpressDraftKey: string }): Promise<{
    wordpressDraftKey: string;
    wordpressPostId: number;
    status: "draft";
    outcome: "CREATED";
  }> {
    this.calls.push(`create:${input.wordpressDraftKey}`);
    if (this.createError) return Promise.reject(this.createError);
    const postId = nextPostId++;
    this.posts.set(input.wordpressDraftKey, { postId });
    return Promise.resolve({
      wordpressDraftKey: input.wordpressDraftKey,
      wordpressPostId: postId,
      status: "draft",
      outcome: "CREATED",
    });
  }
  getDraftState(key: string): Promise<WordPressDraftState> {
    this.calls.push(`state:${key}`);
    const post = this.posts.get(key);
    if (!post)
      return Promise.reject(
        new WordPressDraftError("NOT_FOUND", "not found", 404),
      );
    const state = post.state ?? {
      title: "remote",
      content: "remote",
      excerpt: "",
      categories: [1],
      editorial_byline: "remote",
      featured_media_key: null,
    };
    return Promise.resolve({
      draft_key: key,
      post_id: post.postId,
      status: "draft",
      ...state,
      author_id: 3,
      applied_version: draftStateFingerprint(state),
    });
  }
  syncDraft(input: {
    wordpressDraftKey: string;
    headline: string;
    body: string;
    excerpt?: string;
    wordpressCategoryIds: number[];
    editorialByline: string;
    featuredMediaKey: string | null;
  }): Promise<{
    draft_key: string;
    post_id: number;
    status: "draft";
    replayed: false;
    featured_media_key: string | null;
    applied_version: string;
    outcome: "APPLIED";
  }> {
    this.calls.push(`sync:${input.wordpressDraftKey}`);
    if (this.syncError) return Promise.reject(this.syncError);
    const post = this.posts.get(input.wordpressDraftKey)!;
    const state: CanonicalDraftState = {
      title: input.headline,
      content: input.body,
      excerpt: input.excerpt ?? "",
      categories: input.wordpressCategoryIds,
      editorial_byline: input.editorialByline,
      featured_media_key: input.featuredMediaKey,
    };
    post.state = state;
    return Promise.resolve({
      draft_key: input.wordpressDraftKey,
      post_id: post.postId,
      status: "draft",
      replayed: false,
      featured_media_key: state.featured_media_key,
      applied_version: draftStateFingerprint(state),
      outcome: "APPLIED",
    });
  }
}

class MediaAuthority {
  calls: string[] = [];
  attachments = new Map<string, number>();
  uploadError?: WordPressMediaError;
  getMediaByKey(
    key: string,
  ): Promise<{ mediaKey: string; attachmentId: number; status: "attachment" }> {
    this.calls.push(`get:${key}`);
    const id = this.attachments.get(key);
    return id
      ? Promise.resolve({
          mediaKey: key,
          attachmentId: id,
          status: "attachment",
        })
      : Promise.reject(new WordPressMediaError("NOT_FOUND", "not found", 404));
  }
  uploadMedia(input: { mediaKey: string }): Promise<{
    mediaKey: string;
    attachmentId: number;
    status: "attachment";
    outcome: "CREATED";
  }> {
    this.calls.push(`upload:${input.mediaKey}`);
    if (this.uploadError) return Promise.reject(this.uploadError);
    const attachmentId = nextAttachmentId++;
    this.attachments.set(input.mediaKey, attachmentId);
    return Promise.resolve({
      mediaKey: input.mediaKey,
      attachmentId,
      status: "attachment",
      outcome: "CREATED",
    });
  }
}

type Seed = {
  reporterId: string;
  eventId: string;
  conversationId: string;
  storyId: string;
  categoryId: string;
  storyVersion: number;
};
async function seed(
  mediaCount = 0,
  categoryStatus: EditorialCategoryStatus = EditorialCategoryStatus.ACTIVE,
): Promise<Seed> {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 9)}`,
      displayName: "Proof",
      editorialByline: "Reporter Example",
      status: ReporterStatus.ACTIVE,
    },
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.COLLECTING,
      headline: "Headline",
      body: "Body",
      byline: "Reporter Example",
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      currentStoryId: story.id,
      state: ConversationState.COLLECTING_MEDIA,
      version: 7,
    },
  });
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: randomUUID(),
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: nextIngestSequence++,
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSING,
      rawPayload: {},
      processingStartedAt: new Date(),
    },
  });
  const category = await prisma.editorialCategory.create({
    data: {
      wordpressCategoryId: nextCategoryId++,
      name: "Proof",
      slug: `proof-${randomUUID()}`,
      status: categoryStatus,
    },
  });
  await prisma.storyCategory.create({
    data: { storyId: story.id, categoryId: category.id },
  });
  for (let position = 0; position < mediaCount; position++) {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(8, position),
    ]);
    const media = await prisma.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: randomUUID(),
        mediaType: StoryMediaType.IMAGE,
        status: MediaProcessingStatus.FETCHED,
        mimeType: "image/png",
        fileSizeBytes: BigInt(bytes.length),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        position,
      },
    });
    objects.set(mediaObjectKey(media.id), {
      bytes,
      mimeType: "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    reporterId: reporter.id,
    eventId: event.id,
    conversationId: conversation.id,
    storyId: story.id,
    categoryId: category.id,
    storyVersion: story.version,
  };
}

function service(
  store = new Store(),
  draft = new DraftAuthority(),
  media = new MediaAuthority(),
): {
  service: DraftPreparationService;
  store: Store;
  draft: DraftAuthority;
  media: MediaAuthority;
} {
  const config = { get: () => 86400 } as unknown as ConfigService<
    ApplicationConfiguration,
    true
  >;
  return {
    service: new DraftPreparationService(
      prisma,
      config,
      store,
      draft as unknown as WordPressDraftClient,
      media as unknown as WordPressMediaClient,
    ),
    store,
    draft,
    media,
  };
}

function finalize(
  target: DraftPreparationService,
  value: Seed,
): Promise<FinalizeDraftResult> {
  return prisma.$transaction(
    (tx) =>
      target.finalizeInTransaction(tx, {
        inboundEventId: value.eventId,
        reporterId: value.reporterId,
        conversationId: value.conversationId,
        storyId: value.storyId,
        expectedStoryVersion: value.storyVersion,
      }),
    { maxWait: 30_000, timeout: 30_000 },
  );
}

describe("DraftPreparation durable saga", () => {
  afterAll(async () => prisma.$disconnect());

  it("serializes 20 Phase-A contenders into exactly one epoch and performs no external I/O", async () => {
    const value = await seed();
    const runtime = service();
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => finalize(runtime.service, value)),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    for (const rejected of settled.filter(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    ))
      expect(rejected.reason).toMatchObject({
        code: "STORY_FINALISATION_CONFLICT",
      });
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
    });
    expect(story).toMatchObject({
      status: StoryStatus.READY,
      version: value.storyVersion + 1,
    });
    expect(
      await prisma.draftPreparation.count({
        where: { storyId: value.storyId },
      }),
    ).toBe(1);
    expect(runtime.store.calls).toEqual([]);
    expect(runtime.draft.calls).toEqual([]);
    expect(runtime.media.calls).toEqual([]);
  });

  it("rejects inactive category without a version bump or preparation", async () => {
    const value = await seed(0, EditorialCategoryStatus.INACTIVE);
    const runtime = service();
    await expect(finalize(runtime.service, value)).rejects.toMatchObject({
      code: "CATEGORY_SELECTION_NO_LONGER_ACTIVE",
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: value.storyId } }),
    ).toMatchObject({
      status: StoryStatus.COLLECTING,
      version: value.storyVersion,
    });
    expect(
      await prisma.draftPreparation.count({
        where: { storyId: value.storyId },
      }),
    ).toBe(0);
  });

  it.each([
    ["headline", { headline: " " }],
    ["body", { body: " " }],
    ["byline", { byline: " " }],
  ])("rejects incomplete %s without mutation", async (_field, data) => {
    const value = await seed();
    await prisma.story.update({ where: { id: value.storyId }, data });
    const runtime = service();
    await expect(finalize(runtime.service, value)).rejects.toMatchObject({
      code: "COMPLETENESS_NOT_SATISFIED",
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: value.storyId } }),
    ).toMatchObject({
      status: StoryStatus.COLLECTING,
      version: value.storyVersion,
    });
  });

  it.each(["STALE_VERSION", "UNCERTAIN_OUTCOME"] as const)(
    "keeps sync %s safely reconciliation-required",
    async (code) => {
      const value = await seed();
      const runtime = service();
      runtime.draft.syncError = new WordPressDraftError(code, "safe");
      const preparation = await finalize(runtime.service, value);
      await expect(
        runtime.service.prepare(preparation.preparationId),
      ).resolves.toMatchObject({
        outcome: "RECONCILIATION_REQUIRED",
        errorCode: "WORDPRESS_DRAFT_RECONCILIATION_REQUIRED",
      });
      const attempts = await prisma.publishAttempt.findMany({
        where: {
          storyId: value.storyId,
          operation: PublishOperation.SYNC_DRAFT,
        },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: PublishAttemptStatus.RECONCILIATION_REQUIRED,
        errorMessage: null,
      });
    },
  );

  it("blocks media preparation when the durable store is unconfigured", async () => {
    const value = await seed(1);
    const runtime = service();
    const preparation = await finalize(runtime.service, value);
    const config = { get: () => 86400 } as unknown as ConfigService<
      ApplicationConfiguration,
      true
    >;
    const target = new DraftPreparationService(
      prisma,
      config,
      new UnconfiguredMediaObjectStore(),
      runtime.draft as unknown as WordPressDraftClient,
      runtime.media as unknown as WordPressMediaClient,
    );
    await expect(target.prepare(preparation.preparationId)).resolves.toEqual({
      preparationId: preparation.preparationId,
      outcome: "BLOCKED",
      errorCode: "MEDIA_OBJECT_STORE_UNCONFIGURED",
    });
    expect(runtime.media.calls).toEqual([]);
  });

  it("classifies missing durable bytes as BLOCKED and byte mismatch as FAILED", async () => {
    const missing = await seed(1);
    const missingRuntime = service();
    const missingPreparation = await finalize(missingRuntime.service, missing);
    const missingMedia = await prisma.storyMedia.findFirstOrThrow({
      where: { storyId: missing.storyId },
    });
    objects.delete(mediaObjectKey(missingMedia.id));
    await expect(
      missingRuntime.service.prepare(missingPreparation.preparationId),
    ).resolves.toMatchObject({
      outcome: "BLOCKED",
      errorCode: "MEDIA_BYTES_UNAVAILABLE",
    });
    const corrupt = await seed(1);
    const corruptRuntime = service();
    const corruptPreparation = await finalize(corruptRuntime.service, corrupt);
    const corruptMedia = await prisma.storyMedia.findFirstOrThrow({
      where: { storyId: corrupt.storyId },
    });
    const stored = objects.get(mediaObjectKey(corruptMedia.id))!;
    objects.set(mediaObjectKey(corruptMedia.id), {
      ...stored,
      bytes: Buffer.alloc(stored.size),
    });
    await expect(
      corruptRuntime.service.prepare(corruptPreparation.preparationId),
    ).resolves.toMatchObject({
      outcome: "FAILED",
      errorCode: "MEDIA_BYTES_INTEGRITY_FAILURE",
    });
  });

  it("blocks safely when reporter or category authority changes after Phase A", async () => {
    const reporterCase = await seed();
    const reporterRuntime = service();
    const reporterPreparation = await finalize(
      reporterRuntime.service,
      reporterCase,
    );
    await prisma.reporter.update({
      where: { id: reporterCase.reporterId },
      data: { status: ReporterStatus.INACTIVE },
    });
    await expect(
      reporterRuntime.service.prepare(reporterPreparation.preparationId),
    ).resolves.toMatchObject({
      outcome: "BLOCKED",
      errorCode: "REPORTER_NOT_ACTIVE",
    });
    const categoryCase = await seed();
    const categoryRuntime = service();
    const categoryPreparation = await finalize(
      categoryRuntime.service,
      categoryCase,
    );
    await prisma.editorialCategory.update({
      where: { id: categoryCase.categoryId },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    await expect(
      categoryRuntime.service.prepare(categoryPreparation.preparationId),
    ).resolves.toMatchObject({
      outcome: "BLOCKED",
      errorCode: "CATEGORY_SELECTION_NO_LONGER_ACTIVE",
    });
  });

  it("serializes the category-deactivation race to the two frozen outcomes", async () => {
    const afterCase = await seed();
    const afterRuntime = service();
    await expect(
      finalize(afterRuntime.service, afterCase),
    ).resolves.toMatchObject({ storyVersion: afterCase.storyVersion + 1 });
    await prisma.editorialCategory.update({
      where: { id: afterCase.categoryId },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    expect(
      await prisma.draftPreparation.count({
        where: { storyId: afterCase.storyId },
      }),
    ).toBe(1);

    const beforeCase = await seed();
    const beforeRuntime = service();
    let release!: () => void;
    let locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const deactivation = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "EditorialCategory" WHERE "id"=${beforeCase.categoryId}::uuid FOR UPDATE`;
      await tx.editorialCategory.update({
        where: { id: beforeCase.categoryId },
        data: { status: EditorialCategoryStatus.INACTIVE },
      });
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const finalisation = finalize(beforeRuntime.service, beforeCase);
    release();
    await deactivation;
    await expect(finalisation).rejects.toMatchObject({
      code: "CATEGORY_SELECTION_NO_LONGER_ACTIVE",
    });
    expect(
      await prisma.story.findUniqueOrThrow({
        where: { id: beforeCase.storyId },
      }),
    ).toMatchObject({
      status: StoryStatus.COLLECTING,
      version: beforeCase.storyVersion,
    });
    expect(
      await prisma.draftPreparation.count({
        where: { storyId: beforeCase.storyId },
      }),
    ).toBe(0);
  });

  it.each([0, 1, 3])(
    "prepares %s media in order, selects position zero, and preserves event/conversation authority",
    async (count) => {
      const value = await seed(count);
      const runtime = service();
      const preparation = await finalize(runtime.service, value);
      await expect(
        runtime.service.prepare(preparation.preparationId),
      ).resolves.toEqual({
        preparationId: preparation.preparationId,
        outcome: "PREPARED",
      });
      const story = await prisma.story.findUniqueOrThrow({
        where: { id: value.storyId },
        include: {
          media: { orderBy: { position: "asc" } },
          activeInConversation: true,
          draftPreparations: true,
          publishAttempts: true,
        },
      });
      const event = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: value.eventId },
      });
      expect(story.status).toBe(StoryStatus.DRAFT_CREATED);
      expect(story.version).toBe(value.storyVersion + 1);
      expect(story.activeInConversation).toMatchObject({
        state: ConversationState.COLLECTING_MEDIA,
        version: 7,
        currentStoryId: story.id,
      });
      expect(event).toMatchObject({
        processingStatus: InboundProcessingStatus.PROCESSING,
        processedAt: null,
      });
      expect(story.draftPreparations[0]).toMatchObject({
        status: DraftPreparationStatus.ACTIVE,
        readyAt: null,
        lastErrorCode: null,
      });
      expect(
        story.publishAttempts.map((item) => [
          item.operation,
          item.status,
          item.errorMessage,
        ]),
      ).toEqual([
        [PublishOperation.CREATE_DRAFT, PublishAttemptStatus.SUCCEEDED, null],
        [PublishOperation.SYNC_DRAFT, PublishAttemptStatus.SUCCEEDED, null],
      ]);
      expect(
        runtime.media.calls.filter((item) => item.startsWith("upload:")),
      ).toHaveLength(count);
      expect(runtime.store.calls).toHaveLength(count * 2);
      const remote = runtime.draft.posts.get(story.wordpressDraftKey)!;
      expect(remote.state?.featured_media_key).toBe(story.media[0]?.id ?? null);
      expect(
        story.media.every(
          (item) =>
            item.status === MediaProcessingStatus.UPLOADED &&
            item.wordpressMediaId !== null,
        ),
      ).toBe(true);
      const authority = await runtime.service.verifyPreparedAuthority(
        preparation.preparationId,
      );
      expect(authority.wordpressAppliedVersion).toBe(
        story.draftPreparations[0]!.wordpressAppliedVersion,
      );
    },
  );

  it("recovers media, draft, and sync response-loss windows GET-first without duplicate mutations", async () => {
    const value = await seed(1);
    const runtime = service();
    const preparation = await finalize(runtime.service, value);
    const row = await prisma.storyMedia.findFirstOrThrow({
      where: { storyId: value.storyId },
    });
    runtime.media.attachments.set(row.id, nextAttachmentId++);
    await prisma.storyMedia.update({
      where: { id: row.id },
      data: { status: MediaProcessingStatus.UPLOADING },
    });
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
    });
    runtime.draft.posts.set(story.wordpressDraftKey, { postId: nextPostId++ });
    await expect(
      runtime.service.recoverPreparation(preparation.preparationId),
    ).resolves.toMatchObject({ outcome: "PREPARED" });
    expect(runtime.media.calls).toContain(`get:${row.id}`);
    expect(runtime.media.calls.some((item) => item.startsWith("upload:"))).toBe(
      false,
    );
    expect(runtime.draft.calls[0]).toBe(`get:${story.wordpressDraftKey}`);
    expect(runtime.draft.calls.some((item) => item.startsWith("create:"))).toBe(
      false,
    );
    const before = runtime.draft.calls.filter((item) =>
      item.startsWith("sync:"),
    ).length;
    await runtime.service.recoverPreparation(preparation.preparationId);
    expect(
      runtime.draft.calls.filter((item) => item.startsWith("sync:")).length,
    ).toBe(before);
  });

  it.each([
    [
      "media authentication",
      "media",
      new WordPressMediaError("AUTHENTICATION_FAILURE", "safe"),
      "BLOCKED",
      "WORDPRESS_MEDIA_BLOCKED",
    ],
    [
      "media uncertainty",
      "media",
      new WordPressMediaError("UNCERTAIN_OUTCOME", "safe"),
      "RECONCILIATION_REQUIRED",
      "WORDPRESS_MEDIA_RECONCILIATION_REQUIRED",
    ],
    [
      "media conflict",
      "media",
      new WordPressMediaError("CONFLICT", "safe"),
      "FAILED",
      "WORDPRESS_MEDIA_IDENTITY_CONFLICT",
    ],
    [
      "draft authentication",
      "draft",
      new WordPressDraftError("AUTHENTICATION_FAILURE", "safe"),
      "BLOCKED",
      "WORDPRESS_DRAFT_BLOCKED",
    ],
    [
      "draft uncertainty",
      "draft",
      new WordPressDraftError("UNCERTAIN_OUTCOME", "safe"),
      "RECONCILIATION_REQUIRED",
      "WORDPRESS_DRAFT_RECONCILIATION_REQUIRED",
    ],
    [
      "draft conflict",
      "draft",
      new WordPressDraftError("CONFLICT", "safe"),
      "FAILED",
      "WORDPRESS_DRAFT_IDENTITY_CONFLICT",
    ],
  ])(
    "maps %s to safe durable state",
    async (_name, authority, error, outcome, errorCode) => {
      const value = await seed(authority === "media" ? 1 : 0);
      const runtime = service();
      if (authority === "media")
        runtime.media.uploadError = error as WordPressMediaError;
      else runtime.draft.createError = error as WordPressDraftError;
      const preparation = await finalize(runtime.service, value);
      await expect(
        runtime.service.prepare(preparation.preparationId),
      ).resolves.toMatchObject({ outcome, errorCode });
      const stored = await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: preparation.preparationId },
      });
      expect(stored.lastErrorCode).toBe(errorCode);
      const attempts = await prisma.publishAttempt.findMany({
        where: { storyId: value.storyId },
      });
      expect(attempts.every((attempt) => attempt.errorMessage === null)).toBe(
        true,
      );
    },
  );

  it("rolls back crash point one and allows an exact retry", async () => {
    const value = await seed();
    const runtime = service();
    await expect(
      prisma.$transaction(async (tx) => {
        await runtime.service.finalizeInTransaction(tx, {
          inboundEventId: value.eventId,
          reporterId: value.reporterId,
          conversationId: value.conversationId,
          storyId: value.storyId,
          expectedStoryVersion: value.storyVersion,
        });
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: value.storyId } }),
    ).toMatchObject({
      status: StoryStatus.COLLECTING,
      version: value.storyVersion,
    });
    await expect(finalize(runtime.service, value)).resolves.toMatchObject({
      storyVersion: value.storyVersion + 1,
    });
  });
});
