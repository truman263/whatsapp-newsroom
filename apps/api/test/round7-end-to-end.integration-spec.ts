/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import {
  ConversationState,
  DraftPreparationStatus,
  InboundProcessingStatus,
  MediaProcessingStatus,
  OutboundMessageStatus,
  OutboundMessageType,
  Provider,
  PublishAttemptStatus,
  PublishOperation,
  ReporterStatus,
  StoryStatus,
  type DraftPreparation,
  type StoryMedia,
} from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/database/prisma.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import type { InboundProcessingClaim } from "../src/modules/reporter-workflow/inbound-processing-contract";
import { PreviewTokenService } from "../src/modules/newsroom-preview/newsroom-preview-token.service";
import { DraftPreparationService } from "../src/modules/draft-preparation/draft-preparation.service";
import { DraftRecoveryService } from "../src/modules/draft-preparation/draft-recovery.service";
import { PublishAttemptDriverService } from "../src/modules/publishing/publish-attempt-driver.service";
import { Round7PublishSagaService } from "../src/modules/publishing/round7-publish-saga.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import {
  MEDIA_OBJECT_STORE,
  mediaObjectKey,
  type MediaObjectStore,
} from "../src/modules/media-staging/media-staging.types";
import { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import { WordPressMediaClient } from "../src/modules/wordpress-media/wordpress-media.client";
import { WordPressPublicationClient } from "../src/modules/wordpress-publication/wordpress-publication.client";
import { SecureWordPressTransport } from "../src/modules/wordpress-transport/wordpress-secure-transport";

const port = process.env.ROUND7_TEST_WORDPRESS_PORT;
const categoryId = Number(process.env.ROUND7_TEST_CATEGORY_ID);
if (!process.env.DATABASE_URL || !port || !Number.isSafeInteger(categoryId))
  throw new Error(
    "Run this suite with pnpm test:round7-integration; isolated runtime configuration is required.",
  );

jest.setTimeout(120_000);
const marker = `r7-combined-${randomUUID()}`;
let app: INestApplication;
let prisma: PrismaService;
let processor: InboundEventProcessingService;
let drafts: WordPressDraftClient;
let publications: WordPressPublicationClient;
const calls: string[] = [];
const mediaResponses: Array<{ method: string; status: number; body: string }> = [];
let failPublicationPost = false;
let loseAcceptedPublicationPost = false;
let publicationGetUnavailable = false;
let failDraftCreatePost = false;
let failDraftSyncPut = false;
let failMediaPost = false;
let holdSuccessfulMediaGet = false;
let mediaGetReached: (() => void) | undefined;
let releaseMediaGet: Promise<void> | undefined;
let injectedFault: {
  method: "GET" | "POST" | "PUT";
  routePrefix: string;
  kind: "refuse" | "timeout" | "http503" | "malformed" | "latency";
  remaining: number;
} | undefined;
let wordpressOffline = false;

function makePng(): Buffer {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    let c = 0xffffffff;
    for (const byte of Buffer.concat([t, data]))
      c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(68))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Fixture = Awaited<ReturnType<typeof handoff>>;

function wpRead(sql: string): string {
  const project = process.env.ROUND7_TEST_COMPOSE_PROJECT;
  const envFile = process.env.ROUND7_TEST_COMPOSE_ENV_FILE;
  if (!project || !envFile)
    throw new Error("Disposable WordPress CLI configuration is required");
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      envFile,
      "--file",
      "wordpress/runtime/draft-sync-implementation/compose.yaml",
      "exec",
      "-T",
      "cli",
      "wp",
      "db",
      "query",
      sql,
      "--skip-column-names",
      "--silent",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error("Disposable WordPress read failed");
  return result.stdout.trim();
}

async function handoff(name: string) {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
      displayName: `${marker}:${name}`,
      status: ReporterStatus.ACTIVE,
    },
  });
  const category = await prisma.editorialCategory.upsert({
    where: { wordpressCategoryId: BigInt(categoryId) },
    create: {
      wordpressCategoryId: BigInt(categoryId),
      name: "Round 7 proof",
      slug: "round7-proof",
    },
    update: {},
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.AWAITING_APPROVAL,
      headline: `Headline ${name}`,
      body: `Body ${name}`,
      byline: "Proof Reporter",
      version: 3,
    },
  });
  await prisma.storyCategory.create({
    data: { storyId: story.id, categoryId: category.id },
  });
  const created = await drafts.createDraft({
    wordpressDraftKey: story.wordpressDraftKey,
    headline: story.headline!,
    body: story.body!,
    wordpressCategoryIds: [categoryId],
  });
  const synced = await drafts.syncDraft({
    wordpressDraftKey: story.wordpressDraftKey,
    headline: story.headline!,
    body: story.body!,
    wordpressCategoryIds: [categoryId],
    editorialByline: story.byline!,
    featuredMediaKey: null,
  });
  const state = await drafts.getDraftState(story.wordpressDraftKey);
  expect(state).toMatchObject({
    status: "draft",
    post_id: created.wordpressPostId,
    applied_version: synced.applied_version,
  });
  await prisma.story.update({
    where: { id: story.id },
    data: { wordpressPostId: BigInt(state.post_id) },
  });
  const conversation = await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      state: ConversationState.AWAITING_APPROVAL,
      currentStoryId: story.id,
    },
  });
  const prepEvent = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: `${marker}:done:${name}`,
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 0n,
      eventType: "TEXT",
      processingStatus: InboundProcessingStatus.PROCESSED,
      rawPayload: { message: {} },
    },
  });
  await prisma.inboundSenderSequence.create({
    data: { senderPhone: reporter.phoneNumber, nextValue: 1n },
  });
  const preparation = await prisma.draftPreparation.create({
    data: {
      storyId: story.id,
      inboundEventId: prepEvent.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      wordpressPostId: BigInt(state.post_id),
      wordpressAppliedVersion: state.applied_version,
      approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
      previewExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const prompt = await prisma.outboundMessage.create({
    data: {
      reporterId: reporter.id,
      storyId: story.id,
      type: OutboundMessageType.INTERACTIVE,
      status: OutboundMessageStatus.SENT,
      correlationKey: preparation.approvalPromptCorrelationKey,
      payload: {
        kind: "APPROVAL_PROMPT_V1",
        draftPreparationId: preparation.id,
        storyId: story.id,
        storyVersion: story.version,
        wordpressAppliedVersion: state.applied_version,
      },
    },
  });
  await prisma.draftPreparation.update({
    where: { id: preparation.id },
    data: { approvalPromptOutboundMessageId: prompt.id },
  });
  return { reporter, story, conversation, preparation, prompt, state };
}

async function pendingPreparation(name: string) {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
      displayName: `${marker}:${name}`,
      status: ReporterStatus.ACTIVE,
    },
  });
  const category = await prisma.editorialCategory.upsert({
    where: { wordpressCategoryId: BigInt(categoryId) },
    create: { wordpressCategoryId: BigInt(categoryId), name: "Round 7 proof", slug: "round7-proof" },
    update: {},
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.DRAFT_CREATING,
      headline: `Headline ${name}`,
      body: `Body ${name}`,
      byline: "Proof Reporter",
      version: 3,
    },
  });
  await prisma.storyCategory.create({ data: { storyId: story.id, categoryId: category.id } });
  await prisma.conversation.create({
    data: { reporterId: reporter.id, state: ConversationState.COLLECTING_MEDIA, currentStoryId: story.id },
  });
  const inboundEvent = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: `${marker}:pending:${name}`,
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 1n,
      eventType: "TEXT",
      processingStatus: InboundProcessingStatus.PROCESSING,
      processingAttempts: 1,
      processingContractVersion: 1,
      processingStartedAt: new Date(),
      rawPayload: { message: {} },
    },
  });
  const preparation = await prisma.draftPreparation.create({
    data: {
      storyId: story.id,
      inboundEventId: inboundEvent.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.ACTIVE,
      approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
      previewExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { reporter, story, inboundEvent, preparation };
}

async function contendDraftRecovery(preparationId: string): Promise<PromiseSettledResult<unknown>[]> {
  await prisma.draftPreparation.update({
    where: { id: preparationId },
    data: { updatedAt: new Date("2000-01-01T00:00:00.000Z") },
  });
  const selected = await prisma.draftPreparation.findMany({
    where: { status: { in: [DraftPreparationStatus.ACTIVE, DraftPreparationStatus.RECONCILIATION_REQUIRED] } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true, status: true },
  });
  expect(selected[0]?.id).toBe(preparationId);
  const clients = await Promise.all(Array.from({ length: 20 }, async () => {
    const client = proofPrismaClient();
    await client.$connect();
    return client;
  }));
  try {
    const outcomes = await Promise.allSettled(clients.map((client) =>
      new DraftRecoveryService(
        new DraftPreparationService(
          client,
          app.get(ConfigService),
          app.get<MediaObjectStore>(MEDIA_OBJECT_STORE),
          drafts,
          app.get(WordPressMediaClient),
        ),
      ).recover(1),
    ));
    console.info(JSON.stringify({
      proof: "round8b5a_draft_recovery_outcomes",
      contenders: 20,
      prepared: outcomes.filter((outcome) => outcome.status === "fulfilled" &&
        Array.isArray(outcome.value) && outcome.value.some((value: { outcome?: string }) => value.outcome === "PREPARED")).length,
      rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    }));
    return outcomes;
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
}

function proofPrismaClient(): PrismaService {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return new PrismaService({ datasources: { db: { url: url.toString() } } });
}

async function inbound(
  fixture: Fixture,
  text: string,
  interactive = false,
  expectedSequence = 1n,
  timestamp = "1000000000",
) {
  const id = `${marker}:approve:${randomUUID()}`;
  const message = {
    id,
    from: fixture.reporter.phoneNumber.slice(1),
    timestamp,
    ...(interactive
      ? {
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { id: text, title: "Approve" },
          },
        }
      : { type: "text", text: { body: text } }),
  };
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456789" },
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(Buffer.from(raw)).digest("hex")}`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await request(app.getHttpServer())
    .post("/webhooks/whatsapp")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", signature)
    .send(raw)
    .expect(200, { received: true });
  const event = await prisma.inboundEvent.findUniqueOrThrow({
    where: {
      provider_providerMessageId: {
        provider: Provider.WHATSAPP,
        providerMessageId: id,
      },
    },
  });
  expect(event).toMatchObject({
    processingStatus: InboundProcessingStatus.RECEIVED,
    senderPhone: fixture.reporter.phoneNumber,
    senderIngestSequence: expectedSequence,
  });
  return event;
}

describe("Round 7 combined authenticated approval to WordPress publication", () => {
  beforeAll(async () => {
    const host = `http://127.0.0.1:${port}`;
    jest
      .spyOn(SecureWordPressTransport.prototype, "send")
      .mockImplementation(async (input) => {
        const route = new URL(input.url).pathname;
        calls.push(`${input.method}:${route}`);
        if (wordpressOffline) throw new Error("Injected disposable WordPress outage");
        if (
          injectedFault &&
          injectedFault.remaining > 0 &&
          injectedFault.method === input.method &&
          route.startsWith(injectedFault.routePrefix)
        ) {
          injectedFault.remaining--;
          if (injectedFault.kind === "refuse") throw new Error("Injected connection refusal");
          if (injectedFault.kind === "timeout") throw new Error("Injected transport timeout");
          if (injectedFault.kind === "http503") return { status: 503, body: { code: "disposable_unavailable" } };
          if (injectedFault.kind === "malformed") return { status: 200, body: { malformed: true } };
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (
          failPublicationPost &&
          input.method === "POST" &&
          route === "/wp-json/newsroom/v1/publications"
        )
          throw new Error("Injected disposable transport uncertainty");
        if (
          publicationGetUnavailable &&
          input.method === "GET" &&
          route.startsWith("/wp-json/newsroom/v1/publications/")
        )
          throw new Error("Injected publication GET unavailability");
        const response = await fetch(`${host}${route}`, {
          method: input.method,
          headers: input.headers,
          body:
            typeof input.body === "string"
              ? input.body
              : input.body
                ? new Uint8Array(input.body)
                : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        const body = await response.text();
        if (
          loseAcceptedPublicationPost &&
          input.method === "POST" &&
          route === "/wp-json/newsroom/v1/publications" &&
          response.status === 200
        ) {
          publicationGetUnavailable = true;
          throw new Error("Injected accepted publication response loss");
        }
        if (route.startsWith("/wp-json/newsroom-media/v1/media"))
          mediaResponses.push({
            method: input.method,
            status: response.status,
            body,
          });
        if (
          holdSuccessfulMediaGet &&
          input.method === "GET" &&
          route.startsWith("/wp-json/newsroom-media/v1/media/") &&
          response.status === 200
        ) {
          mediaGetReached?.();
          await releaseMediaGet;
        }
        if (
          failDraftCreatePost &&
          input.method === "POST" &&
          route === "/wp-json/newsroom/v1/drafts"
        )
          throw new Error("Injected draft-create response loss");
        if (
          failDraftSyncPut &&
          input.method === "PUT" &&
          route.startsWith("/wp-json/newsroom/v1/drafts/")
        )
          throw new Error("Injected draft-sync response loss");
        if (
          failMediaPost &&
          input.method === "POST" &&
          route === "/wp-json/newsroom-media/v1/media" &&
          [200, 201].includes(response.status)
        )
          throw new Error("Injected media response loss");
        return {
          status: response.status,
          body: body ? (JSON.parse(body) as unknown) : null,
        };
      });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    processor = app.get(InboundEventProcessingService);
    drafts = app.get(WordPressDraftClient);
    publications = app.get(WordPressPublicationClient);
  });
  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    calls.length = 0;
    mediaResponses.length = 0;
    failPublicationPost = false;
    loseAcceptedPublicationPost = false;
    publicationGetUnavailable = false;
    failDraftCreatePost = false;
    failDraftSyncPut = false;
    failMediaPost = false;
    holdSuccessfulMediaGet = false;
    mediaGetReached = undefined;
    releaseMediaGet = undefined;
    injectedFault = undefined;
    wordpressOffline = false;
  });

  it("authenticates /approve, creates durable authority, publishes once, and finalises the same attempt", async () => {
    const x = await handoff("success");
    const event = await inbound(x, "/approve");
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(0);
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "PROCESSED",
    });
    const approval = await prisma.approval.findUniqueOrThrow({
      where: { storyId: x.story.id },
    });
    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
    });
    expect(approval).toMatchObject({
      reporterId: x.reporter.id,
      inboundEventId: event.id,
      draftPreparationId: x.preparation.id,
      storyVersion: x.story.version,
      wordpressAppliedVersion: x.state.applied_version,
    });
    expect(attempt).toMatchObject({
      approvalId: approval.id,
      attemptNumber: 1,
      idempotencyKey: `draft-publish:${x.preparation.id}:${x.story.version}`,
      status: PublishAttemptStatus.SUCCEEDED,
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({
      status: StoryStatus.PUBLISHED,
      version: x.story.version,
      wordpressPostId: BigInt(x.state.post_id),
    });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: x.conversation.id },
      }),
    ).toMatchObject({ state: ConversationState.IDLE, currentStoryId: null });
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({ processingStatus: InboundProcessingStatus.PROCESSED });
    expect(
      await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: x.preparation.id },
      }),
    ).toMatchObject({ status: DraftPreparationStatus.READY_FOR_APPROVAL });
    expect(calls).toContain(
      `GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}/state`,
    );
    expect(calls).toContain(
      `GET:/wp-json/newsroom/v1/publications/${attempt.id}`,
    );
    expect(calls).toContain("POST:/wp-json/newsroom/v1/publications");
    expect(
      calls.indexOf(`GET:/wp-json/newsroom/v1/publications/${attempt.id}`),
    ).toBeLessThan(calls.indexOf("POST:/wp-json/newsroom/v1/publications"));
    expect(
      await prisma.auditLog.count({
        where: { storyId: x.story.id, eventType: "story_approval_bound" },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { storyId: x.story.id, eventType: "story_publish_started" },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { storyId: x.story.id, eventType: "story_publish_succeeded" },
      }),
    ).toBe(1);
    expect(await publications.get(attempt.id)).toMatchObject({
      outcome: "PUBLISHED",
      publishKey: attempt.id,
      draftKey: x.story.wordpressDraftKey,
      postId: x.state.post_id,
      expectedAppliedVersion: x.state.applied_version,
    });
    expect(
      wpRead(
        `SELECT COUNT(*) FROM wp_newsroom_publications WHERE publish_key='${attempt.id}' AND status='PUBLISHED'`,
      ),
    ).toBe("1");
    expect(
      wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`),
    ).toBe("publish");
    const second = await inbound(x, "/approve", false, 2n);
    expect(await processor.process(second.id)).toMatchObject({
      outcome: "IGNORED",
    });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
    expect(
      wpRead(
        `SELECT COUNT(*) FROM wp_newsroom_publications WHERE draft_key='${x.story.wordpressDraftKey}'`,
      ),
    ).toBe("1");
  });

  it("rejects real WordPress Phase-0 drift before creating Approval", async () => {
    const x = await handoff("drift");
    await drafts.syncDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: "Unapproved drift",
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
      editorialByline: x.story.byline!,
      featuredMediaKey: null,
      expectedVersion: x.state.applied_version,
    });
    const event = await inbound(x, "/approve");
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "RETRY_REQUIRED",
      reason: "WORDPRESS_STATE_MISMATCH",
    });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(0);
    expect(
      wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`),
    ).toBe("draft");
    expect(
      wpRead(
        `SELECT COUNT(*) FROM wp_newsroom_publications WHERE draft_key='${x.story.wordpressDraftKey}'`,
      ),
    ).toBe("0");
  });

  it("preserves non-automatic reconciliation after a real-client publication transport uncertainty", async () => {
    const x = await handoff("uncertain");
    const event = await inbound(x, "/approve");
    failPublicationPost = true;
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "PUBLISH_RECONCILIATION_REQUIRED",
    });
    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
    });
    expect(attempt.status).toBe(PublishAttemptStatus.RECONCILIATION_REQUIRED);
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "NOT_CLAIMED",
    });
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
    expect(
      wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`),
    ).toBe("draft");
  });

  if (process.env.ROUND8B5A_CONTENTION_PROOF === "1") {
  it("reconciles accepted CREATE_DRAFT response loss with twenty real recovery contenders", async () => {
    const x = await pendingPreparation("r8b5a-create-accepted-lost");
    failDraftCreatePost = true;
    const first = await drafts.createDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: x.story.headline!,
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
    });
    expect(first.outcome).toBe("RECOVERED");
    expect((await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).wordpressPostId)
      .toBeNull();
    expect((await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).wordpressPostId)
      .toBeNull();
    failDraftCreatePost = false;
    const recoveryStart = calls.length;
    const outcomes = await contendDraftRecovery(x.preparation.id);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const recoveryCalls = calls.slice(recoveryStart);
    expect(recoveryCalls[0]).toBe(`GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`);
    expect(recoveryCalls).not.toContain("POST:/wp-json/newsroom/v1/drafts");
    expect(calls.filter((call) => call === "POST:/wp-json/newsroom/v1/drafts"))
      .toHaveLength(1);
    expect(wpRead(`SELECT COUNT(*) FROM wp_posts WHERE ID=${first.wordpressPostId}`)).toBe("1");
    expect(await prisma.draftPreparation.count({ where: { storyId: x.story.id } })).toBe(1);
    expect((await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).version)
      .toBe(x.story.version);
    expect((await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).wordpressPostId)
      .toBe(BigInt(first.wordpressPostId));
    expect(await prisma.outboundMessage.count({ where: { storyId: x.story.id } })).toBeLessThanOrEqual(1);
    console.info(JSON.stringify({
      proof: "round8b5a_create_accepted_lost_response",
      contenders: 20,
      recoveryGetCalls: recoveryCalls.filter((call) => call.startsWith("GET:/wp-json/newsroom/v1/drafts/")).length,
      createCalls: 1,
      wordpressPostIdentities: 1,
      preparationCount: 1,
      duplicatePromptCount: 0,
    }));
  });

  it("reconciles accepted SYNC_DRAFT response loss with twenty real recovery contenders", async () => {
    const x = await pendingPreparation("r8b5a-sync-accepted-lost");
    const created = await drafts.createDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: x.story.headline!,
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
    });
    await prisma.story.update({
      where: { id: x.story.id },
      data: { wordpressPostId: BigInt(created.wordpressPostId), status: StoryStatus.DRAFT_CREATED },
    });
    await prisma.draftPreparation.update({
      where: { id: x.preparation.id },
      data: { wordpressPostId: BigInt(created.wordpressPostId) },
    });
    failDraftSyncPut = true;
    const first = await drafts.syncDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: x.story.headline!,
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
      editorialByline: x.story.byline!,
      featuredMediaKey: null,
    });
    expect(first.outcome).toBe("RECOVERED");
    expect((await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).wordpressAppliedVersion)
      .toBeNull();
    failDraftSyncPut = false;
    const recoveryStart = calls.length;
    const outcomes = await contendDraftRecovery(x.preparation.id);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const recoveryCalls = calls.slice(recoveryStart);
    expect(recoveryCalls[0]).toBe(`GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`);
    expect(recoveryCalls).not.toContain(`PUT:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`);
    expect(calls.filter((call) => call === `PUT:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`))
      .toHaveLength(1);
    expect((await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).wordpressAppliedVersion)
      .toBe(first.applied_version);
    expect(await prisma.draftPreparation.count({ where: { storyId: x.story.id } })).toBe(1);
    expect(await prisma.outboundMessage.count({ where: { storyId: x.story.id } })).toBeLessThanOrEqual(1);
    console.info(JSON.stringify({
      proof: "round8b5a_sync_accepted_lost_response",
      contenders: 20,
      recoveryGetCalls: recoveryCalls.filter((call) => call.startsWith("GET:/wp-json/newsroom/v1/drafts/")).length,
      syncCalls: 1,
      appliedVersion: first.applied_version,
      duplicateMutations: 0,
    }));
  });

  it("keeps twenty ordinary draft reconciliation scans GET-first without another mutation", async () => {
    const x = await pendingPreparation("r8b5a-draft-reconciliation-hold");
    const created = await drafts.createDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: x.story.headline!,
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
    });
    const synced = await drafts.syncDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: x.story.headline!,
      body: x.story.body!,
      wordpressCategoryIds: [categoryId],
      editorialByline: x.story.byline!,
      featuredMediaKey: null,
    });
    await prisma.story.update({
      where: { id: x.story.id },
      data: { wordpressPostId: BigInt(created.wordpressPostId), status: StoryStatus.DRAFT_CREATED },
    });
    await prisma.draftPreparation.update({
      where: { id: x.preparation.id },
      data: {
        wordpressPostId: BigInt(created.wordpressPostId),
        status: DraftPreparationStatus.RECONCILIATION_REQUIRED,
        lastErrorCode: "WORDPRESS_DRAFT_RECONCILIATION_REQUIRED",
      },
    });
    const recoveryStart = calls.length;
    const outcomes = await contendDraftRecovery(x.preparation.id);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const recoveryCalls = calls.slice(recoveryStart);
    expect(recoveryCalls[0]).toBe(`GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`);
    expect(recoveryCalls).not.toContain("POST:/wp-json/newsroom/v1/drafts");
    expect(recoveryCalls).not.toContain(`PUT:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`);
    expect((await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).wordpressAppliedVersion)
      .toBe(synced.applied_version);
    console.info(JSON.stringify({
      proof: "round8b5a_draft_reconciliation_get_first",
      ordinaryContenders: 20,
      recoveryGetCalls: recoveryCalls.filter((call) => call.startsWith("GET:/wp-json/newsroom/v1/drafts/")).length,
      recoveryMutationCalls: 0,
    }));
  });

  it("reconciles accepted WordPress media response loss with twenty preparation contenders", async () => {
    const x = await pendingPreparation("r8b5a-wp-media-accepted-lost");
    const bytes = makePng();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const item = await prisma.storyMedia.create({
      data: {
        storyId: x.story.id,
        providerMediaId: `${marker}:wp-media:${randomUUID()}`,
        mediaType: "IMAGE",
        status: MediaProcessingStatus.UPLOADING,
        mimeType: "image/png",
        fileSizeBytes: BigInt(bytes.length),
        sha256,
        position: 0,
      },
    });
    const endpoint = process.env.ROUND8B2_S3_ENDPOINT;
    if (!endpoint) throw new Error("Disposable S3 endpoint is required");
    const s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "proof", secretAccessKey: "proof-secret" },
    });
    try {
      await s3.send(new CreateBucketCommand({ Bucket: "proof-media" })).catch(() => undefined);
      const objects = app.get<MediaObjectStore>(MEDIA_OBJECT_STORE);
      expect(await objects.putIfAbsent(mediaObjectKey(item.id), {
        bytes, size: bytes.length, mimeType: "image/png", sha256,
      })).toBe("CREATED");
      failMediaPost = true;
      const first = await app.get(WordPressMediaClient).uploadMedia({
        mediaKey: item.id,
        filename: `${item.id}.png`,
        mimeType: "image/png",
        body: bytes,
      });
      expect(first.outcome).toBe("RECOVERED");
      expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: item.id } })).wordpressMediaId)
        .toBeNull();
      failMediaPost = false;
      const recoveryStart = calls.length;
      const outcomes = await contendDraftRecovery(x.preparation.id);
      expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => {
        const reason = outcome.reason as { code?: unknown; name?: unknown };
        return { code: reason.code ?? null, name: reason.name ?? null };
      })).toEqual([]);
      const recoveryCalls = calls.slice(recoveryStart);
      expect(recoveryCalls[0]).toBe(`GET:/wp-json/newsroom-media/v1/media/${item.id}`);
      expect(recoveryCalls).not.toContain("POST:/wp-json/newsroom-media/v1/media");
      expect(calls.filter((call) => call === "POST:/wp-json/newsroom-media/v1/media"))
        .toHaveLength(1);
      expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${item.id}'`))
        .toBe("1");
      expect((await prisma.storyMedia.findUniqueOrThrow({ where: { id: item.id } })).wordpressMediaId)
        .toBe(BigInt(first.attachmentId));
      expect(await prisma.storyMedia.count({ where: { storyId: x.story.id } })).toBe(1);
      expect(await prisma.draftPreparation.count({ where: { storyId: x.story.id } })).toBe(1);
      console.info(JSON.stringify({
        proof: "round8b5a_wordpress_media_accepted_lost_response",
        contenders: 20,
        recoveryGetCalls: recoveryCalls.filter((call) => call === `GET:/wp-json/newsroom-media/v1/media/${item.id}`).length,
        mediaUploadCalls: 1,
        attachmentIdentities: 1,
        duplicateEffects: 0,
      }));
    } finally {
      s3.destroy();
    }
  });

  it("lets twenty real-client draft recovery scans converge on one ACTIVE preparation", async () => {
    const x = await handoff("r8b5a-draft-contention");
    await prisma.$transaction([
      prisma.story.update({
        where: { id: x.story.id },
        data: { status: StoryStatus.DRAFT_CREATED },
      }),
      prisma.conversation.update({
        where: { id: x.conversation.id },
        data: { state: ConversationState.COLLECTING_MEDIA },
      }),
      prisma.draftPreparation.update({
        where: { id: x.preparation.id },
        data: { status: DraftPreparationStatus.ACTIVE },
      }),
      prisma.inboundEvent.update({
        where: { id: x.preparation.inboundEventId },
        data: {
          processingStatus: InboundProcessingStatus.PROCESSING,
          processingAttempts: 1,
          processingContractVersion: 1,
          processingStartedAt: new Date(),
          processedAt: null,
        },
      }),
    ]);
    calls.length = 0;
    await prisma.draftPreparation.update({
      where: { id: x.preparation.id },
      data: { updatedAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = proofPrismaClient();
        await client.$connect();
        return client;
      }),
    );
    let settled: PromiseSettledResult<unknown>[];
    try {
      settled = await Promise.allSettled(
        clients.map((client) =>
          new DraftRecoveryService(
            new DraftPreparationService(
              client,
              app.get(ConfigService),
              app.get<MediaObjectStore>(MEDIA_OBJECT_STORE),
              drafts,
              app.get(WordPressMediaClient),
            ),
          ).recover(1),
        ),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(0);
    expect(await prisma.draftPreparation.count({ where: { storyId: x.story.id } })).toBe(1);
    expect(await prisma.publishAttempt.count({
      where: { storyId: x.story.id, operation: PublishOperation.SYNC_DRAFT },
    })).toBe(1);
    expect(await prisma.publishAttempt.count({
      where: { storyId: x.story.id, operation: PublishOperation.CREATE_DRAFT },
    })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { storyId: x.story.id } })).toBe(1);
    expect((await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).version)
      .toBe(x.story.version);
    expect(calls.filter((call) => call.startsWith("POST:/wp-json/newsroom/v1/drafts")))
      .toHaveLength(0);
    expect(calls.filter((call) => call.startsWith("PUT:/wp-json/newsroom/v1/drafts")))
      .toHaveLength(0);
    expect(wpRead(`SELECT COUNT(*) FROM wp_posts WHERE ID=${x.state.post_id}`)).toBe("1");
    console.info(JSON.stringify({
      proof: "round8b5a_wordpress_draft_contention",
      contenders: 20,
      getCalls: calls.filter((call) => call.startsWith("GET:/wp-json/newsroom/v1/drafts/")).length,
      mutationCalls: 0,
      preparationCount: 1,
      wordpressPostCount: 1,
      duplicateEffects: 0,
    }));
  });

  it("converges twenty real-client publication drivers on one disposable WordPress ledger", async () => {
    const x = await handoff("r8b5a-publish-contention");
    const event = await inbound(x, "/approve");
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: {
        reporterId: x.reporter.id,
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(),
      },
    });
    await prisma.story.update({
      where: { id: x.story.id },
      data: { status: StoryStatus.APPROVED, approvedAt: new Date() },
    });
    const approval = await prisma.approval.create({
      data: {
        storyId: x.story.id,
        reporterId: x.reporter.id,
        inboundEventId: event.id,
        draftPreparationId: x.preparation.id,
        storyVersion: x.story.version,
        wordpressAppliedVersion: x.state.applied_version,
      },
    });
    const attempt = await prisma.publishAttempt.create({
      data: {
        storyId: x.story.id,
        approvalId: approval.id,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
        attemptNumber: 1,
        idempotencyKey: `draft-publish:${x.preparation.id}:${x.story.version}`,
        wordpressPostId: BigInt(x.state.post_id),
      },
    });
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
          new PublishAttemptDriverService(
            client,
            new Round7PublishSagaService(
              client,
              publications,
              new ConversationStateMachineService(client),
            ),
          ).runOnce(1),
        ),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(0);
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } })).toBe(1);
    expect(await prisma.approval.count({ where: { storyId: x.story.id } })).toBe(1);
    expect((await prisma.publishAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status)
      .toBe(PublishAttemptStatus.SUCCEEDED);
    expect((await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).status)
      .toBe(StoryStatus.PUBLISHED);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: x.conversation.id } }))
      .toMatchObject({ state: ConversationState.IDLE, currentStoryId: null });
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_publications WHERE publish_key='${attempt.id}' AND status='PUBLISHED'`))
      .toBe("1");
    expect(calls.filter((call) => call === "POST:/wp-json/newsroom/v1/publications"))
      .toHaveLength(1);
    console.info(JSON.stringify({
      proof: "round8b5a_wordpress_publication_contention",
      contenders: 20,
      getCalls: calls.filter((call) => call === `GET:/wp-json/newsroom/v1/publications/${attempt.id}`).length,
      publishCalls: calls.filter((call) => call === "POST:/wp-json/newsroom/v1/publications").length,
      duplicateEffects: 0,
      attemptStatus: "SUCCEEDED",
      storyStatus: "PUBLISHED",
      conversationState: "IDLE",
    }));
  });

  it("holds twenty ordinary drivers after accepted publication response loss and supervises the same ledger", async () => {
    const x = await handoff("r8b5a-publish-accepted-lost");
    const event = await inbound(x, "/approve");
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: {
        reporterId: x.reporter.id,
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(),
      },
    });
    await prisma.story.update({
      where: { id: x.story.id },
      data: { status: StoryStatus.APPROVED, approvedAt: new Date() },
    });
    const approval = await prisma.approval.create({
      data: {
        storyId: x.story.id,
        reporterId: x.reporter.id,
        inboundEventId: event.id,
        draftPreparationId: x.preparation.id,
        storyVersion: x.story.version,
        wordpressAppliedVersion: x.state.applied_version,
      },
    });
    const attempt = await prisma.publishAttempt.create({
      data: {
        storyId: x.story.id,
        approvalId: approval.id,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
        attemptNumber: 1,
        idempotencyKey: `draft-publish:${x.preparation.id}:${x.story.version}`,
        wordpressPostId: BigInt(x.state.post_id),
      },
    });
    loseAcceptedPublicationPost = true;
    const first = new PublishAttemptDriverService(
      prisma,
      new Round7PublishSagaService(
        prisma,
        publications,
        new ConversationStateMachineService(prisma),
      ),
    );
    expect(await first.runOnce(1)).toMatchObject([
      { outcome: "PUBLISH_RECONCILIATION_REQUIRED" },
    ]);
    expect((await prisma.publishAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status)
      .toBe(PublishAttemptStatus.RECONCILIATION_REQUIRED);
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_publications WHERE publish_key='${attempt.id}' AND status='PUBLISHED'`))
      .toBe("1");
    const postCount = calls.filter((call) => call === "POST:/wp-json/newsroom/v1/publications").length;
    expect(postCount).toBe(1);
    loseAcceptedPublicationPost = false;
    publicationGetUnavailable = false;
    const clients = await Promise.all(Array.from({ length: 20 }, async () => {
      const client = new PrismaService();
      await client.$connect();
      return client;
    }));
    try {
      const outcomes = await Promise.allSettled(clients.map((client) =>
        new PublishAttemptDriverService(
          client,
          new Round7PublishSagaService(
            client,
            publications,
            new ConversationStateMachineService(client),
          ),
        ).runOnce(1),
      ));
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(calls.filter((call) => call === "POST:/wp-json/newsroom/v1/publications"))
        .toHaveLength(1);
      expect((await prisma.publishAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status)
        .toBe(PublishAttemptStatus.RECONCILIATION_REQUIRED);
      const supervised = await new Round7PublishSagaService(
        prisma,
        publications,
        new ConversationStateMachineService(prisma),
      ).reconcileSupervised(attempt.id);
      expect(supervised).toMatchObject({ outcome: "PROCESSED" });
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    expect(calls.filter((call) => call === "POST:/wp-json/newsroom/v1/publications"))
      .toHaveLength(1);
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } }))
      .toBe(1);
    expect(await prisma.approval.count({ where: { storyId: x.story.id } })).toBe(1);
    expect((await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).status)
      .toBe(StoryStatus.PUBLISHED);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: x.conversation.id } }))
      .toMatchObject({ state: ConversationState.IDLE, currentStoryId: null });
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).processingStatus)
      .toBe(InboundProcessingStatus.PROCESSED);
    console.info(JSON.stringify({
      proof: "round8b5a_publication_accepted_lost_response",
      ordinaryContenders: 20,
      getCalls: calls.filter((call) => call === `GET:/wp-json/newsroom/v1/publications/${attempt.id}`).length,
      publishCalls: 1,
      ledgerIdentities: 1,
      attemptCount: 1,
      publicationEffects: 1,
    }));
  });
  }

  it("reconciles accepted CREATE_DRAFT response loss by GET before another create", async () => {
    const key = randomUUID();
    failDraftCreatePost = true;
    const result = await drafts.createDraft({
      wordpressDraftKey: key,
      headline: "Recovery draft",
      body: "Recovery body",
      wordpressCategoryIds: [categoryId],
    });
    expect(result.outcome).toBe("RECOVERED");
    const post = calls.findIndex(
      (call) => call === "POST:/wp-json/newsroom/v1/drafts",
    );
    const get = calls.findIndex(
      (call) => call === `GET:/wp-json/newsroom/v1/drafts/${key}`,
    );
    expect(post).toBeGreaterThanOrEqual(0);
    expect(get).toBeGreaterThan(post);
    expect(await drafts.getDraftByKey(key)).toMatchObject({
      wordpressDraftKey: key,
      wordpressPostId: result.wordpressPostId,
    });
  });

  if (process.env.ROUND8B5B_FAULT_PROOF === "1") {
  it("holds a durable draft backlog through WordPress outage and drains after restoration", async () => {
    const x = await pendingPreparation("r8b5-wordpress-outage");
    const preparationService = app.get(DraftPreparationService);
    const outageStarted = Date.now();
    wordpressOffline = true;
    const held = await preparationService.prepare(x.preparation.id);
    expect(held.outcome).not.toBe("PREPARED");
    const during = await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } });
    expect(during.status).toBe(DraftPreparationStatus.RECONCILIATION_REQUIRED);
    expect(await prisma.draftPreparation.count({ where: { id: x.preparation.id, status: DraftPreparationStatus.RECONCILIATION_REQUIRED } })).toBe(1);
    // Nest exposes the HTTP server as `any`; Supertest validates the response.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer()).get("/health/live").expect(200);
    const unrelated = await prisma.inboundEvent.create({ data: {
      provider: Provider.WHATSAPP, providerMessageId: randomUUID(), senderPhone: "+263770999998",
      senderIngestSequence: 1n, eventType: "TEXT", processingStatus: InboundProcessingStatus.RECEIVED,
      rawPayload: {},
    } });
    expect(unrelated.processingStatus).toBe(InboundProcessingStatus.RECEIVED);
    const outageMs = Date.now() - outageStarted;
    wordpressOffline = false;
    const drainStarted = Date.now();
    expect(await preparationService.recoverPreparation(x.preparation.id)).toMatchObject({ outcome: "PREPARED" });
    const after = await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } });
    expect(after.status).toBe(DraftPreparationStatus.ACTIVE);
    expect(after.wordpressPostId).not.toBeNull();
    expect(after.wordpressAppliedVersion).not.toBeNull();
    expect(await prisma.draftPreparation.count({ where: { storyId: x.story.id } })).toBe(1);
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key='${x.story.wordpressDraftKey}'`)).toBe("1");
    console.info(JSON.stringify({ proof: "round8b5_wordpress_outage_drain", outageMs, backlogDuring: 1, backlogAfter: 0, drainMs: Date.now() - drainStarted, duplicateDrafts: 0 }));
  });

  it("holds uncertain draft CREATE through transport faults and restores by permanent key", async () => {
    for (const kind of ["refuse", "timeout", "http503", "latency"] as const) {
      const key = randomUUID();
      injectedFault = { method: "POST", routePrefix: "/wp-json/newsroom/v1/drafts", kind, remaining: 1 };
      const result = await drafts.createDraft({
        wordpressDraftKey: key,
        headline: `Fault ${kind}`,
        body: "Disposable draft body",
        wordpressCategoryIds: [categoryId],
      });
      expect(result.wordpressDraftKey).toBe(key);
      if (kind !== "latency") {
        expect(calls.filter((call) => call === `GET:/wp-json/newsroom/v1/drafts/${key}`)).toHaveLength(1);
      }
      expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key='${key}'`)).toBe("1");
      injectedFault = undefined;
      calls.length = 0;
    }
  });

  it("fails closed when draft CREATE reconciliation GET is unavailable or malformed", async () => {
    for (const kind of ["refuse", "http503", "malformed"] as const) {
      const key = randomUUID();
      failDraftCreatePost = true;
      injectedFault = { method: "GET", routePrefix: `/wp-json/newsroom/v1/drafts/${key}`, kind, remaining: 10 };
      await expect(drafts.createDraft({ wordpressDraftKey: key, headline: "Held", body: "Held", wordpressCategoryIds: [categoryId] })).rejects.toThrow();
      expect(calls.filter((call) => call === "POST:/wp-json/newsroom/v1/drafts")).toHaveLength(1);
      injectedFault = undefined;
      failDraftCreatePost = false;
      const restored = await drafts.getDraftByKey(key);
      expect(restored.wordpressDraftKey).toBe(key);
      expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key='${key}'`)).toBe("1");
      calls.length = 0;
    }
  });

  it("holds uncertain media upload through unavailable GET and reuses attachment after restoration", async () => {
    const client = app.get(WordPressMediaClient);
    for (const kind of ["refuse", "timeout", "http503", "malformed"] as const) {
      const key = randomUUID();
      failMediaPost = true;
      injectedFault = { method: "GET", routePrefix: `/wp-json/newsroom-media/v1/media/${key}`, kind, remaining: 10 };
      await expect(client.uploadMedia({ mediaKey: key, filename: "fault.png", mimeType: "image/png", body: makePng() })).rejects.toThrow();
      expect(calls.filter((call) => call === "POST:/wp-json/newsroom-media/v1/media")).toHaveLength(1);
      injectedFault = undefined;
      failMediaPost = false;
      const existing = await client.getMediaByKey(key);
      expect(existing.mediaKey).toBe(key);
      expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${key}'`)).toBe("1");
      calls.length = 0;
    }
  });
  }

  it("reconciles accepted SYNC_DRAFT response loss with full-state GET", async () => {
    const x = await handoff("sync-recovery");
    failDraftSyncPut = true;
    const result = await drafts.syncDraft({
      wordpressDraftKey: x.story.wordpressDraftKey,
      headline: "Recovered headline",
      body: "Recovered body",
      wordpressCategoryIds: [categoryId],
      editorialByline: x.story.byline!,
      featuredMediaKey: null,
      expectedVersion: x.state.applied_version,
    });
    expect(result.outcome).toBe("RECOVERED");
    const put = calls.findIndex(
      (call) =>
        call === `PUT:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}`,
    );
    const get = calls.findIndex(
      (call) =>
        call ===
        `GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}/state`,
    );
    expect(put).toBeGreaterThanOrEqual(0);
    expect(get).toBeGreaterThan(put);
    expect(
      (await drafts.getDraftState(x.story.wordpressDraftKey)).applied_version,
    ).toBe(result.applied_version);
  });

  if (process.env.ROUND8B2_RECOVERY_PROOF === "1") {
  it("reconciles accepted WordPress media response loss by deterministic GET", async () => {
    const client = app.get(WordPressMediaClient);
    const key = randomUUID();
    failMediaPost = true;
    const result = await client.uploadMedia({
      mediaKey: key,
      filename: "recovery.png",
      mimeType: "image/png",
      body: makePng(),
    });
    expect(result.outcome).toBe("RECOVERED");
    expect(mediaResponses.map(({ method, status }) => ({ method, status }))).toEqual([
      { method: "POST", status: 201 },
      { method: "GET", status: 200 },
    ]);
    expect(
      calls.indexOf(`GET:/wp-json/newsroom-media/v1/media/${key}`),
    ).toBeGreaterThan(calls.indexOf("POST:/wp-json/newsroom-media/v1/media"));
    expect(await client.getMediaByKey(key)).toMatchObject({
      mediaKey: key,
      attachmentId: result.attachmentId,
    });
    expect(
      wpRead(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${key}'`),
    ).toBe("1");
  });

  it("transfers real S3 and WordPress media evidence from stale generation N to N+1 without duplication", async () => {
    const x = await handoff("media-authority-transfer");
    const bytes = makePng();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const event = await prisma.inboundEvent.update({
      where: { id: x.preparation.inboundEventId },
      data: {
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(),
      },
    });
    await prisma.story.update({
      where: { id: x.story.id },
      data: { status: StoryStatus.DRAFT_CREATING },
    });
    await prisma.conversation.update({
      where: { id: x.conversation.id },
      data: { state: ConversationState.COLLECTING_MEDIA },
    });
    const preparation = await prisma.draftPreparation.update({
      where: { id: x.preparation.id },
      data: {
        status: DraftPreparationStatus.ACTIVE,
        wordpressPostId: null,
        wordpressAppliedVersion: null,
        approvalPromptOutboundMessageId: null,
      },
    });
    const item = await prisma.storyMedia.create({
      data: {
        storyId: x.story.id,
        providerMediaId: `${marker}:media:${randomUUID()}`,
        mediaType: "IMAGE",
        status: MediaProcessingStatus.FETCHED,
        mimeType: "image/png",
        fileSizeBytes: BigInt(bytes.length),
        sha256,
        position: 0,
      },
    });
    const endpoint = process.env.ROUND8B2_S3_ENDPOINT;
    if (!endpoint) throw new Error("Disposable S3 endpoint is required");
    const s3 = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "proof", secretAccessKey: "proof-secret" },
    });
    await s3
      .send(new CreateBucketCommand({ Bucket: "proof-media" }))
      .catch(() => undefined);
    const objects = app.get<MediaObjectStore>(MEDIA_OBJECT_STORE);
    expect(
      await objects.putIfAbsent(mediaObjectKey(item.id), {
        bytes,
        size: bytes.length,
        mimeType: "image/png",
        sha256,
      }),
    ).toBe("CREATED");
    const service: {
      reconcileMedia(
        preparation: DraftPreparation,
        item: StoryMedia,
        claim: InboundProcessingClaim,
      ): Promise<void>;
    } = app.get(DraftPreparationService);
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    releaseMediaGet = new Promise<void>((resolve) => {
      release = resolve;
    });
    mediaGetReached = reached;
    holdSuccessfulMediaGet = true;
    failMediaPost = true;
    const generationN = service.reconcileMedia(preparation, item, {
      eventId: event.id,
      processingAttempt: 1,
      processingContractVersion: 1,
    });
    await reachedPromise;
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: { processingAttempts: 2, processingStartedAt: new Date() },
    });
    release();
    await expect(generationN).rejects.toBeDefined();
    holdSuccessfulMediaGet = false;
    failMediaPost = false;
    expect(
      await prisma.storyMedia.findUniqueOrThrow({ where: { id: item.id } }),
    ).toMatchObject({
      status: MediaProcessingStatus.UPLOADING,
      wordpressMediaId: null,
    });
    expect(
      await prisma.auditLog.count({
        where: { entityId: item.id, eventType: "wordpress_media_reconciled" },
      }),
    ).toBe(0);
    await service.reconcileMedia(
      preparation,
      await prisma.storyMedia.findUniqueOrThrow({ where: { id: item.id } }),
      {
        eventId: event.id,
        processingAttempt: 2,
        processingContractVersion: 1,
      },
    );
    const finalMedia = await prisma.storyMedia.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(finalMedia).toMatchObject({ status: MediaProcessingStatus.UPLOADED });
    expect(finalMedia.wordpressMediaId).not.toBeNull();
    expect(await objects.head(mediaObjectKey(item.id))).toMatchObject({
      size: bytes.length,
      mimeType: "image/png",
      sha256,
    });
    expect(
      wpRead(
        `SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${item.id}'`,
      ),
    ).toBe("1");
    expect(
      wpRead(
        `SELECT attachment_id FROM wp_newsroom_media WHERE media_key='${item.id}'`,
      ),
    ).toBe(finalMedia.wordpressMediaId?.toString());
    expect(
      await prisma.storyMedia.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.draftPreparation.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.story.count({ where: { id: x.story.id, version: 3 } }),
    ).toBe(1);
    s3.destroy();
  });
  }

  it("routes an authenticated bound interactive control through the same approval/publication path", async () => {
    const x = await handoff("interactive");
    const event = await inbound(
      x,
      `newsroom:v1:story:approve:${x.prompt.id}`,
      true,
    );
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "PROCESSED",
    });
    expect(
      await prisma.approval.findUniqueOrThrow({
        where: { storyId: x.story.id },
      }),
    ).toMatchObject({ inboundEventId: event.id });
    expect(
      wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`),
    ).toBe("publish");
  });

  it("uses stored receivedAt before/equal cutover, never provider time, and never replays an ignored event", async () => {
    const cutover = new Date("2026-01-01T00:00:00.000Z");
    const before = await handoff("before-cutover");
    const oldEvent = await inbound(before, "/approve", false, 1n, "4070908800");
    await prisma.inboundEvent.update({
      where: { id: oldEvent.id },
      data: {
        receivedAt: new Date(cutover.getTime() - 1),
      },
    });
    expect(await processor.process(oldEvent.id)).toMatchObject({
      outcome: "IGNORED",
      reason: "CONTROL_NOT_ENABLED",
    });
    expect(
      await prisma.approval.count({ where: { storyId: before.story.id } }),
    ).toBe(0);
    expect(await processor.process(oldEvent.id)).toMatchObject({
      outcome: "NOT_CLAIMED",
    });

    const equal = await handoff("equal-cutover");
    const equalEvent = await inbound(equal, "/approve");
    await prisma.inboundEvent.update({
      where: { id: equalEvent.id },
      data: { receivedAt: cutover },
    });
    expect(await processor.process(equalEvent.id)).toMatchObject({
      outcome: "PROCESSED",
    });
    expect(
      await prisma.approval.count({ where: { storyId: equal.story.id } }),
    ).toBe(1);
    expect(
      wpRead(
        `SELECT post_status FROM wp_posts WHERE ID=${equal.state.post_id}`,
      ),
    ).toBe("publish");
  });

  it("allows approved-epoch publication after preview expiry but refuses a new token after publication", async () => {
    const x = await handoff("expired-preview");
    const expiredAt = new Date(
      Math.max(x.preparation.startedAt.getTime() + 1, Date.now() - 1),
    );
    await prisma.draftPreparation.update({
      where: { id: x.preparation.id },
      data: { previewExpiresAt: expiredAt },
    });
    const event = await inbound(x, "/approve");
    expect(await processor.process(event.id)).toMatchObject({
      outcome: "PROCESSED",
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({
      status: StoryStatus.PUBLISHED,
      version: x.story.version,
    });
    await expect(
      app.get(PreviewTokenService).issue(x.preparation.id),
    ).rejects.toThrow();
  });
});
