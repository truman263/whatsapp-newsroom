/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { createHash, randomUUID } from "node:crypto";
import {
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Provider,
  ReporterStatus,
  StoryMediaType,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { MediaStagingService } from "../src/modules/media-staging/media-staging.service";
import { STORY_COLLECTION_AUDIT } from "../src/modules/story-collection/story-collection.audit";
import { S3MediaObjectStore } from "../src/modules/media-staging/s3-media-object-store";
import type {
  DownloadedMedia,
  MediaAuthority,
  MediaObjectStore,
  StoredObjectHead,
} from "../src/modules/media-staging/media-staging.types";
import { mediaObjectKey } from "../src/modules/media-staging/media-staging.types";
import type { InboundProcessingClaim } from "../src/modules/reporter-workflow/inbound-processing-contract";

const endpoint = process.env.ROUND8B2_S3_ENDPOINT;
if (!endpoint || !process.env.DATABASE_URL)
  throw new Error("ROUND8B2_S3_ENDPOINT and DATABASE_URL required");
const bytes = Buffer.from("generation-fence-s3-proof");
const media: DownloadedMedia = {
  bytes,
  size: bytes.length,
  mimeType: "image/png",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

class DeterministicProvider {
  async fetch(_authority: MediaAuthority): Promise<DownloadedMedia> {
    return media;
  }
}

class PostPutBarrierStore implements MediaObjectStore {
  private headCalls = 0;
  private readonly reachedPromise: Promise<void>;
  private reachedResolve!: () => void;
  constructor(
    private readonly inner: S3MediaObjectStore,
    private readonly released: Promise<void>,
  ) {
    this.reachedPromise = new Promise((resolve) => {
      this.reachedResolve = resolve;
    });
  }
  waitUntilPostPutHead(): Promise<void> {
    return this.reachedPromise;
  }
  async putIfAbsent(key: string, value: DownloadedMedia) {
    return this.inner.putIfAbsent(key, value);
  }
  async head(key: string): Promise<StoredObjectHead | null> {
    const result = await this.inner.head(key);
    this.headCalls++;
    if (this.headCalls === 2) {
      this.reachedResolve();
      await this.released;
    }
    return result;
  }
  async read(key: string) {
    return this.inner.read(key);
  }
}

describe("Round 8B.2 PostgreSQL + real S3 generation fence", () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaService();
  const clientOptions = {
    endpoint,
    bucket: "proof-media",
    region: "us-east-1",
    forcePathStyle: true,
    accessKeyId: "proof",
    secretAccessKey: "proof-secret",
    maxReadBytes: 1024 * 1024,
  };

  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it("rejects generation N after real S3 PUT and lets N+1 reconcile the same object", async () => {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
        displayName: "round8b2",
        status: ReporterStatus.ACTIVE,
      },
    });
    const story = await prisma.story.create({
      data: {
        reporterId: reporter.id,
        status: StoryStatus.COLLECTING,
        headline: "proof",
        body: "proof",
        version: 1,
      },
    });
    const event = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: `round8b2:${randomUUID()}`,
        reporterId: reporter.id,
        senderPhone: reporter.phoneNumber,
        senderIngestSequence: 0n,
        eventType: InboundEventType.IMAGE,
        processingStatus: InboundProcessingStatus.PROCESSING,
        rawPayload: {},
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(),
      },
    });
    const row = await prisma.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: `round8b2:${randomUUID()}`,
        mediaType: StoryMediaType.IMAGE,
        status: MediaProcessingStatus.RECEIVED,
        mimeType: "image/png",
        position: 0,
      },
    });
    await prisma.auditLog.create({
      data: {
        eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
        actorType: "REPORTER",
        reporterId: reporter.id,
        storyId: story.id,
        inboundEventId: event.id,
        entityType: "StoryMedia",
        entityId: row.id,
        metadata: { providerMediaId: row.providerMediaId },
      },
    });
    const claim: InboundProcessingClaim = {
      eventId: event.id,
      processingAttempt: 1,
      processingContractVersion: 1,
    };
    const realStore = new S3MediaObjectStore(clientOptions);
    const s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "proof", secretAccessKey: "proof-secret" },
    });
    await s3
      .send(new CreateBucketCommand({ Bucket: "proof-media" }))
      .catch((error: unknown) => {
        if (!(
          error &&
          typeof error === "object" &&
          Reflect.get(error, "name") === "BucketAlreadyOwnedByYou"
        ))
          throw error;
      });
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new PostPutBarrierStore(realStore, releaseGate);
    const service = new MediaStagingService(
      prisma,
      new DeterministicProvider(),
      store,
    );
    const staging = service.stage(row.id, claim, {
      providerMediaId: row.providerMediaId,
      mimeType: "image/png",
    });
    await store.waitUntilPostPutHead();
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: { processingAttempts: 2, processingStartedAt: new Date() },
    });
    release();
    await releaseGate;
    await expect(staging).resolves.toMatchObject({ outcome: "RETRY_REQUIRED" });
    expect(
      await prisma.storyMedia.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true, sha256: true },
      }),
    ).toEqual({ status: MediaProcessingStatus.FETCHING, sha256: null });
    expect(await realStore.head(mediaObjectKey(row.id))).toMatchObject({
      size: bytes.length,
      mimeType: "image/png",
      sha256: media.sha256,
    });
    const recovered = await service.reconcile(row.id, {
      eventId: event.id,
      processingAttempt: 2,
      processingContractVersion: 1,
    });
    expect(recovered).toEqual({ outcome: "PROCESSED" });
    expect(
      await prisma.storyMedia.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true, fileSizeBytes: true, sha256: true },
      }),
    ).toMatchObject({
      status: MediaProcessingStatus.FETCHED,
      fileSizeBytes: BigInt(bytes.length),
      sha256: media.sha256,
    });
    await prisma.storyMedia.delete({ where: { id: row.id } });
    await prisma.auditLog.deleteMany({ where: { inboundEventId: event.id } });
    await prisma.inboundEvent.delete({ where: { id: event.id } });
    await prisma.story.delete({ where: { id: story.id } });
    await prisma.reporter.delete({ where: { id: reporter.id } });
    s3.destroy();
  });
});
