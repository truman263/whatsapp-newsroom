/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-argument */
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ConfigService } from "@nestjs/config";
import { ConversationState, DraftPreparationStatus, InboundEventType, InboundProcessingStatus, MediaProcessingStatus, OutboundMessageStatus, Provider, PublishAttemptStatus, PublishOperation, ReporterStatus, StoryMediaType, StoryStatus } from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { ApprovalPromptService } from "../src/modules/whatsapp-outbound/approval-prompt.service";
import { WhatsappOutboundDispatcher } from "../src/modules/whatsapp-outbound/whatsapp-outbound.dispatcher";
import { WorkerMetricsService } from "../src/worker/worker-metrics.service";
import { WorkerOrchestratorService, WORKER_LOOPS } from "../src/worker/worker-orchestrator.service";
import { AppModule } from "../src/app.module";
import { WorkerModule } from "../src/worker/worker.module";
import { HealthController } from "../src/modules/health/health.controller";
import { MediaRecoveryService } from "../src/modules/media-staging/media-recovery.service";
import { BacklogMetricsService } from "../src/worker/backlog-metrics.service";
import { WorkerOperationalController } from "../src/worker/worker-operational.controller";
import { InboundEventDriverService } from "../src/modules/reporter-workflow/inbound-event-driver.service";
import { PublishAttemptDriverService } from "../src/modules/publishing/publish-attempt-driver.service";
import { Round7PublishSagaService } from "../src/modules/publishing/round7-publish-saga.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { InboundEventRecoveryService } from "../src/modules/reporter-workflow/inbound-event-recovery.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import type { PublicationIntent, WordPressPublicationClient } from "../src/modules/wordpress-publication/wordpress-publication.client";
import { draftStateFingerprint } from "../src/modules/wordpress-draft/wordpress-draft-state";

const prisma = new PrismaService();
const replicaPrisma = new PrismaService();
let seedPostId = 1000n;
const config = new ConfigService({ preview: { publicOrigin: "https://newsroom.test" }, worker: { batchSize: 10, cadencesMs: Object.fromEntries(WORKER_LOOPS.map((loop) => [loop, 100])), staleInboundMs: 1000, staleOutboundMs: 1000, inboundMaxAttempts: 5, backoffMaxMs: 1000, jitterPercent: 0, shutdownGraceMs: 1000, readinessSilenceMs: 60000 } });

async function seed() {
  const wordpressPostId = seedPostId++;
  const reporter = await prisma.reporter.create({ data: { phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`, displayName: "worker proof", status: ReporterStatus.ACTIVE } });
  const story = await prisma.story.create({ data: { reporterId: reporter.id, status: StoryStatus.AWAITING_APPROVAL, headline: "h", body: "b", byline: "y", version: 2, wordpressPostId } });
  const category = await prisma.editorialCategory.create({ data: { wordpressCategoryId: seedPostId++, name: "worker", slug: `worker-${randomUUID()}` } });
  await prisma.storyCategory.create({ data: { storyId: story.id, categoryId: category.id } });
  await prisma.conversation.create({ data: { reporterId: reporter.id, state: ConversationState.AWAITING_APPROVAL, currentStoryId: story.id } });
  const event = await prisma.inboundEvent.create({ data: { provider: Provider.WHATSAPP, providerMessageId: randomUUID(), reporterId: reporter.id, senderPhone: reporter.phoneNumber, senderIngestSequence: 1n, eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.PROCESSED, rawPayload: {} } });
  const wordpressAppliedVersion = draftStateFingerprint({ title: "h", content: "b", excerpt: "", categories: [Number(category.wordpressCategoryId)], editorial_byline: "y", featured_media_key: null });
  const preparation = await prisma.draftPreparation.create({ data: { storyId: story.id, inboundEventId: event.id, storyVersion: story.version, status: DraftPreparationStatus.READY_FOR_APPROVAL, wordpressPostId, wordpressAppliedVersion, approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`, previewExpiresAt: new Date(Date.now() + 60000) } });
  const message = await prisma.$transaction((tx) => new ApprovalPromptService().queueApprovalPromptInTransaction(tx, { preparationId: preparation.id, storyId: story.id, storyVersion: story.version, wordpressAppliedVersion }));
  return { message, preparation, wordpressAppliedVersion, wordpressPostId };
}

