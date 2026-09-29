/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import {
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Provider,
  StoryMediaType,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { MediaRecoveryService } from "../src/modules/media-staging/media-recovery.service";
import { InboundEventRecoveryService } from "../src/modules/reporter-workflow/inbound-event-recovery.service";
import { MetaMediaClient } from "../src/modules/media-staging/meta-media.client";
import type { PinnedResponse } from "../src/modules/media-staging/meta-media.client";
import { MediaStagingService } from "../src/modules/media-staging/media-staging.service";
import { S3MediaObjectStore } from "../src/modules/media-staging/s3-media-object-store";
import { mediaObjectKey } from "../src/modules/media-staging/media-staging.types";
import type {
  DownloadedMedia,
  MediaAuthority,
  MediaObjectStore,
} from "../src/modules/media-staging/media-staging.types";
import type { InboundProcessingClaim } from "../src/modules/reporter-workflow/inbound-processing-contract";

const endpoint = process.env.ROUND8B5_S3_ENDPOINT;
if (!endpoint || !process.env.DATABASE_URL)
  throw new Error("ROUND8B5_S3_ENDPOINT and DATABASE_URL required");
jest.setTimeout(180_000);

const prisma = new PrismaService();
const bytes = Buffer.from("round8b5a-real-s3-media-identity");
const value: DownloadedMedia = {
  bytes,
  size: bytes.length,
  mimeType: "image/png",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const options = {
  endpoint,
  bucket: "round8b5a-media",
  region: "us-east-1",
  forcePathStyle: true,
  accessKeyId: "proof",
  secretAccessKey: "proof-secret",
  maxReadBytes: 1024 * 1024,
};
const realStore = new S3MediaObjectStore(options);
const s3 = new S3Client({
  endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "proof", secretAccessKey: "proof-secret" },
});
const calls = { head: 0, get: 0, put: 0 };
const store: MediaObjectStore = {
  async head(key) {
    calls.head++;
    return realStore.head(key);
  },
  async read(key) {
    calls.get++;
    return realStore.read(key);
  },
  async putIfAbsent(key, downloaded) {
    calls.put++;
    return realStore.putIfAbsent(key, downloaded);
  },
};
const provider = {
  async fetch(_authority: MediaAuthority): Promise<DownloadedMedia> {
    throw new Error("RECOVERY_MUST_NOT_REFETCH_PROVIDER");
  },
};

async function seed(status: MediaProcessingStatus) {
  const reporter = await prisma.reporter.create({
    data: { phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`, displayName: "media capacity" },
  });
  const story = await prisma.story.create({ data: { reporterId: reporter.id, version: 1 } });
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: randomUUID(),
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 1n,
      eventType: InboundEventType.IMAGE,
      processingStatus: InboundProcessingStatus.PROCESSING,
      processingAttempts: 1,
      processingContractVersion: 1,
      processingStartedAt: new Date(),
      rawPayload: {},
    },
  });
  const media = await prisma.storyMedia.create({
    data: {
      storyId: story.id,
      providerMediaId: randomUUID(),
      mediaType: StoryMediaType.IMAGE,
      status,
      position: 0,
      mimeType: "image/png",
    },
  });
  await prisma.auditLog.create({
    data: {
      eventType: "story_media_associated",
      actorType: "REPORTER",
      reporterId: reporter.id,
      storyId: story.id,
      inboundEventId: event.id,
      entityType: "StoryMedia",
      entityId: media.id,
    },
  });
  return { reporter, story, event, media };
}

async function makeStaleImage(x: Awaited<ReturnType<typeof seed>>, attempts = 1) {
  const timestamp = "1760000000";
  await prisma.inboundEvent.update({
    where: { id: x.event.id },
    data: {
      processingAttempts: attempts,
      processingStartedAt: new Date(Date.now() - 60_000),
      providerOccurredAt: new Date(Number(timestamp) * 1000),
      rawPayload: {
        message: {
          id: x.event.providerMessageId,
          from: x.reporter.phoneNumber.slice(1),
          timestamp,
          type: "image",
          image: { id: x.media.providerMediaId, mime_type: "image/png" },
        },
      },
    },
  });
}

function staleRecovery(staging: MediaStagingService) {
  return new InboundEventRecoveryService(prisma, {} as never, staging);
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): PinnedResponse {
  return {
    status,
    headers,
    body: (async function* () { yield Buffer.from(JSON.stringify(body)); })(),
  };
}

function binaryResponse(bytes: Buffer, headers: Record<string, string>): PinnedResponse {
  return { status: 200, headers, body: (async function* () { yield bytes; })() };
}

const validPng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(16),
]);

function secureProvider(
  mediaId: string,
  mediaUrl: string,
  download?: PinnedResponse,
  redirect?: string,
  metadataOverride: Record<string, unknown> = {},
  metadataStatus = 200,
  resolvedMediaAddress = "8.8.8.8",
) {
  const requests: Array<{ host: string; bearer: boolean }> = [];
  const transport = {
    request: jest.fn(async (url: URL, _address: string, headers: Record<string, string>) => {
      requests.push({ host: url.hostname, bearer: Boolean(headers.Authorization) });
      if (url.hostname === "graph.facebook.com")
        return response(metadataStatus, { id: mediaId, url: mediaUrl, mime_type: "image/png", file_size: 24, ...metadataOverride });
      if (redirect) return response(302, null, { location: redirect });
      return download ?? response(503, null);
    }),
  };
  const resolver = { resolve: jest.fn(async (host: string) => [
    host === "graph.facebook.com" ? "8.8.8.8" : resolvedMediaAddress,
  ]) };
  const config = new ConfigService({
    whatsapp: { accessToken: "recovery-security-token" },
    mediaStaging: { maxBytes: 1024, requestTimeoutMs: 1000 },
  });
  return { client: new MetaMediaClient(transport, resolver, config), requests };
}

function operationalMetaProvider(mediaId: string, fault: "metadata-refusal" | "metadata-timeout" | "download-refusal" | "download-stream") {
  let unavailable = true;
  const requests: string[] = [];
  const transport = {
    request: jest.fn(async (url: URL) => {
      requests.push(url.hostname);
      if (unavailable && url.hostname === "graph.facebook.com" && fault.startsWith("metadata"))
        throw new Error(fault === "metadata-timeout" ? "request timeout" : "connection refused");
      if (url.hostname === "graph.facebook.com")
        return response(200, {
          id: mediaId,
          url: "https://lookaside.fbsbx.com/media",
          mime_type: "image/png",
          file_size: validPng.length,
        });
      if (unavailable && fault === "download-refusal") throw new Error("connection refused");
      if (unavailable && fault === "download-stream")
        return {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(validPng.length) },
          body: (async function* () { yield validPng.subarray(0, 8); throw new Error("stream interrupted"); })(),
        } satisfies PinnedResponse;
      return binaryResponse(validPng, {
        "content-type": "image/png", "content-length": String(validPng.length),
      });
    }),
  };
  const client = new MetaMediaClient(
    transport, { resolve: async () => ["8.8.8.8"] },
    new ConfigService({
      whatsapp: { accessToken: "operational-proof-token" },
      mediaStaging: { maxBytes: 1024, requestTimeoutMs: 1000 },
    }),
  );
  return { client, requests, restore: () => { unavailable = false; } };
}

async function contend(label: string, mediaId: string, storyId: string) {
  calls.head = 0;
  calls.get = 0;
  calls.put = 0;
  const clients = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const client = new PrismaService();
      await client.$connect();
      return client;
    }),
  );
  let settled: PromiseSettledResult<unknown>[];
  try {
    settled = await Promise.allSettled(
      clients.map((client) =>
        new MediaRecoveryService(
          new MediaStagingService(client, provider, store),
          client,
        ).recoverPending(1),
      ),
    );
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
  const row = await prisma.storyMedia.findUniqueOrThrow({ where: { id: mediaId } });
  const stagedAudits = await prisma.auditLog.count({
    where: { entityType: "StoryMedia", entityId: mediaId, eventType: "story_media_staged" },
  });
  const rejected = settled.filter((entry) => entry.status === "rejected");
  const errorClasses = rejected.map((entry) => {
    const reason = entry.reason as { code?: unknown; name?: unknown };
    return { code: reason?.code ?? null, name: reason?.name ?? null };
  });
  const expectedFenceLosses = errorClasses.filter(
    (entry) => entry.code === "INBOUND_PROCESSING_FENCE_LOST",
  ).length;
  const result = {
    proof: "round8b5a_media_contention",
    label,
    contenders: 20,
    headCalls: calls.head,
    getCalls: calls.get,
    putCalls: calls.put,
    successfulDurableTransitions: stagedAudits,
    lostOrIneligible: settled.filter((entry) => entry.status === "fulfilled").length - stagedAudits + expectedFenceLosses,
    errors: rejected.length - expectedFenceLosses,
    expectedFenceLosses,
    errorClasses,
    status: row.status,
    duplicateDurableEffects: Math.max(0, stagedAudits - 1),
  };
  console.info(JSON.stringify(result));
  expect(await prisma.storyMedia.count({ where: { storyId } })).toBe(1);
  expect(stagedAudits).toBeLessThanOrEqual(1);
  expect(calls.put).toBe(0);
  expect(result.errors).toBe(0);
  return row;
}

describe("Round 8B.5A real S3 media recovery contention", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await s3.send(new CreateBucketCommand({ Bucket: options.bucket }));
  });
  beforeEach(() => prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'));
  afterAll(async () => {
    await prisma.$disconnect();
    s3.destroy();
  });

  it.each([
    ["FETCHING matching object", MediaProcessingStatus.FETCHING],
    ["RECEIVED object before local persistence", MediaProcessingStatus.RECEIVED],
  ])("converges twenty contenders on %s", async (label, status) => {
    const x = await seed(status);
    await realStore.putIfAbsent(mediaObjectKey(x.media.id), value);
    const row = await contend(label, x.media.id, x.story.id);
    expect(row).toMatchObject({
      status: MediaProcessingStatus.FETCHED,
      fileSizeBytes: BigInt(bytes.length),
      sha256: value.sha256,
      mimeType: value.mimeType,
    });
    expect(await realStore.read(mediaObjectKey(x.media.id))).toEqual(bytes);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingStatus)
      .toBe(InboundProcessingStatus.PROCESSED);
  });

  it.each([
    ["oversized Content-Length", validPng, { "content-type": "image/png", "content-length": "1025" }, "MEDIA_TOO_LARGE", false],
    ["invalid Content-Length", validPng, { "content-type": "image/png", "content-length": "not-a-number" }, "MEDIA_SIZE_INVALID", false],
    ["oversized stream", Buffer.alloc(1025), { "content-type": "image/png" }, "MEDIA_TOO_LARGE", false],
    ["truncated stream", validPng.subarray(0, 12), { "content-type": "image/png", "content-length": "24" }, "MEDIA_SIZE_MISMATCH", false],
    ["invalid download MIME", validPng, { "content-type": "text/plain", "content-length": "24" }, "MEDIA_MIME_MISMATCH", false],
    ["bad image magic", Buffer.alloc(24), { "content-type": "image/png", "content-length": "24" }, "MEDIA_CONTENT_INVALID", false],
    ["provider integrity mismatch", validPng, { "content-type": "image/png", "content-length": "24" }, "MEDIA_HASH_MISMATCH", true],
  ])("rejects stale recovered %s through MetaMediaClient", async (_label, content, headers, code, wrongSha) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    if (wrongSha) {
      await prisma.inboundEvent.update({
        where: { id: x.event.id },
        data: { rawPayload: { message: {
          id: x.event.providerMessageId,
          from: x.reporter.phoneNumber.slice(1),
          timestamp: "1760000000",
          type: "image",
          image: {
            id: x.media.providerMediaId,
            mime_type: "image/png",
            sha256: Buffer.alloc(32, 7).toString("base64"),
          },
        } } },
      });
    }
    const secure = secureProvider(
      x.media.providerMediaId,
      "https://lookaside.fbsbx.com/media",
      binaryResponse(content, headers),
    );
    expect(await staleRecovery(new MediaStagingService(prisma, secure.client, realStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FAILED);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).lastErrorCode)
      .toBe(code);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
  });

  it("holds FETCHING with an absent object without a new identity or blind PUT", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    const row = await contend("FETCHING absent object", x.media.id, x.story.id);
    expect(row.status).toBe(MediaProcessingStatus.FETCHING);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
  });

  it("fences N after reclaim and lets twenty N+1 contenders use the exact object", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await realStore.putIfAbsent(mediaObjectKey(x.media.id), value);
    const oldClaim: InboundProcessingClaim = {
      eventId: x.event.id,
      processingAttempt: 1,
      processingContractVersion: 1,
    };
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { processingAttempts: 2, processingStartedAt: new Date() },
    });
    await expect(new MediaStagingService(prisma, provider, store).reconcile(x.media.id, oldClaim))
      .resolves.toMatchObject({ outcome: "RETRY_REQUIRED" });
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    const row = await contend("generation N+1", x.media.id, x.story.id);
    expect(row).toMatchObject({ status: MediaProcessingStatus.FETCHED, sha256: value.sha256 });
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingAttempts)
      .toBe(2);
  });

  it("reconciles a committed S3 PUT whose caller lost the response under twenty contenders", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    const key = mediaObjectKey(x.media.id);
    let acceptedPutAttempts = 0;
    await expect((async () => {
      acceptedPutAttempts++;
      expect(await realStore.putIfAbsent(key, value)).toBe("CREATED");
      throw new Error("injected response loss after accepted S3 PUT");
    })()).rejects.toThrow("injected response loss");
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { processingAttempts: 2, processingStartedAt: new Date() },
    });
    const oldClaim: InboundProcessingClaim = {
      eventId: x.event.id,
      processingAttempt: 1,
      processingContractVersion: 1,
    };
    await expect(new MediaStagingService(prisma, provider, store).reconcile(x.media.id, oldClaim))
      .resolves.toMatchObject({ outcome: "RETRY_REQUIRED" });
    const row = await contend("accepted S3 PUT response lost", x.media.id, x.story.id);
    expect(row).toMatchObject({
      status: MediaProcessingStatus.FETCHED,
      mimeType: value.mimeType,
      fileSizeBytes: BigInt(value.size),
      sha256: value.sha256,
    });
    expect(acceptedPutAttempts).toBe(1);
    expect(calls.head).toBeGreaterThan(0);
    expect(calls.get).toBeGreaterThan(0);
    expect(calls.put).toBe(0);
    expect(await realStore.read(key)).toEqual(bytes);
    console.info(JSON.stringify({
      proof: "round8b5a_s3_accepted_put_lost_response",
      contenders: 20,
      acceptedPutAttempts,
      objectIdentities: 1,
      recoveryHeadCalls: calls.head,
      recoveryGetCalls: calls.get,
      recoveryPutCalls: calls.put,
      durableFetchedTransitions: 1,
      duplicateObjectEffects: 0,
    }));
  });

  it("rejects conflicting object MIME without overwriting it", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    const conflict: DownloadedMedia = { ...value, mimeType: "image/jpeg" };
    await realStore.putIfAbsent(mediaObjectKey(x.media.id), conflict);
    const row = await contend("conflicting object", x.media.id, x.story.id);
    expect(row.status).toBe(MediaProcessingStatus.FETCHING);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toMatchObject({
      mimeType: "image/jpeg", sha256: value.sha256, size: bytes.length,
    });
  });

  it("rejects explicit cross-reporter and contradictory recovery lineage", async () => {
    const owner = await seed(MediaProcessingStatus.FETCHING);
    const other = await seed(MediaProcessingStatus.FETCHING);
    await realStore.putIfAbsent(mediaObjectKey(owner.media.id), value);
    await realStore.putIfAbsent(mediaObjectKey(other.media.id), value);
    await prisma.auditLog.deleteMany({
      where: { entityType: "StoryMedia", entityId: owner.media.id },
    });
    await prisma.auditLog.create({
      data: {
        eventType: "story_media_associated",
        actorType: "REPORTER",
        reporterId: other.reporter.id,
        storyId: owner.story.id,
        inboundEventId: other.event.id,
        entityType: "StoryMedia",
        entityId: owner.media.id,
      },
    });
    await prisma.auditLog.create({
      data: {
        eventType: "story_media_associated",
        actorType: "REPORTER",
        reporterId: owner.reporter.id,
        storyId: other.story.id,
        inboundEventId: owner.event.id,
        entityType: "StoryMedia",
        entityId: other.media.id,
      },
    });
    const recovery = new MediaRecoveryService(
      new MediaStagingService(prisma, provider, store),
      prisma,
    );
    expect(await recovery.recoverPending(10)).toEqual([]);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: owner.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: other.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    expect(await prisma.auditLog.count({ where: { eventType: "story_media_staged" } }))
      .toBe(0);
  });

  it.each([MediaProcessingStatus.FETCHING, MediaProcessingStatus.RECEIVED])(
    "keeps ordinary polling S3-only, then refetches %s after a valid stale reclaim", async (status) => {
    const x = await seed(status);
    await makeStaleImage(x);
    const fetch = jest.fn().mockResolvedValue(value);
    const put = jest.fn((key: string, downloaded: DownloadedMedia) =>
      realStore.putIfAbsent(key, downloaded));
    const recoveryStore: MediaObjectStore = {
      head: (key) => realStore.head(key),
      read: (key) => realStore.read(key),
      putIfAbsent: put,
    };
    const staging = new MediaStagingService(prisma, { fetch }, recoveryStore);
    expect(await new MediaRecoveryService(staging, prisma).recoverPending(1))
      .toEqual([{ outcome: "RETRY_REQUIRED", reason: "MEDIA_OBJECT_UNAVAILABLE" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      providerMediaId: x.media.providerMediaId,
      mimeType: "image/png",
    }));
    expect(put).toHaveBeenCalledTimes(1);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHED);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingStatus)
      .toBe(InboundProcessingStatus.PROCESSED);
    expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
    expect(await realStore.read(mediaObjectKey(x.media.id))).toEqual(bytes);
  });

  it("does not mistake failed S3 HEAD for proven absence", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const fetch = jest.fn();
    const staging = new MediaStagingService(prisma, { fetch }, {
      head: async () => { throw new Error("S3 unavailable"); },
      read: async () => { throw new Error("unexpected GET"); },
      putIfAbsent: async () => { throw new Error("unexpected PUT"); },
    });
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
  });

  it("exhausts the stale generation budget before any Meta refetch", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x, 3);
    const fetch = jest.fn();
    const staging = new MediaStagingService(prisma, { fetch }, realStore);
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toEqual({ outcome: "RECOVERY_ATTEMPTS_EXHAUSTED", operatorHeld: true });
    expect(fetch).not.toHaveBeenCalled();
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingAttempts)
      .toBe(3);
  });

  it.each([null, 999])("holds unsupported processing contract %s without S3 or Meta", async (version) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    await prisma.inboundEvent.update({ where: { id: x.event.id }, data: { processingContractVersion: version } });
    const fetch = jest.fn();
    const head = jest.fn();
    const staging = new MediaStagingService(prisma, { fetch }, {
      head, read: jest.fn(), putIfAbsent: jest.fn(),
    });
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toEqual({ outcome: "UNSUPPORTED_PROCESSING_CONTRACT", operatorHeld: true });
    expect(head).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
  });

  it("keeps a transient real Meta metadata failure in PROCESSING until another bounded reclaim", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const unavailable = secureProvider(x.media.providerMediaId, "https://lookaside.fbsbx.com/media", undefined, undefined, {}, 503);
    const first = new MediaStagingService(prisma, unavailable.client, realStore);
    expect(await staleRecovery(first).recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingStatus)
      .toBe(InboundProcessingStatus.PROCESSING);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
    await prisma.inboundEvent.update({
      where: { id: x.event.id }, data: { processingStartedAt: new Date(Date.now() - 60_000) },
    });
    const fetch = jest.fn().mockResolvedValue(value);
    expect(await staleRecovery(new MediaStagingService(prisma, { fetch }, realStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHED);
  });

  it.each(["metadata-refusal", "metadata-timeout", "download-refusal", "download-stream"] as const)(
    "retains and later drains stale media after %s", async (fault) => {
      const x = await seed(MediaProcessingStatus.FETCHING);
      await makeStaleImage(x);
      const meta = operationalMetaProvider(x.media.providerMediaId, fault);
      const staging = new MediaStagingService(prisma, meta.client, realStore);
      const started = Date.now();
      expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
        .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
      expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
        .toBe(MediaProcessingStatus.FETCHING);
      expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
      const callsDuringOutage = meta.requests.length;
      meta.restore();
      await prisma.inboundEvent.update({
        where: { id: x.event.id }, data: { processingStartedAt: new Date(Date.now() - 60_000) },
      });
      const restorationStarted = Date.now();
      expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
        .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
      expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
        .toBe(MediaProcessingStatus.FETCHED);
      expect(await realStore.read(mediaObjectKey(x.media.id))).toEqual(validPng);
      expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
      console.info(JSON.stringify({
        proof: "round8b5_meta_media_restoration", fault,
        outageMs: restorationStarted - started,
        drainMs: Date.now() - restorationStarted,
        callsDuringOutage, totalCalls: meta.requests.length,
        duplicateMedia: 0,
      }));
    });

  it("fences an old generation after external refetch has begun", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reachedFetch = new Promise<void>((resolve) => { entered = resolve; });
    const fetch = jest.fn()
      .mockImplementationOnce(async () => { entered(); await paused; return value; })
      .mockResolvedValue(value);
    const staging = new MediaStagingService(prisma, { fetch }, realStore);
    const old = staging.recoverStaleAbsentObject(x.media.id, {
      eventId: x.event.id, processingAttempt: 1, processingContractVersion: 1,
    }, { providerMediaId: x.media.providerMediaId, mimeType: "image/png" });
    await reachedFetch;
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    release();
    expect(await old).toMatchObject({ outcome: "RETRY_REQUIRED" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await prisma.auditLog.count({ where: { entityId: x.media.id, eventType: "story_media_staged" } }))
      .toBe(1);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).processingAttempts)
      .toBe(2);
  });

  it.each([
    "event reporter",
    "association reporter",
    "association story",
    "association event",
    "story reporter",
  ])("blocks stale refetch on mismatched %s lineage before S3 or Meta", async (mismatch) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    const other = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "StoryMedia", entityId: x.media.id, eventType: "story_media_associated" },
    });
    if (mismatch === "event reporter")
      await prisma.inboundEvent.update({ where: { id: x.event.id }, data: { reporterId: other.reporter.id } });
    if (mismatch === "association reporter")
      await prisma.auditLog.update({ where: { id: audit.id }, data: { reporterId: other.reporter.id } });
    if (mismatch === "association story")
      await prisma.auditLog.update({ where: { id: audit.id }, data: { storyId: other.story.id } });
    if (mismatch === "association event")
      await prisma.auditLog.create({ data: {
        eventType: "story_media_associated", actorType: "REPORTER",
        reporterId: other.reporter.id, storyId: x.story.id,
        inboundEventId: other.event.id, entityType: "StoryMedia", entityId: x.media.id,
      } });
    if (mismatch === "story reporter")
      await prisma.story.update({ where: { id: x.story.id }, data: { reporterId: other.reporter.id } });
    const fetch = jest.fn();
    const head = jest.fn();
    const staging = new MediaStagingService(prisma, { fetch }, {
      head, read: jest.fn(), putIfAbsent: jest.fn(),
    });
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toEqual({ outcome: "LINEAGE_CONFLICT", operatorHeld: true });
    expect(head).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
  });

  it("converges twenty stale reclaim contenders on one absent-object refetch", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const fetch = jest.fn().mockResolvedValue(value);
    const clients = await Promise.all(Array.from({ length: 20 }, async () => {
      const client = new PrismaService();
      await client.$connect();
      return client;
    }));
    try {
      const results = await Promise.all(clients.map((client) =>
        new InboundEventRecoveryService(client, {} as never,
          new MediaStagingService(client, { fetch }, realStore))
          .recoverStale(x.event.id, new Date(Date.now() - 5_000), 3)));
      expect(results.filter((result) => result.outcome === "RECOVERED")).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: x.media.id, eventType: "story_media_staged" } }))
        .toBe(1);
      expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
        .toBe(MediaProcessingStatus.FETCHED);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it.each([
    ["HTTP", "http://lookaside.fbsbx.com/media", undefined],
    ["IPv4 loopback", "https://127.0.0.1/media", undefined],
    ["IPv6 loopback", "https://[::1]/media", undefined],
    ["RFC1918", "https://192.168.1.1/media", undefined],
    ["link-local", "https://169.254.1.1/media", undefined],
    ["unexpected host", "https://example.com/media", undefined],
    ["redirect loopback", "https://lookaside.fbsbx.com/media", "https://127.0.0.1/private"],
    ["redirect private", "https://lookaside.fbsbx.com/media", "https://10.0.0.1/private"],
    ["redirect external", "https://lookaside.fbsbx.com/media", "https://example.com/private"],
    ["redirect bound", "https://lookaside.fbsbx.com/media", "https://lookaside.fbsbx.com/media"],
  ])("rejects stale-recovery %s destinations through the real Meta client", async (_label, url, redirect) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const secure = secureProvider(x.media.providerMediaId, url, undefined, redirect);
    const staging = new MediaStagingService(prisma, secure.client, realStore);
    expect(await staleRecovery(staging).recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FAILED);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
    expect(secure.requests.every((request) => request.host === "graph.facebook.com" || request.host === "lookaside.fbsbx.com"))
      .toBe(true);
    expect(secure.requests.every((request) => request.bearer))
      .toBe(true);
  });

  it("rejects stale recovered DNS re-resolution to a private address before transport", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const secure = secureProvider(
      x.media.providerMediaId, "https://lookaside.fbsbx.com/media",
      undefined, undefined, {}, 200, "127.0.0.1",
    );
    expect(await staleRecovery(new MediaStagingService(prisma, secure.client, realStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(secure.requests).toEqual([{ host: "graph.facebook.com", bearer: true }]);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FAILED);
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
  });

  it.each([
    ["invalid metadata MIME", "text/plain", "MEDIA_PROVIDER_INVALID"],
    ["metadata MIME mismatch", "image/jpeg", "MEDIA_MIME_MISMATCH"],
  ])("rejects stale recovered %s before downloading", async (_label, mime, code) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const secure = secureProvider(
      x.media.providerMediaId, "https://lookaside.fbsbx.com/media",
      undefined, undefined, { mime_type: mime },
    );
    expect(await staleRecovery(new MediaStagingService(prisma, secure.client, realStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 3))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(secure.requests).toEqual([{ host: "graph.facebook.com", bearer: true }]);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: x.event.id } })).lastErrorCode)
      .toBe(code);
  });

  it.each(["HEAD", "GET"])("holds a recoverable object on %s failure and resumes with the same key", async (operation) => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    const key = mediaObjectKey(x.media.id);
    await realStore.putIfAbsent(key, value);
    let failed = false;
    const faultStore: MediaObjectStore = {
      head: async (objectKey) => {
        if (operation === "HEAD" && !failed) {
          failed = true;
          throw new Error("injected S3 HEAD outage");
        }
        return realStore.head(objectKey);
      },
      read: async (objectKey) => {
        if (operation === "GET" && !failed) {
          failed = true;
          throw new Error("injected S3 GET outage");
        }
        return realStore.read(objectKey);
      },
      putIfAbsent: async () => { throw new Error("blind recovery PUT forbidden"); },
    };
    const first = new MediaRecoveryService(
      new MediaStagingService(prisma, provider, faultStore), prisma,
    );
    expect(await first.recoverPending(1)).toEqual([
      { outcome: "RETRY_REQUIRED", reason: "MEDIA_OBJECT_UNAVAILABLE" },
    ]);
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    // Recreate the service/client boundary: continuation uses only PostgreSQL and S3 state.
    const restarted = new PrismaService();
    await restarted.$connect();
    try {
      const second = new MediaRecoveryService(
        new MediaStagingService(restarted, provider, realStore), restarted,
      );
      expect(await second.recoverPending(1)).toEqual([{ outcome: "PROCESSED" }]);
    } finally {
      await restarted.$disconnect();
    }
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHED);
    expect(await realStore.read(key)).toEqual(bytes);
    expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
  });

  it("holds three stale jobs through S3 outage and drains exact objects after restoration", async () => {
    const jobs = await Promise.all(Array.from({ length: 3 }, () => seed(MediaProcessingStatus.FETCHING)));
    for (const job of jobs) await makeStaleImage(job);
    const fetched: DownloadedMedia = {
      bytes: validPng, size: validPng.length, mimeType: "image/png",
      sha256: createHash("sha256").update(validPng).digest("hex"),
    };
    const fetch = jest.fn().mockResolvedValue(fetched);
    const calls = { head: 0, get: 0, put: 0 };
    let available = false;
    const outageStore: MediaObjectStore = {
      head: async (key) => {
        calls.head++;
        if (!available) throw new Error("S3 outage");
        return realStore.head(key);
      },
      read: async (key) => {
        calls.get++;
        if (!available) throw new Error("S3 outage");
        return realStore.read(key);
      },
      putIfAbsent: async (key, media) => {
        calls.put++;
        if (!available) throw new Error("S3 outage");
        return realStore.putIfAbsent(key, media);
      },
    };
    const staging = new MediaStagingService(prisma, { fetch }, outageStore);
    const outageStarted = Date.now();
    for (const job of jobs)
      expect(await staleRecovery(staging).recoverStale(job.event.id, new Date(Date.now() - 5_000), 4))
        .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).toMatchObject({ head: 3, get: 0, put: 0 });
    expect(await prisma.storyMedia.count({ where: { status: MediaProcessingStatus.FETCHING } })).toBe(3);
    const oldest = await prisma.storyMedia.aggregate({
      where: { status: MediaProcessingStatus.FETCHING }, _min: { updatedAt: true },
    });
    const oldestAgeMs = oldest._min.updatedAt ? Date.now() - oldest._min.updatedAt.getTime() : 0;
    available = true;
    for (const job of jobs)
      await prisma.inboundEvent.update({
        where: { id: job.event.id }, data: { processingStartedAt: new Date(Date.now() - 60_000) },
      });
    const restorationStarted = Date.now();
    for (const job of jobs)
      expect(await staleRecovery(staging).recoverStale(job.event.id, new Date(Date.now() - 5_000), 4))
        .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(await prisma.storyMedia.count({ where: { status: MediaProcessingStatus.FETCHED } })).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls.put).toBe(3);
    for (const job of jobs)
      expect(await realStore.read(mediaObjectKey(job.media.id))).toEqual(validPng);
    console.info(JSON.stringify({
      proof: "round8b5_s3_outage_drain", outageMs: restorationStarted - outageStarted,
      maxBacklog: 3, oldestAgeMs, drainMs: Date.now() - restorationStarted,
      ...calls, duplicateObjectIdentities: 0,
    }));
  });

  it("retains the same stale lineage after a definite S3 PUT failure", async () => {
    const x = await seed(MediaProcessingStatus.FETCHING);
    await makeStaleImage(x);
    const downloaded: DownloadedMedia = {
      bytes: validPng, size: validPng.length, mimeType: "image/png",
      sha256: createHash("sha256").update(validPng).digest("hex"),
    };
    const fetch = jest.fn().mockResolvedValue(downloaded);
    const faultStore: MediaObjectStore = {
      head: (key) => realStore.head(key),
      read: (key) => realStore.read(key),
      putIfAbsent: async () => { throw new Error("definite pre-acceptance PUT failure"); },
    };
    expect(await staleRecovery(new MediaStagingService(prisma, { fetch }, faultStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect(await realStore.head(mediaObjectKey(x.media.id))).toBeNull();
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHING);
    await prisma.inboundEvent.update({
      where: { id: x.event.id }, data: { processingStartedAt: new Date(Date.now() - 60_000) },
    });
    expect(await staleRecovery(new MediaStagingService(prisma, { fetch }, realStore))
      .recoverStale(x.event.id, new Date(Date.now() - 5_000), 4))
      .toMatchObject({ outcome: "RECOVERED", route: "STORY_MEDIA" });
    expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: x.media.id } })).status)
      .toBe(MediaProcessingStatus.FETCHED);
    expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
  });
});
