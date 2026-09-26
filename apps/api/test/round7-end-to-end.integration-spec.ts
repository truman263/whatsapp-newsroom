/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ConversationState, DraftPreparationStatus, InboundProcessingStatus,
  OutboundMessageStatus, OutboundMessageType, Provider, PublishAttemptStatus,
  PublishOperation, ReporterStatus, StoryStatus,
} from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/database/prisma.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { PreviewTokenService } from "../src/modules/newsroom-preview/newsroom-preview-token.service";
import { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import { WordPressPublicationClient } from "../src/modules/wordpress-publication/wordpress-publication.client";
import { SecureWordPressTransport } from "../src/modules/wordpress-transport/wordpress-secure-transport";

const port = process.env.ROUND7_TEST_WORDPRESS_PORT;
const categoryId = Number(process.env.ROUND7_TEST_CATEGORY_ID);
if (!process.env.DATABASE_URL || !port || !Number.isSafeInteger(categoryId))
  throw new Error("Run this suite with pnpm test:round7-integration; isolated runtime configuration is required.");

jest.setTimeout(120_000);
const marker = `r7-combined-${randomUUID()}`;
let app: INestApplication;
let prisma: PrismaService;
let processor: InboundEventProcessingService;
let drafts: WordPressDraftClient;
let publications: WordPressPublicationClient;
const calls: string[] = [];
let failPublicationPost = false;

type Fixture = Awaited<ReturnType<typeof handoff>>;

function wpRead(sql: string): string {
  const project = process.env.ROUND7_TEST_COMPOSE_PROJECT;
  const envFile = process.env.ROUND7_TEST_COMPOSE_ENV_FILE;
  if (!project || !envFile) throw new Error("Disposable WordPress CLI configuration is required");
  const result = spawnSync("docker", ["compose", "--project-name", project, "--env-file", envFile, "--file", "wordpress/runtime/draft-sync-implementation/compose.yaml", "exec", "-T", "cli", "wp", "db", "query", sql, "--skip-column-names", "--silent"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Disposable WordPress read failed");
  return result.stdout.trim();
}

async function handoff(name: string) {
  const reporter = await prisma.reporter.create({ data: {
    phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
    displayName: `${marker}:${name}`, status: ReporterStatus.ACTIVE,
  } });
  const category = await prisma.editorialCategory.upsert({
    where: { wordpressCategoryId: BigInt(categoryId) },
    create: { wordpressCategoryId: BigInt(categoryId), name: "Round 7 proof", slug: "round7-proof" },
    update: {},
  });
  const story = await prisma.story.create({ data: {
    reporterId: reporter.id, status: StoryStatus.AWAITING_APPROVAL,
    headline: `Headline ${name}`, body: `Body ${name}`, byline: "Proof Reporter", version: 3,
  } });
  await prisma.storyCategory.create({ data: { storyId: story.id, categoryId: category.id } });
  const created = await drafts.createDraft({ wordpressDraftKey: story.wordpressDraftKey, headline: story.headline!, body: story.body!, wordpressCategoryIds: [categoryId] });
  const synced = await drafts.syncDraft({ wordpressDraftKey: story.wordpressDraftKey, headline: story.headline!, body: story.body!, wordpressCategoryIds: [categoryId], editorialByline: story.byline!, featuredMediaKey: null });
  const state = await drafts.getDraftState(story.wordpressDraftKey);
  expect(state).toMatchObject({ status: "draft", post_id: created.wordpressPostId, applied_version: synced.applied_version });
  await prisma.story.update({ where: { id: story.id }, data: { wordpressPostId: BigInt(state.post_id) } });
  const conversation = await prisma.conversation.create({ data: { reporterId: reporter.id, state: ConversationState.AWAITING_APPROVAL, currentStoryId: story.id } });
  const prepEvent = await prisma.inboundEvent.create({ data: {
    provider: Provider.WHATSAPP, providerMessageId: `${marker}:done:${name}`,
    reporterId: reporter.id, senderPhone: reporter.phoneNumber,
    senderIngestSequence: 0n, eventType: "TEXT", processingStatus: InboundProcessingStatus.PROCESSED,
    rawPayload: { message: {} },
  } });
  await prisma.inboundSenderSequence.create({ data: { senderPhone: reporter.phoneNumber, nextValue: 1n } });
  const preparation = await prisma.draftPreparation.create({ data: {
    storyId: story.id, inboundEventId: prepEvent.id, storyVersion: story.version,
    status: DraftPreparationStatus.READY_FOR_APPROVAL, wordpressPostId: BigInt(state.post_id),
    wordpressAppliedVersion: state.applied_version,
    approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
    previewExpiresAt: new Date(Date.now() + 60_000),
  } });
  const prompt = await prisma.outboundMessage.create({ data: {
    reporterId: reporter.id, storyId: story.id, type: OutboundMessageType.INTERACTIVE,
    status: OutboundMessageStatus.SENT, correlationKey: preparation.approvalPromptCorrelationKey,
    payload: { kind: "APPROVAL_PROMPT_V1", draftPreparationId: preparation.id, storyId: story.id, storyVersion: story.version, wordpressAppliedVersion: state.applied_version },
  } });
  await prisma.draftPreparation.update({ where: { id: preparation.id }, data: { approvalPromptOutboundMessageId: prompt.id } });
  return { reporter, story, conversation, preparation, prompt, state };
}

async function inbound(fixture: Fixture, text: string, interactive = false, expectedSequence = 1n, timestamp = "1000000000") {
  const id = `${marker}:approve:${randomUUID()}`;
  const message = {
    id, from: fixture.reporter.phoneNumber.slice(1), timestamp,
    ...(interactive
      ? { type: "interactive", interactive: { type: "button_reply", button_reply: { id: text, title: "Approve" } } }
      : { type: "text", text: { body: text } }),
  };
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "123456789" }, messages: [message] } }] }] });
  const signature = `sha256=${createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(Buffer.from(raw)).digest("hex")}`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await request(app.getHttpServer()).post("/webhooks/whatsapp").set("Content-Type", "application/json").set("X-Hub-Signature-256", signature).send(raw).expect(200, { received: true });
  const event = await prisma.inboundEvent.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: Provider.WHATSAPP, providerMessageId: id } } });
  expect(event).toMatchObject({ processingStatus: InboundProcessingStatus.RECEIVED, senderPhone: fixture.reporter.phoneNumber, senderIngestSequence: expectedSequence });
  return event;
}