function workerContext(
  database: PrismaService,
  overrides: {
    inbound?: unknown;
    outbound?: unknown;
    publish?: unknown;
  } = {},
): WorkerOrchestratorService {
  return new WorkerOrchestratorService(
    (overrides.inbound ?? { processReceived: jest.fn().mockResolvedValue([]), recoverStaleProcessing: jest.fn().mockResolvedValue([]) }) as never,
    { recoverPending: jest.fn().mockResolvedValue([]) } as never,
    { recover: jest.fn().mockResolvedValue([]) } as never,
    (overrides.outbound ?? { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) }) as never,
    (overrides.publish ?? { runOnce: jest.fn().mockResolvedValue([]) }) as never,
    database,
    new WorkerMetricsService(),
    config as never,
  );
}

function productionInbound(database: PrismaService): {
  processing: InboundEventProcessingService;
  driver: InboundEventDriverService;
} {
  const processing = new InboundEventProcessingService(
    database,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
    new StoredWhatsappEventParser(),
    new StoryEventProcessor(new ConversationStateMachineService(database)),
  );
  return {
    processing,
    driver: new InboundEventDriverService(
      database,
      processing,
      new InboundEventRecoveryService(database, processing),
    ),
  };
}

function receivedEvent(senderPhone: string, sequence: bigint) {
  const providerMessageId = randomUUID();
  return prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      senderPhone,
      senderIngestSequence: sequence,
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.RECEIVED,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: senderPhone.slice(1),
          timestamp: "1760000000",
          type: "text",
          text: { body: "not a command" },
        },
      },
    },
  });
}