describe("Round 7 combined authenticated approval to WordPress publication", () => {
  beforeAll(async () => {
    const host = `http://127.0.0.1:${port}`;
    jest.spyOn(SecureWordPressTransport.prototype, "send").mockImplementation(async (input) => {
      const route = new URL(input.url).pathname;
      calls.push(`${input.method}:${route}`);
      if (failPublicationPost && input.method === "POST" && route === "/wp-json/newsroom/v1/publications") throw new Error("Injected disposable transport uncertainty");
      const response = await fetch(`${host}${route}`, { method: input.method, headers: input.headers, body: input.body?.toString(), redirect: "manual", signal: AbortSignal.timeout(input.timeoutMs) });
      const body = await response.text();
      return { status: response.status, body: body ? JSON.parse(body) as unknown : null };
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    processor = app.get(InboundEventProcessingService);
    drafts = app.get(WordPressDraftClient);
    publications = app.get(WordPressPublicationClient);
  });
  afterAll(async () => { await app?.close(); jest.restoreAllMocks(); });
  beforeEach(() => { calls.length = 0; failPublicationPost = false; });

  it("authenticates /approve, creates durable authority, publishes once, and finalises the same attempt", async () => {
    const x = await handoff("success");
    const event = await inbound(x, "/approve");
    expect(await prisma.approval.count({ where: { storyId: x.story.id } })).toBe(0);
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } })).toBe(0);
    expect(await processor.process(event.id)).toMatchObject({ outcome: "PROCESSED" });
    const approval = await prisma.approval.findUniqueOrThrow({ where: { storyId: x.story.id } });
    const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } });
    expect(approval).toMatchObject({ reporterId: x.reporter.id, inboundEventId: event.id, draftPreparationId: x.preparation.id, storyVersion: x.story.version, wordpressAppliedVersion: x.state.applied_version });
    expect(attempt).toMatchObject({ approvalId: approval.id, attemptNumber: 1, idempotencyKey: `draft-publish:${x.preparation.id}:${x.story.version}`, status: PublishAttemptStatus.SUCCEEDED });
    expect(await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).toMatchObject({ status: StoryStatus.PUBLISHED, version: x.story.version, wordpressPostId: BigInt(x.state.post_id) });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: x.conversation.id } })).toMatchObject({ state: ConversationState.IDLE, currentStoryId: null });
    expect(await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ processingStatus: InboundProcessingStatus.PROCESSED });
    expect(await prisma.draftPreparation.findUniqueOrThrow({ where: { id: x.preparation.id } })).toMatchObject({ status: DraftPreparationStatus.READY_FOR_APPROVAL });
    expect(calls).toContain(`GET:/wp-json/newsroom/v1/drafts/${x.story.wordpressDraftKey}/state`);
    expect(calls).toContain(`GET:/wp-json/newsroom/v1/publications/${attempt.id}`);
    expect(calls).toContain("POST:/wp-json/newsroom/v1/publications");
    expect(calls.indexOf(`GET:/wp-json/newsroom/v1/publications/${attempt.id}`)).toBeLessThan(calls.indexOf("POST:/wp-json/newsroom/v1/publications"));
    expect(await prisma.auditLog.count({ where: { storyId: x.story.id, eventType: "story_approval_bound" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { storyId: x.story.id, eventType: "story_publish_started" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { storyId: x.story.id, eventType: "story_publish_succeeded" } })).toBe(1);
    expect(await publications.get(attempt.id)).toMatchObject({ outcome: "PUBLISHED", publishKey: attempt.id, draftKey: x.story.wordpressDraftKey, postId: x.state.post_id, expectedAppliedVersion: x.state.applied_version });
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_publications WHERE publish_key='${attempt.id}' AND status='PUBLISHED'`)).toBe("1");
    expect(wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`)).toBe("publish");
    const second = await inbound(x, "/approve", false, 2n);
    expect(await processor.process(second.id)).toMatchObject({ outcome: "IGNORED" });
    expect(await prisma.approval.count({ where: { storyId: x.story.id } })).toBe(1);
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } })).toBe(1);
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_publications WHERE draft_key='${x.story.wordpressDraftKey}'`)).toBe("1");
  });

  it("rejects real WordPress Phase-0 drift before creating Approval", async () => {
    const x = await handoff("drift");
    await drafts.syncDraft({ wordpressDraftKey: x.story.wordpressDraftKey, headline: "Unapproved drift", body: x.story.body!, wordpressCategoryIds: [categoryId], editorialByline: x.story.byline!, featuredMediaKey: null, expectedVersion: x.state.applied_version });
    const event = await inbound(x, "/approve");
    expect(await processor.process(event.id)).toMatchObject({ outcome: "RETRY_REQUIRED", reason: "WORDPRESS_STATE_MISMATCH" });
    expect(await prisma.approval.count({ where: { storyId: x.story.id } })).toBe(0);
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } })).toBe(0);
    expect(wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`)).toBe("draft");
    expect(wpRead(`SELECT COUNT(*) FROM wp_newsroom_publications WHERE draft_key='${x.story.wordpressDraftKey}'`)).toBe("0");
  });

  it("preserves non-automatic reconciliation after a real-client publication transport uncertainty", async () => {
    const x = await handoff("uncertain");
    const event = await inbound(x, "/approve");
    failPublicationPost = true;
    expect(await processor.process(event.id)).toMatchObject({ outcome: "PUBLISH_RECONCILIATION_REQUIRED" });
    const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } });
    expect(attempt.status).toBe(PublishAttemptStatus.RECONCILIATION_REQUIRED);
    expect(await processor.process(event.id)).toMatchObject({ outcome: "NOT_CLAIMED" });
    expect(await prisma.publishAttempt.count({ where: { storyId: x.story.id, operation: PublishOperation.PUBLISH } })).toBe(1);
    expect(wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`)).toBe("draft");
  });

  it("routes an authenticated bound interactive control through the same approval/publication path", async () => {
    const x = await handoff("interactive");
    const event = await inbound(x, `newsroom:v1:story:approve:${x.prompt.id}`, true);
    expect(await processor.process(event.id)).toMatchObject({ outcome: "PROCESSED" });
    expect(await prisma.approval.findUniqueOrThrow({ where: { storyId: x.story.id } })).toMatchObject({ inboundEventId: event.id });
    expect(wpRead(`SELECT post_status FROM wp_posts WHERE ID=${x.state.post_id}`)).toBe("publish");
  });

  it("uses stored receivedAt before/equal cutover, never provider time, and never replays an ignored event", async () => {
    const cutover = new Date("2026-01-01T00:00:00.000Z");
    const before = await handoff("before-cutover");
    const oldEvent = await inbound(before, "/approve", false, 1n, "4070908800");
    await prisma.inboundEvent.update({ where: { id: oldEvent.id }, data: {
      receivedAt: new Date(cutover.getTime() - 1),
    } });
    expect(await processor.process(oldEvent.id)).toMatchObject({ outcome: "IGNORED", reason: "CONTROL_NOT_ENABLED" });
    expect(await prisma.approval.count({ where: { storyId: before.story.id } })).toBe(0);
    expect(await processor.process(oldEvent.id)).toMatchObject({ outcome: "NOT_CLAIMED" });

    const equal = await handoff("equal-cutover");
    const equalEvent = await inbound(equal, "/approve");
    await prisma.inboundEvent.update({ where: { id: equalEvent.id }, data: { receivedAt: cutover } });
    expect(await processor.process(equalEvent.id)).toMatchObject({ outcome: "PROCESSED" });
    expect(await prisma.approval.count({ where: { storyId: equal.story.id } })).toBe(1);
    expect(wpRead(`SELECT post_status FROM wp_posts WHERE ID=${equal.state.post_id}`)).toBe("publish");
  });

  it("allows approved-epoch publication after preview expiry but refuses a new token after publication", async () => {
    const x = await handoff("expired-preview");
    const expiredAt = new Date(Math.max(x.preparation.startedAt.getTime() + 1, Date.now() - 1));
    await prisma.draftPreparation.update({ where: { id: x.preparation.id }, data: { previewExpiresAt: expiredAt } });
    const event = await inbound(x, "/approve");
    expect(await processor.process(event.id)).toMatchObject({ outcome: "PROCESSED" });
    expect(await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } })).toMatchObject({ status: StoryStatus.PUBLISHED, version: x.story.version });
    await expect(app.get(PreviewTokenService).issue(x.preparation.id)).rejects.toThrow();
  });
});