describe("Round 8B.4 worker topology", () => {
  beforeAll(async () => Promise.all([prisma.$connect(), replicaPrisma.$connect()]));
  beforeEach(async () => prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'), 30000);
  afterAll(async () => Promise.all([prisma.$disconnect(), replicaPrisma.$disconnect()]));

  if (process.env.ROUND8B5A_CONTENTION_PROOF === "1") {
  it("recreates a worker context after an active cycle and recovers durable inbound work", async () => {
    const pending = await receivedEvent("+263771199991", 1n);
    const claimed = await receivedEvent("+263771199992", 1n);
    await prisma.inboundEvent.update({ where: { id: claimed.id }, data: {
      processingStatus: InboundProcessingStatus.PROCESSING,
      processingAttempts: 1, processingContractVersion: 1,
      processingStartedAt: new Date(Date.now() - 60000),
    } });
    const first = await NestFactory.create(WorkerModule, { logger: false });
    await first.init();
    let entered!: () => void;
    let release!: () => void;
    const cycleEntered = new Promise<void>((resolve) => { entered = resolve; });
    const heldCycle = new Promise<void>((resolve) => { release = resolve; });
    const firstDriver = first.get(InboundEventDriverService);
    jest.spyOn(firstDriver, "processReceived").mockImplementationOnce(async () => {
      entered();
      await heldCycle;
      return [];
    });
    const firstScheduler = first.get(WorkerOrchestratorService);
    firstScheduler.start();
    await cycleEntered;
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: pending.id } })).processingStatus)
      .toBe(InboundProcessingStatus.RECEIVED);
    const closing = first.close();
    release();
    await closing;
    const second = await NestFactory.create(WorkerModule, { logger: false });
    try {
      await second.init();
      const secondScheduler = second.get(WorkerOrchestratorService);
      secondScheduler.start();
      await second.get(InboundEventDriverService).recoverStaleProcessing({
        limit: 1, staleBefore: new Date(Date.now() - 1000), maxAttempts: 2,
      });
      let settled = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const row = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: pending.id } });
        if (row.processingStatus === InboundProcessingStatus.IGNORED) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(settled).toBe(true);
      expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: pending.id } })).processingAttempts)
        .toBe(1);
      expect(second.get(WorkerMetricsService).lastCycle("inbound")).toBeGreaterThan(0);
      const recovered = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: claimed.id } });
      expect(recovered.processingAttempts).toBe(2);
      expect(recovered.processingStatus).toBe(InboundProcessingStatus.IGNORED);
    } finally {
      await second.close();
    }
  }, 30000);

  it("schedules four complete worker replicas across all seven production loops", async () => {
    const first = await receivedEvent("+263771100001", 1n);
    const second = await receivedEvent("+263771100002", 1n);
    const stale = await receivedEvent("+263771100003", 1n);
    await prisma.inboundEvent.update({
      where: { id: stale.id },
      data: {
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(Date.now() - 60000),
      },
    });
    const { message } = await seed();
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: OutboundMessageStatus.SENDING, sendAttempts: 1 },
    });
    await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt"=${new Date(Date.now() - 60000)} WHERE "id"=${message.id}::uuid`;
    const settings = Object.fromEntries(
      [
        "WORKER_INBOUND_CADENCE_MS", "WORKER_STALE_INBOUND_CADENCE_MS",
        "WORKER_MEDIA_CADENCE_MS", "WORKER_DRAFT_CADENCE_MS",
        "WORKER_OUTBOUND_CADENCE_MS", "WORKER_STALE_OUTBOUND_CADENCE_MS",
        "WORKER_PUBLISH_CADENCE_MS",
      ].map((key) => [key, process.env[key]]),
    );
    for (const key of Object.keys(settings)) process.env[key] = "100";
    const staleInboundSetting = process.env.WORKER_STALE_INBOUND_MS;
    const staleOutboundSetting = process.env.WORKER_STALE_OUTBOUND_MS;
    process.env.WORKER_STALE_INBOUND_MS = "1000";
    process.env.WORKER_STALE_OUTBOUND_MS = "1000";
    const apps: Array<Awaited<ReturnType<typeof NestFactory.create>>> = [];
    try {
      for (let index = 0; index < 4; index++) {
        const app = await NestFactory.create(WorkerModule, { logger: false });
        await app.init();
        apps.push(app);
      }
      const injected = apps[0]!.get(InboundEventDriverService);
      const original = injected.processReceived.bind(injected);
      jest.spyOn(injected, "processReceived")
        .mockRejectedValueOnce(new Error("controlled-loop-failure"))
        .mockImplementation(original);
      for (const app of apps) app.get(WorkerOrchestratorService).start();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (const app of apps) {
        const metrics = app.get(WorkerMetricsService);
        for (const loop of WORKER_LOOPS)
          expect(metrics.lastCycle(loop)).toBeGreaterThan(0);
        const exposition = metrics.render();
        for (const loop of WORKER_LOOPS) {
          const match = exposition.match(new RegExp(`newsroom_worker_loop_runs_total\\{loop="${loop}"\\} (\\d+)`));
          expect(Number(match?.[1])).toBeGreaterThanOrEqual(1);
          expect(Number(match?.[1])).toBeLessThan(100);
        }
        console.info(JSON.stringify({ proof: "round8b5a_scheduled_replica", loops: 7, metrics: exposition }));
      }
      expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: first.id } })).processingStatus)
        .toBe(InboundProcessingStatus.IGNORED);
      expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: second.id } })).processingStatus)
        .toBe(InboundProcessingStatus.IGNORED);
      expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: stale.id } })).processingAttempts)
        .toBe(2);
      expect(await prisma.auditLog.count({ where: { entityId: message.id, eventType: "approval_prompt_send_uncertain" } }))
        .toBe(1);
      expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } })).status)
        .toBe(OutboundMessageStatus.SENDING);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (staleInboundSetting === undefined) delete process.env.WORKER_STALE_INBOUND_MS;
      else process.env.WORKER_STALE_INBOUND_MS = staleInboundSetting;
      if (staleOutboundSetting === undefined) delete process.env.WORKER_STALE_OUTBOUND_MS;
      else process.env.WORKER_STALE_OUTBOUND_MS = staleOutboundSetting;
    }
  }, 30000);
  }

  it("boots a real worker HTTP application with operational routes only", async () => {
    const apiImports = Reflect.getMetadata("imports", AppModule) as unknown[];
    expect(apiImports).not.toContain(WorkerModule);
    const app = await NestFactory.create(WorkerModule, { logger: false });
    await app.init();
    await request(app.getHttpServer()).get("/health/live").expect(200).expect({ status: "ok", service: "newsroom-worker" });
    await request(app.getHttpServer()).get("/health/ready").expect(503).expect(({ body }) => {
      expect(body).toEqual({ status: "not_ready", service: "newsroom-worker", reason: "scheduler_or_database" });
    });
    await request(app.getHttpServer()).get("/metrics").expect(200).expect("Content-Type", /text\/plain/);
    await request(app.getHttpServer()).get("/preview").expect(404);
    await request(app.getHttpServer()).get("/webhooks/whatsapp").expect(404);
    await request(app.getHttpServer()).get("/health").expect(404);
    await app.close();
  });

  it("two independent replicas converge one PENDING dispatch through PostgreSQL", async () => {
    const { message } = await seed();
    const client = { sendApprovalPrompt: jest.fn().mockResolvedValue("wamid.worker") };
    const first = new WhatsappOutboundDispatcher(prisma, { issue: jest.fn().mockResolvedValue("capability") } as never, client as never, config as never);
    const second = new WhatsappOutboundDispatcher(replicaPrisma, { issue: jest.fn().mockResolvedValue("capability") } as never, client as never, config as never);
    await Promise.all([
      workerContext(prisma, { outbound: first }).runOnce("outbound"),
      workerContext(replicaPrisma, { outbound: second }).runOnce("outbound"),
    ]);
    expect(client.sendApprovalPrompt).toHaveBeenCalledTimes(1);
    expect(await prisma.outboundMessage.count()).toBe(1);
    expect(await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: OutboundMessageStatus.SENT, sendAttempts: 1 });
  });

  it("two replicas surface one stale SENDING hold with zero Meta calls", async () => {
    const { message } = await seed();
    await prisma.outboundMessage.update({ where: { id: message.id }, data: { status: OutboundMessageStatus.SENDING, sendAttempts: 1 } });
    const stale = new Date(Date.now() - 60000);
    await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt"=${stale} WHERE "id"=${message.id}::uuid`;
    const client = { sendApprovalPrompt: jest.fn() };
    const first = new WhatsappOutboundDispatcher(prisma, {} as never, client as never, config as never);
    const second = new WhatsappOutboundDispatcher(replicaPrisma, {} as never, client as never, config as never);
    await Promise.all([
      workerContext(prisma, { outbound: first }).runOnce("staleOutbound"),
      workerContext(replicaPrisma, { outbound: second }).runOnce("staleOutbound"),
    ]);
    expect(client.sendApprovalPrompt).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { entityId: message.id, eventType: "approval_prompt_send_uncertain" } })).toBe(1);
  });

  it("two worker contexts use production ordinary inbound claim authority", async () => {
    const firstSender = `+263${Math.floor(100000000 + Math.random() * 899999999)}`;
    const secondSender = `+265${Math.floor(100000000 + Math.random() * 899999999)}`;
    const earlier = await receivedEvent(firstSender, 1n);
    const later = await receivedEvent(firstSender, 2n);
    const independent = await receivedEvent(secondSender, 1n);
    const first = productionInbound(prisma);
    const second = productionInbound(replicaPrisma);
    await Promise.all([
      workerContext(prisma, { inbound: first.driver }).runOnce("inbound"),
      workerContext(replicaPrisma, { inbound: second.driver }).runOnce("inbound"),
    ]);
    const firstState = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: earlier.id } });
    const independentState = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: independent.id } });
    expect(firstState).toMatchObject({ processingStatus: InboundProcessingStatus.IGNORED, processingAttempts: 1, processingContractVersion: 1 });
    expect(independentState).toMatchObject({ processingStatus: InboundProcessingStatus.IGNORED, processingAttempts: 1, processingContractVersion: 1 });
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: later.id } })).processingStatus).toBe(InboundProcessingStatus.RECEIVED);
    await Promise.all([
      workerContext(prisma, { inbound: first.driver }).runOnce("inbound"),
      workerContext(replicaPrisma, { inbound: second.driver }).runOnce("inbound"),
    ]);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: later.id } })).processingAttempts).toBe(1);
    const attemptsBeforeReplay = firstState.processingAttempts;
    await Promise.all([first.driver.processReceived(10), second.driver.processReceived(10)]);
    expect((await prisma.inboundEvent.findUniqueOrThrow({ where: { id: earlier.id } })).processingAttempts).toBe(attemptsBeforeReplay);
  });

  it("two worker contexts use production stale-inbound recovery authority", async () => {
    const sender = `+266${Math.floor(100000000 + Math.random() * 899999999)}`;
    const blocker = await receivedEvent(sender, 1n);
    const stale = await receivedEvent(sender, 2n);
    const first = productionInbound(prisma);
    const second = productionInbound(replicaPrisma);
    const claimed = await first.processing.claim(stale.id);
    expect(claimed).toMatchObject({ outcome: "ORDER_BLOCKED" });
    await first.processing.process(blocker.id);
    const active = await first.processing.claim(stale.id);
    if (active.outcome !== "CLAIMED") throw new Error("production claim failed");
    await prisma.inboundEvent.update({ where: { id: stale.id }, data: { processingStartedAt: new Date(Date.now() - 60000) } });
    await Promise.all([
      workerContext(prisma, { inbound: first.driver }).runOnce("staleInbound"),
      workerContext(replicaPrisma, { inbound: second.driver }).runOnce("staleInbound"),
    ]);
    const reclaimed = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: stale.id } });
    expect(reclaimed.processingStatus).not.toBe(InboundProcessingStatus.RECEIVED);
    expect(reclaimed).toMatchObject({ processingAttempts: 2, processingContractVersion: 1 });
    expect(await prisma.auditLog.count({ where: { inboundEventId: stale.id, eventType: "inbound_recovery_claimed" } })).toBe(1);
    await expect(first.processing.processClaimed({ eventId: stale.id, processingAttempt: active.processingAttempt, processingContractVersion: active.processingContractVersion })).rejects.toMatchObject({ code: "INBOUND_PROCESSING_FENCE_LOST" });
    await expect(second.driver.recoverStaleProcessing({ limit: 10, staleBefore: new Date(), maxAttempts: 5 })).resolves.toEqual([]);
  });

  it("two worker contexts converge one publish authority and exclude reconciliation", async () => {
    const firstSeed = await seed();
    const secondSeed = await seed();
    const approvalFor = async (storyId: string) => {
      const story = await prisma.story.findUniqueOrThrow({ where: { id: storyId } });
      const preparation = await prisma.draftPreparation.findFirstOrThrow({ where: { storyId } });
      return prisma.approval.create({ data: { storyId, reporterId: story.reporterId, inboundEventId: preparation.inboundEventId, draftPreparationId: preparation.id, storyVersion: preparation.storyVersion, wordpressAppliedVersion: preparation.wordpressAppliedVersion! } });
    };
    const pendingApproval = await approvalFor(firstSeed.message.storyId!);
    const heldApproval = await approvalFor(secondSeed.message.storyId!);
    await prisma.story.update({ where: { id: firstSeed.message.storyId! }, data: { status: StoryStatus.APPROVED, approvedAt: new Date() } });
    await prisma.story.update({ where: { id: secondSeed.message.storyId! }, data: { status: StoryStatus.APPROVED, approvedAt: new Date() } });
    await prisma.inboundEvent.update({ where: { id: pendingApproval.inboundEventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, processingAttempts: 1, processingContractVersion: 1, processingStartedAt: new Date(), processedAt: null } });
    await prisma.inboundEvent.update({ where: { id: heldApproval.inboundEventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, processingAttempts: 1, processingContractVersion: 1, processingStartedAt: new Date(), processedAt: null } });
    const pending = await prisma.publishAttempt.create({ data: { storyId: firstSeed.message.storyId!, approvalId: pendingApproval.id, operation: PublishOperation.PUBLISH, status: PublishAttemptStatus.PENDING, attemptNumber: 1, idempotencyKey: `draft-publish:${firstSeed.preparation.id}:2`, wordpressPostId: firstSeed.wordpressPostId } });
    const held = await prisma.publishAttempt.create({ data: { storyId: secondSeed.message.storyId!, approvalId: heldApproval.id, operation: PublishOperation.PUBLISH, status: PublishAttemptStatus.RECONCILIATION_REQUIRED, attemptNumber: 1, idempotencyKey: `draft-publish:${secondSeed.preparation.id}:2`, wordpressPostId: secondSeed.wordpressPostId, startedAt: new Date(), errorCode: "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED" } });
    let externalPublications = 0;
    const wordpress = {
      get: jest.fn().mockResolvedValue({ outcome: "NOT_FOUND" }),
      publish: jest.fn().mockImplementation((intent: PublicationIntent) => {
        externalPublications++;
        return Promise.resolve({ outcome: "PUBLISHED", publishKey: intent.publishKey, postId: intent.postId, status: "publish", appliedVersionBefore: intent.expectedAppliedVersion, publishedAt: "2026-09-27 10:00:00" });
      }),
    } as unknown as WordPressPublicationClient;
    const firstSaga = new Round7PublishSagaService(prisma, wordpress, new ConversationStateMachineService(prisma));
    const secondSaga = new Round7PublishSagaService(replicaPrisma, wordpress, new ConversationStateMachineService(replicaPrisma));
    const first = new PublishAttemptDriverService(prisma, firstSaga);
    const second = new PublishAttemptDriverService(replicaPrisma, secondSaga);
    await Promise.all([
      workerContext(prisma, { publish: first }).runOnce("publish"),
      workerContext(replicaPrisma, { publish: second }).runOnce("publish"),
    ]);
    expect(externalPublications).toBe(1);
    expect((await prisma.publishAttempt.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(PublishAttemptStatus.SUCCEEDED);
    expect((await prisma.publishAttempt.findUniqueOrThrow({ where: { id: held.id } })).status).toBe(PublishAttemptStatus.RECONCILIATION_REQUIRED);
    expect(await prisma.publishAttempt.count({ where: { storyId: firstSeed.message.storyId!, operation: PublishOperation.PUBLISH } })).toBe(1);
  });

  it("isolates a failing loop and keeps scheduler metrics responsive", async () => {
    const inbound = { processReceived: jest.fn().mockRejectedValue(new Error("dependency")), recoverStaleProcessing: jest.fn().mockResolvedValue([]) };
    const service = new WorkerOrchestratorService(inbound as never, { recoverPending: jest.fn().mockResolvedValue([]) } as never, { recover: jest.fn().mockResolvedValue([]) } as never, { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) } as never, { runOnce: jest.fn().mockResolvedValue([]) } as never, prisma, new WorkerMetricsService(), config as never);
    await expect(service.runOnce("inbound")).rejects.toThrow("dependency");
    await expect(service.runOnce("staleOutbound")).resolves.toBe(0);
    expect(service.isLive()).toBe(true);
  });

  it("media scan requires exactly one coherent lineage and isolates poison rows", async () => {
    const { message } = await seed();
    const story = await prisma.story.findUniqueOrThrow({ where: { id: message.storyId! } });
    const event = await prisma.inboundEvent.findFirstOrThrow({ where: { reporterId: story.reporterId } });
    await prisma.inboundEvent.update({ where: { id: event.id }, data: { processingStatus: InboundProcessingStatus.PROCESSING, processingAttempts: 1, processingContractVersion: 1, processingStartedAt: new Date() } });
    const otherReporter = await prisma.reporter.create({ data: { phoneNumber: `+264${Math.floor(100000000 + Math.random() * 899999999)}`, displayName: "other", status: ReporterStatus.ACTIVE } });
    const otherStory = await prisma.story.create({ data: { reporterId: otherReporter.id, status: StoryStatus.COLLECTING } });
    const createMedia = (position: number, status: MediaProcessingStatus = MediaProcessingStatus.FETCHING) => prisma.storyMedia.create({ data: { storyId: story.id, providerMediaId: randomUUID(), mediaType: StoryMediaType.IMAGE, status, position } });
    const audit = (mediaId: string, overrides: Record<string, unknown> = {}) => prisma.auditLog.create({ data: { eventType: "story_media_associated", actorType: "SYSTEM", reporterId: story.reporterId, storyId: story.id, inboundEventId: event.id, entityType: "StoryMedia", entityId: mediaId, ...overrides } });
    const zeroAudit = await createMedia(0);
    const duplicate = await createMedia(1);
    await audit(duplicate.id);
    await audit(duplicate.id);
    const contradictory = await createMedia(2);
    await audit(contradictory.id);
    await audit(contradictory.id, { storyId: otherStory.id, reporterId: otherReporter.id });
    const mismatch = await createMedia(3);
    await audit(mismatch.id, { reporterId: otherReporter.id });
    const wordpressOwned = await createMedia(4, MediaProcessingStatus.UPLOADING);
    await audit(wordpressOwned.id);
    const recoverable = await createMedia(5);
    await audit(recoverable.id);
    const staging = { reconcile: jest.fn().mockResolvedValue({ outcome: "PROCESSED" }) };
    const recovery = new MediaRecoveryService(staging as never, prisma);
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT "id" FROM "StoryMedia" WHERE "status" IN ('RECEIVED','FETCHING') ORDER BY "updatedAt", "id" LIMIT 20`,
    );
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
      /Limit[\s\S]*(Sort|Index Scan)[\s\S]*(StoryMedia|status)/,
    );
    console.info(
      "MEDIA_SELECTOR_EXPLAIN\n" +
        plan.map((row) => row["QUERY PLAN"]).join("\n"),
    );
    await expect(recovery.recoverPending(20)).resolves.toEqual([{ outcome: "PROCESSED" }]);
    expect(staging.reconcile).toHaveBeenCalledTimes(1);
    expect(staging.reconcile).toHaveBeenCalledWith(recoverable.id, { eventId: event.id, processingAttempt: 1, processingContractVersion: 1 });
    expect(staging.reconcile).not.toHaveBeenCalledWith(zeroAudit.id, expect.anything());
    expect(staging.reconcile).not.toHaveBeenCalledWith(duplicate.id, expect.anything());
    expect(staging.reconcile).not.toHaveBeenCalledWith(contradictory.id, expect.anything());
    expect(staging.reconcile).not.toHaveBeenCalledWith(mismatch.id, expect.anything());
    expect(staging.reconcile).not.toHaveBeenCalledWith(wordpressOwned.id, expect.anything());
  });

  it("provides API and worker health independently of Meta, WordPress and S3", async () => {
    const api = new HealthController(prisma);
    expect(api.live()).toEqual({ status: "ok", service: "newsroom-api" });
    await expect(api.ready()).resolves.toEqual({ status: "ok", service: "newsroom-api" });
    const metrics = new WorkerMetricsService();
    for (const loop of WORKER_LOOPS) metrics.record(loop, 1, 0);
    const orchestrator = { isReady: jest.fn().mockResolvedValue(true), isLive: jest.fn().mockReturnValue(true) };
    const controller = new WorkerOperationalController(orchestrator as never, metrics, new BacklogMetricsService(prisma));
    expect(controller.live()).toEqual({ status: "ok", service: "newsroom-worker" });
    await expect(controller.ready()).resolves.toEqual({ status: "ok", service: "newsroom-worker" });
    const exposition = await controller.metricsText();
    expect(exposition).toContain("newsroom_worker_backlog");
    expect(exposition).not.toMatch(/phone|headline|body|token|providerMessageId/);
  });

  it("worker readiness fails closed on database loss while liveness remains responsive", async () => {
    const metrics = new WorkerMetricsService();
    for (const loop of WORKER_LOOPS) metrics.record(loop, 1, 0);
    const service = new WorkerOrchestratorService({} as never, {} as never, {} as never, {} as never, {} as never, { $queryRaw: jest.fn().mockRejectedValue(new Error("db unavailable")) } as never, metrics, config as never);
    service.start();
    expect(service.isLive()).toBe(true);
    await expect(service.isReady()).resolves.toBe(false);
    service.stop();
  });
});
