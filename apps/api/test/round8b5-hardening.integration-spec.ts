/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { performance } from "node:perf_hooks";
import { createHmac, randomUUID } from "node:crypto";
import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  InboundEventType,
  InboundProcessingStatus,
  Provider,
  ReporterStatus,
  ConversationState,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { AppModule } from "../src/app.module";
import { HealthController } from "../src/modules/health/health.controller";
import { WhatsappWebhookIngestionService } from "../src/modules/whatsapp-webhook/whatsapp-webhook-ingestion.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { InboundEventRecoveryService } from "../src/modules/reporter-workflow/inbound-event-recovery.service";
import { InboundEventDriverService } from "../src/modules/reporter-workflow/inbound-event-driver.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import { WorkerMetricsService } from "../src/worker/worker-metrics.service";
import { BacklogMetricsService } from "../src/worker/backlog-metrics.service";
import {
  WORKER_LOOPS,
  WorkerOrchestratorService,
} from "../src/worker/worker-orchestrator.service";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(180_000);
const prisma = new PrismaService();

function event(
  senderPhone: string,
  providerMessageId: string = randomUUID(),
  body = "BODY_SENTINEL_R8B5",
) {
  return {
    providerMessageId,
    senderPhone,
    eventType: InboundEventType.TEXT,
    providerOccurredAt: new Date(1760000000 * 1000),
    rawPayload: {
      message: {
        id: providerMessageId,
        from: senderPhone.slice(1),
        timestamp: "1760000000",
        type: "text",
        text: { body },
      },
    },
  };
}

function productionDriver(database: PrismaService): InboundEventDriverService {
  const processing = new InboundEventProcessingService(
    database,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
    new StoredWhatsappEventParser(),
    new StoryEventProcessor(new ConversationStateMachineService(database)),
  );
  return new InboundEventDriverService(
    database,
    processing,
    new InboundEventRecoveryService(database, processing),
  );
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return (
    ordered[
      Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)
    ] ?? 0
  );
}

describe("Round 8B.5 security and load hardening", () => {
  beforeAll(() => prisma.$connect());
  beforeEach(() =>
    prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'),
  );
  afterAll(() => prisma.$disconnect());

  it("converges 100 authenticated-equivalent duplicate deliveries to one durable authority", async () => {
    const ingestion = new WhatsappWebhookIngestionService(prisma);
    const duplicate = event("+263771000001", "wamid-r8b5-duplicate");
    const logged: unknown[] = [];
    const logSpy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation((message: unknown) => {
        logged.push(message);
      });
    try {
      for (let replay = 0; replay < 100; replay++)
        await ingestion.persist({
          events: [duplicate],
          foreignPhoneChanges: 0,
          unsupportedChanges: 0,
        });
    } finally {
      logSpy.mockRestore();
    }
    expect(
      await prisma.inboundEvent.count({
        where: { providerMessageId: duplicate.providerMessageId },
      }),
    ).toBe(1);
    expect(await prisma.story.count()).toBe(0);
    expect(await prisma.storyMedia.count()).toBe(0);
    expect(await prisma.draftPreparation.count()).toBe(0);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(0);
    expect(await prisma.publishAttempt.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("BODY_SENTINEL_R8B5");
  });

  it("acknowledges 100 identical signed HTTP webhook deliveries with one durable event and one application log", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({
      rawBody: true,
    });
    await app.init();
    const providerMessageId = `wamid.r8b5.${randomUUID()}`;
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-local",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: providerMessageId,
                    from: "263771000002",
                    timestamp: "1760000000",
                    type: "text",
                    text: { body: "HTTP_BODY_SENTINEL_R8B5" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "round8b5-local-secret").update(Buffer.from(raw)).digest("hex")}`;
    const logs: unknown[] = [];
    const spy = jest
      .spyOn(Logger.prototype, "log")
      .mockImplementation((message: unknown) => {
        logs.push(message);
      });
    try {
      for (let replay = 0; replay < 100; replay++) {
        // Nest exposes the platform server dynamically; Supertest validates it at runtime.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const response = await request(app.getHttpServer())
          .post("/webhooks/whatsapp")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", signature)
          .send(raw)
          .expect(200);
        expect(response.body).toEqual({ received: true });
      }
    } finally {
      spy.mockRestore();
      await app.close();
    }
    expect(
      await prisma.inboundEvent.count({ where: { providerMessageId } }),
    ).toBe(1);
    expect(await prisma.story.count()).toBe(0);
    expect(await prisma.storyMedia.count()).toBe(0);
    expect(await prisma.draftPreparation.count()).toBe(0);
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(0);
    expect(await prisma.publishAttempt.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("HTTP_BODY_SENTINEL_R8B5");
  });

  it("bounds logs and responses for 100 invalid signatures and 100 signed malformed payloads", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      marker: "HOSTILE_PAYLOAD_SENTINEL_R8B5B",
      entry: [{ changes: [{ field: "messages", value: { messages: "invalid" } }] }],
    });
    const validSignature = `sha256=${createHmac("sha256", "round8b5-local-secret").update(Buffer.from(raw)).digest("hex")}`;
    const logs: unknown[] = [];
    const spies = ["log", "warn", "error"].map((level) =>
      jest.spyOn(Logger.prototype, level as "log").mockImplementation((...args: unknown[]) => {
        logs.push(args);
      }),
    );
    try {
      for (let index = 0; index < 100; index++) {
        // Nest exposes the platform server dynamically; Supertest checks it at runtime.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const invalid = await request(app.getHttpServer())
          .post("/webhooks/whatsapp")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", `sha256=${"0".repeat(64)}`)
          .send(raw)
          .expect(401);
        expect(JSON.stringify(invalid.body)).not.toContain("HOSTILE_PAYLOAD_SENTINEL_R8B5B");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const malformed = await request(app.getHttpServer())
          .post("/webhooks/whatsapp")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", validSignature)
          .send(raw)
          .expect(400);
        expect(JSON.stringify(malformed.body)).not.toContain("HOSTILE_PAYLOAD_SENTINEL_R8B5B");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await app.close();
    }
    expect(JSON.stringify(logs)).not.toContain("HOSTILE_PAYLOAD_SENTINEL_R8B5B");
    expect(logs).toHaveLength(0);
    expect(await prisma.inboundEvent.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("drains fifty independent senders through twenty production driver contexts", async () => {
    const ingestion = new WhatsappWebhookIngestionService(prisma);
    const inputs = Array.from({ length: 50 }, (_, index) =>
      event(`+263772${String(index).padStart(6, "0")}`),
    );
    await ingestion.persist({
      events: inputs,
      foreignPhoneChanges: 0,
      unsupportedChanges: 0,
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = new PrismaService();
        await client.$connect();
        return client;
      }),
    );
    const started = performance.now();
    const latencies: number[] = [];
    try {
      await Promise.all(
        clients.map(async (client) => {
          const cycle = performance.now();
          await productionDriver(client).processReceived(50);
          latencies.push(performance.now() - cycle);
        }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const duration = performance.now() - started;
    expect(
      await prisma.inboundEvent.count({
        where: { processingStatus: InboundProcessingStatus.IGNORED },
      }),
    ).toBe(50);
    expect(
      await prisma.inboundEvent.aggregate({
        _max: { processingAttempts: true },
      }),
    ).toMatchObject({ _max: { processingAttempts: 1 } });
    console.info(
      JSON.stringify({
        proof: "many_sender",
        senders: 50,
        workers: 20,
        durationMs: duration,
        throughputPerSecond: 50000 / duration,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99),
        duplicateEffects: 0,
      }),
    );
  });

  it("drains fifty authorised three-event story workflows through production processing", async () => {
    const senders = Array.from(
      { length: 50 },
      (_, index) => `+263775${String(index).padStart(6, "0")}`,
    );
    await prisma.reporter.createMany({
      data: senders.map((phoneNumber, index) => ({
        phoneNumber,
        displayName: `Reporter ${index}`,
        status: ReporterStatus.ACTIVE,
      })),
    });
    const ingestion = new WhatsappWebhookIngestionService(prisma);
    await ingestion.persist({
      events: senders.flatMap((phoneNumber, index) => [
        event(phoneNumber, `story-${index}-start`, "/story"),
        event(phoneNumber, `story-${index}-headline`, `Headline ${index}`),
        event(
          phoneNumber,
          `story-${index}-body`,
          `Body for story ${index} with enough content to pass validation.`,
        ),
      ]),
      foreignPhoneChanges: 0,
      unsupportedChanges: 0,
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = new PrismaService();
        await client.$connect();
        return client;
      }),
    );
    const drivers = clients.map(productionDriver);
    const started = performance.now();
    let peakBacklog = 150;
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        await Promise.all(drivers.map((driver) => driver.processReceived(100)));
        const remaining = await prisma.inboundEvent.count({
          where: { processingStatus: InboundProcessingStatus.RECEIVED },
        });
        peakBacklog = Math.max(peakBacklog, remaining);
        if (remaining === 0) break;
      }
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const durationMs = performance.now() - started;
    const events = await prisma.inboundEvent.findMany({
      select: {
        processingStatus: true,
        processingAttempts: true,
        senderPhone: true,
        senderIngestSequence: true,
      },
    });
    expect(events).toHaveLength(150);
    expect(
      events.every(
        (row) =>
          row.processingStatus === InboundProcessingStatus.PROCESSED &&
          row.processingAttempts === 1,
      ),
    ).toBe(true);
    const stories = await prisma.story.findMany({
      select: { reporterId: true, headline: true, body: true },
    });
    expect(stories).toHaveLength(50);
    expect(new Set(stories.map((story) => story.reporterId)).size).toBe(50);
    expect(stories.every((story) => story.headline && story.body)).toBe(true);
    expect(
      await prisma.conversation.count({
        where: { state: ConversationState.COLLECTING_MEDIA },
      }),
    ).toBe(50);
    console.info(
      JSON.stringify({
        proof: "authorised_many_sender",
        senders: 50,
        events: 150,
        workerContexts: 20,
        terminal: 150,
        stories: 50,
        duplicateStories: 0,
        peakBacklog,
        durationMs,
        throughputPerSecond: 150000 / durationMs,
      }),
    );
  });

  it("preserves a fifty-event gapped sender burst under twenty contenders", async () => {
    const sender = "+263773000001";
    await prisma.inboundEvent.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        provider: Provider.WHATSAPP,
        providerMessageId: `burst-${index}`,
        senderPhone: sender,
        senderIngestSequence: BigInt(index * 2),
        eventType: InboundEventType.TEXT,
        rawPayload: event(sender, `burst-${index}`).rawPayload,
      })),
    });
    const other = event("+263774000001", "independent-r8b5");
    await new WhatsappWebhookIngestionService(prisma).persist({
      events: [other],
      foreignPhoneChanges: 0,
      unsupportedChanges: 0,
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = new PrismaService();
        await client.$connect();
        return client;
      }),
    );
    const observedOrder: number[] = [];
    try {
      for (let cycle = 0; cycle < 55; cycle++) {
        await Promise.all(
          clients.map((client) =>
            productionDriver(client).processReceived(1),
          ),
        );
        const progress = await prisma.inboundEvent.findMany({
          where: { senderPhone: sender },
          orderBy: { senderIngestSequence: "asc" },
          select: { processingStatus: true },
        });
        const terminalCount = progress.filter(
          (row) => row.processingStatus === InboundProcessingStatus.IGNORED,
        ).length;
        expect(
          progress
            .slice(0, terminalCount)
            .every(
              (row) => row.processingStatus === InboundProcessingStatus.IGNORED,
            ),
        ).toBe(true);
        expect(
          progress
            .slice(terminalCount)
            .every(
              (row) =>
                row.processingStatus === InboundProcessingStatus.RECEIVED,
            ),
        ).toBe(true);
        if (terminalCount > observedOrder.length)
          for (let index = observedOrder.length; index < terminalCount; index++)
            observedOrder.push(index * 2);
      }
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const rows = await prisma.inboundEvent.findMany({
      where: { senderPhone: sender },
      orderBy: { senderIngestSequence: "asc" },
    });
    expect(rows).toHaveLength(50);
    expect(observedOrder).toEqual(
      Array.from({ length: 50 }, (_, index) => index * 2),
    );
    expect(
      rows.every(
        (row) =>
          row.processingStatus === InboundProcessingStatus.IGNORED &&
          row.processingAttempts === 1,
      ),
    ).toBe(true);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: {
            provider_providerMessageId: {
              provider: Provider.WHATSAPP,
              providerMessageId: other.providerMessageId,
            },
          },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
  });

  it("keeps the bounded candidate lookup equivalent across predecessor states and sequence gaps", async () => {
    const driver = productionDriver(prisma);
    const sender = "+263777000001";
    const insert = (
      phone: string,
      sequence: bigint,
      status: InboundProcessingStatus,
      receivedAt = new Date("2026-09-27T10:00:00.000Z"),
    ) =>
      prisma.inboundEvent.create({
        data: {
          provider: Provider.WHATSAPP,
          providerMessageId: randomUUID(),
          senderPhone: phone,
          senderIngestSequence: sequence,
          eventType: InboundEventType.TEXT,
          processingStatus: status,
          processingAttempts:
            status === InboundProcessingStatus.RECEIVED ? 0 : 1,
          ...(status === InboundProcessingStatus.PROCESSING
            ? { processingStartedAt: new Date(), processingContractVersion: 1 }
            : {}),
          ...(status === InboundProcessingStatus.PROCESSED ||
          status === InboundProcessingStatus.IGNORED ||
          status === InboundProcessingStatus.FAILED
            ? { processedAt: new Date() }
            : {}),
          receivedAt,
          rawPayload: event(phone).rawPayload,
        },
      });
    for (const predecessor of [
      InboundProcessingStatus.RECEIVED,
      InboundProcessingStatus.PROCESSING,
      InboundProcessingStatus.PROCESSED,
      InboundProcessingStatus.IGNORED,
      InboundProcessingStatus.FAILED,
    ]) {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "InboundEvent" CASCADE');
      const first = await insert(sender, 1n, predecessor);
      const later = await insert(
        sender,
        100n,
        InboundProcessingStatus.RECEIVED,
      );
      const result = await driver.processReceived(1);
      if (predecessor === InboundProcessingStatus.RECEIVED) {
        expect(result).toHaveLength(1);
        expect(
          (
            await prisma.inboundEvent.findUniqueOrThrow({
              where: { id: first.id },
            })
          ).processingStatus,
        ).toBe(InboundProcessingStatus.IGNORED);
        expect(
          (
            await prisma.inboundEvent.findUniqueOrThrow({
              where: { id: later.id },
            })
          ).processingStatus,
        ).toBe(InboundProcessingStatus.RECEIVED);
      } else if (predecessor === InboundProcessingStatus.PROCESSING) {
        expect(result).toHaveLength(0);
        expect(
          (
            await prisma.inboundEvent.findUniqueOrThrow({
              where: { id: later.id },
            })
          ).processingStatus,
        ).toBe(InboundProcessingStatus.RECEIVED);
      } else {
        expect(result).toHaveLength(1);
        expect(
          (
            await prisma.inboundEvent.findUniqueOrThrow({
              where: { id: later.id },
            })
          ).processingStatus,
        ).toBe(InboundProcessingStatus.IGNORED);
      }
    }
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "InboundEvent" CASCADE');
    await insert(sender, 1n, InboundProcessingStatus.PROCESSED);
    const blocker = await insert(
      sender,
      5n,
      InboundProcessingStatus.PROCESSING,
    );
    const last = await insert(sender, 100n, InboundProcessingStatus.RECEIVED);
    expect(await driver.processReceived(10)).toHaveLength(0);
    await prisma.inboundEvent.update({
      where: { id: blocker.id },
      data: {
        processingStatus: InboundProcessingStatus.FAILED,
        processedAt: new Date(),
      },
    });
    expect(await driver.processReceived(10)).toHaveLength(1);
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { id: last.id } }))
        .processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
  });

  it("does not let blocked senders fill a bounded batch ahead of eligible senders", async () => {
    const driver = productionDriver(prisma);
    const early = new Date("2026-09-27T08:00:00.000Z");
    await prisma.inboundEvent.createMany({
      data: Array.from({ length: 100 }, (_, index) => {
        const senderPhone = `+263779${String(index).padStart(6, "0")}`;
        return [0, 1].map((offset) => ({
          provider: Provider.WHATSAPP,
          providerMessageId: randomUUID(),
          senderPhone,
          senderIngestSequence: BigInt(offset),
          eventType: InboundEventType.TEXT,
          processingStatus:
            offset === 0
              ? InboundProcessingStatus.PROCESSING
              : InboundProcessingStatus.RECEIVED,
          processingAttempts: offset === 0 ? 1 : 0,
          processingContractVersion: offset === 0 ? 1 : null,
          processingStartedAt: offset === 0 ? new Date() : null,
          receivedAt: early,
          rawPayload: event(senderPhone).rawPayload,
        }));
      }).flat(),
    });
    const eligibleSender = "+263778000001";
    const eligible = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: eligibleSender,
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        receivedAt: new Date("2026-09-27T09:00:00.000Z"),
        rawPayload: event(eligibleSender).rawPayload,
      },
    });
    const independent = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: "+263778000002",
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        receivedAt: new Date("2026-09-27T10:00:00.000Z"),
        rawPayload: event("+263778000002").rawPayload,
      },
    });
    expect(await driver.processReceived(1)).toHaveLength(1);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: eligible.id },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: independent.id },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.RECEIVED);
    expect(await driver.processReceived(1)).toHaveLength(1);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: independent.id },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
    expect(
      await prisma.inboundEvent.count({
        where: { processingStatus: InboundProcessingStatus.RECEIVED },
      }),
    ).toBe(100);
  });

  it("isolates a held predecessor and terminal poison sender while healthy senders drain", async () => {
    const heldSender = "+263771000001";
    const poisonSender = "+263771000002";
    const healthySenders = Array.from(
      { length: 20 },
      (_, index) => `+263771${String(index + 3).padStart(6, "0")}`,
    );
    const held = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: heldSender,
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(),
        rawPayload: event(heldSender).rawPayload,
      },
    });
    const blocked = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: heldSender,
        senderIngestSequence: 5n,
        eventType: InboundEventType.TEXT,
        rawPayload: event(heldSender).rawPayload,
      },
    });
    await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: poisonSender,
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.FAILED,
        processingAttempts: 1,
        processedAt: new Date(),
        rawPayload: event(poisonSender).rawPayload,
      },
    });
    const afterPoison = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: poisonSender,
        senderIngestSequence: 100n,
        eventType: InboundEventType.TEXT,
        rawPayload: event(poisonSender).rawPayload,
      },
    });
    await prisma.inboundEvent.createMany({
      data: healthySenders.map((senderPhone) => ({
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone,
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        rawPayload: event(senderPhone).rawPayload,
      })),
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = new PrismaService();
        await client.$connect();
        return client;
      }),
    );
    try {
      await Promise.all(
        clients.map((client) => productionDriver(client).processReceived(100)),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { id: held.id } }))
        .processingStatus,
    ).toBe(InboundProcessingStatus.PROCESSING);
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { id: blocked.id } }))
        .processingStatus,
    ).toBe(InboundProcessingStatus.RECEIVED);
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: afterPoison.id },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
    expect(
      await prisma.inboundEvent.count({
        where: {
          senderPhone: { in: healthySenders },
          processingStatus: InboundProcessingStatus.IGNORED,
        },
      }),
    ).toBe(20);
    await prisma.inboundEvent.update({
      where: { id: held.id },
      data: {
        processingStatus: InboundProcessingStatus.FAILED,
        processedAt: new Date(),
      },
    });
    await productionDriver(prisma).processReceived(100);
    expect(
      (await prisma.inboundEvent.findUniqueOrThrow({ where: { id: blocked.id } }))
        .processingStatus,
    ).toBe(InboundProcessingStatus.IGNORED);
  });

  it("converges twenty independent stale recovery scans on one generation", async () => {
    const stale = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone: "+263779000001",
        senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
        processingContractVersion: 1,
        processingStartedAt: new Date(Date.now() - 60_000),
        rawPayload: event("+263779000001").rawPayload,
      },
    });
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const client = new PrismaService();
        await client.$connect();
        return client;
      }),
    );
    const started = performance.now();
    try {
      await Promise.all(
        clients.map((client) =>
          productionDriver(client).recoverStaleProcessing({
            limit: 1,
            staleBefore: new Date(Date.now() - 1000),
            maxAttempts: 5,
          }),
        ),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const actual = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(actual.processingAttempts).toBe(2);
    expect(actual.processingStatus).toBe(InboundProcessingStatus.IGNORED);
    expect(
      await prisma.auditLog.count({
        where: {
          inboundEventId: stale.id,
          eventType: "inbound_recovery_claimed",
        },
      }),
    ).toBe(1);
    console.info(
      JSON.stringify({
        proof: "stale_inbound_contention",
        contenders: 20,
        winners: 1,
        generation: 2,
        duplicateEffects: 0,
        durationMs: performance.now() - started,
      }),
    );
  });

  it("schedules all seven loops in two overlapping worker instances and drains after failure", async () => {
    jest.useFakeTimers();
    const config = new ConfigService({
      worker: {
        batchSize: 5,
        cadencesMs: Object.fromEntries(WORKER_LOOPS.map((loop) => [loop, 100])),
        staleInboundMs: 1000,
        staleOutboundMs: 1000,
        inboundMaxAttempts: 5,
        backoffMaxMs: 1000,
        jitterPercent: 0,
        shutdownGraceMs: 1000,
        readinessSilenceMs: 60000,
      },
    });
    const metrics = [new WorkerMetricsService(), new WorkerMetricsService()];
    const instances = metrics.map(
      (record, index) =>
        new WorkerOrchestratorService(
          {
            processReceived:
              index === 0
                ? jest
                    .fn()
                    .mockRejectedValueOnce(new Error("injected"))
                    .mockResolvedValue([])
                : jest.fn().mockResolvedValue([]),
            recoverStaleProcessing: jest.fn().mockResolvedValue([]),
          } as never,
          { recoverPending: jest.fn().mockResolvedValue([]) } as never,
          { recover: jest.fn().mockResolvedValue([]) } as never,
          {
            dispatchPending: jest.fn().mockResolvedValue([]),
            recoverStaleSending: jest.fn().mockResolvedValue([]),
          } as never,
          { runOnce: jest.fn().mockResolvedValue([]) } as never,
          prisma,
          record,
          config as never,
        ),
    );
    try {
      for (const instance of instances) instance.start();
      await jest.advanceTimersByTimeAsync(250);
      for (const record of metrics)
        for (const loop of WORKER_LOOPS)
          expect(record.render()).toContain(
            `newsroom_worker_loop_runs_total{loop="${loop}"} 3`,
          );
      expect(metrics[0]!.render()).toContain(
        'newsroom_worker_loop_errors_total{loop="inbound"} 1',
      );
      expect(metrics[1]!.render()).toContain(
        'newsroom_worker_loop_errors_total{loop="inbound"} 0',
      );
      for (const instance of instances) instance.stop();
      const stopped = metrics.map((record) => record.render());
      await jest.advanceTimersByTimeAsync(1000);
      expect(metrics.map((record) => record.render())).toEqual(stopped);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      for (const instance of instances) instance.stop();
      jest.useRealTimers();
    }
  });

  it("uses processingStartedAt rather than receivedAt for PROCESSING backlog age", async () => {
    const now = Date.now();
    await prisma.inboundEvent.createMany({ data: [
      {
        provider: Provider.WHATSAPP, providerMessageId: randomUUID(),
        senderPhone: "+263778800001", senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.RECEIVED,
        receivedAt: new Date(now - 120_000), rawPayload: {},
      },
      {
        provider: Provider.WHATSAPP, providerMessageId: randomUUID(),
        senderPhone: "+263778800002", senderIngestSequence: 1n,
        eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1, processingContractVersion: 1,
        receivedAt: new Date(now - 86_400_000),
        processingStartedAt: new Date(now - 10_000), rawPayload: {},
      },
    ] });
    const exposition = await new BacklogMetricsService(prisma).render();
    const age = (status: string): number => Number(
      exposition.match(new RegExp(`newsroom_worker_backlog_oldest_age_seconds\\{subsystem="inbound",status="${status}"\\} ([0-9.]+)`))?.[1],
    );
    expect(age("RECEIVED")).toBeGreaterThan(100);
    expect(age("RECEIVED")).toBeLessThan(180);
    expect(age("PROCESSING")).toBeGreaterThan(0);
    expect(age("PROCESSING")).toBeLessThan(45);
  });

  it("contains privacy sentinels across failure logs, health, metrics and recovery audits", async () => {
    const sentinels = [
      "SECRET_WHATSAPP_ACCESS_R8B5",
      "SECRET_WHATSAPP_APP_R8B5",
      "SECRET_WHATSAPP_VERIFY_R8B5",
      "SECRET_HMAC_DRAFT_R8B5",
      "SECRET_HMAC_MEDIA_R8B5",
      "SECRET_HMAC_PUBLICATION_R8B5",
      "SECRET_HMAC_PREVIEW_R8B5",
      "SECRET_S3_ACCESS_R8B5",
      "SECRET_S3_SECRET_R8B5",
      "SECRET_S3_SESSION_R8B5",
      "SECRET_DB_CREDENTIAL_R8B5",
      "PHONE_SENTINEL_R8B5",
      "HEADLINE_SENTINEL_R8B5",
      "BODY_SENTINEL_R8B5",
      "BYLINE_SENTINEL_R8B5",
      "CAPTION_SENTINEL_R8B5",
      "RAW_PROVIDER_SENTINEL_R8B5",
      "TEMP_META_URL_SENTINEL_R8B5",
      "MEDIA_BYTE_SENTINEL_R8B5",
      "WORDPRESS_ARTICLE_SENTINEL_R8B5",
      "COOKIE_SENTINEL_R8B5",
      "NONCE_SENTINEL_R8B5",
      "Bearer SECRET_R8B5",
    ];
    const captured: unknown[] = [];
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation((...args: unknown[]) => {
        captured.push(args);
      });
    const failing = new WhatsappWebhookIngestionService({
      $transaction: jest.fn().mockRejectedValue(new Error(sentinels.join(" "))),
    } as never);
    await expect(
      failing.persist({
        events: [event("+263775000001")],
        foreignPhoneChanges: 0,
        unsupportedChanges: 0,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const health = new HealthController({
      $queryRaw: jest.fn().mockRejectedValue(new Error(sentinels.join(" "))),
    } as never);
    const healthOutput = await health
      .ready()
      .catch((failure: unknown) => failure);
    const metrics = new WorkerMetricsService();
    metrics.record("inbound", 1, 0, true);
    await prisma.inboundEvent.create({ data: {
      provider: Provider.WHATSAPP, providerMessageId: randomUUID(),
      senderPhone: "+263778000001", senderIngestSequence: 1n,
      eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.RECEIVED,
      rawPayload: { marker: sentinels.join(" ") },
    } });
    const backlog = new BacklogMetricsService(prisma);
    const beforeSeries = (await backlog.render()).split("\n").filter((line) => line.startsWith("newsroom_worker_backlog{")).length;
    await prisma.inboundEvent.createMany({ data: Array.from({ length: 50 }, (_, index) => ({
      provider: Provider.WHATSAPP, providerMessageId: randomUUID(),
      senderPhone: `+2637781${String(index).padStart(5, "0")}`, senderIngestSequence: 1n,
      eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.RECEIVED,
      rawPayload: { marker: sentinels.join(" ") },
    })) });
    const backlogText = await backlog.render();
    expect(backlogText.split("\n").filter((line) => line.startsWith("newsroom_worker_backlog{")).length).toBe(beforeSeries);
    const stale = await prisma.inboundEvent.create({ data: {
      provider: Provider.WHATSAPP, providerMessageId: randomUUID(),
      senderPhone: "+263778000099", senderIngestSequence: 1n,
      eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.PROCESSING,
      processingAttempts: 1, processingContractVersion: 1,
      processingStartedAt: new Date(Date.now() - 60000),
      rawPayload: event("+263778000099", randomUUID(), sentinels.join(" ")).rawPayload,
    } });
    await productionDriver(prisma).recoverStaleProcessing({ limit: 1, staleBefore: new Date(Date.now() - 1000), maxAttempts: 2 });
    expect(await prisma.auditLog.count({ where: { inboundEventId: stale.id, eventType: "inbound_recovery_claimed" } })).toBe(1);
    const combined = JSON.stringify({
      captured,
      healthOutput,
      metrics: metrics.render(),
      backlog: backlogText,
    });
    for (const sentinel of sentinels) expect(combined).not.toContain(sentinel);
    errorSpy.mockRestore();
    const auditMetadata = await prisma.auditLog.findMany({
      where: { inboundEventId: stale.id }, select: { metadata: true },
    });
    const auditText = JSON.stringify(auditMetadata);
    for (const sentinel of sentinels) expect(auditText).not.toContain(sentinel);
  });

  it("measures bounded worker and backlog plans at ten-thousand-row scale", async () => {
    const sender = "+263776000001";
    await prisma.inboundEvent.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => ({
        provider: Provider.WHATSAPP,
        providerMessageId: `scale-${index}`,
        senderPhone: sender,
        senderIngestSequence: BigInt(index),
        eventType: InboundEventType.TEXT,
        processingStatus:
          index % 2
            ? InboundProcessingStatus.RECEIVED
            : InboundProcessingStatus.PROCESSING,
        processingStartedAt: index % 2 ? null : new Date(0),
        rawPayload: {},
      })),
    });
    await prisma.$executeRawUnsafe('ANALYZE "InboundEvent"');
    // Measure each plan independently: one connection is intentionally configured,
    // so parallel EXPLAINs can time out waiting behind an unrelated slow plan.
    const plans = [
      await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT candidate."id" FROM "InboundEvent" candidate WHERE candidate."processingStatus"='RECEIVED' AND NOT EXISTS (SELECT 1 FROM "InboundEvent" earlier WHERE earlier."senderPhone"=candidate."senderPhone" AND earlier."senderIngestSequence"<candidate."senderIngestSequence" AND earlier."processingStatus" IN ('RECEIVED','PROCESSING')) ORDER BY candidate."receivedAt",candidate."id" LIMIT 25`,
      ),
      await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT candidate."id" FROM "InboundEvent" candidate WHERE candidate."processingStatus"='RECEIVED' AND NOT EXISTS (SELECT 1 FROM LATERAL (SELECT earlier."id" FROM "InboundEvent" earlier WHERE earlier."senderPhone"=candidate."senderPhone" AND earlier."senderIngestSequence"<candidate."senderIngestSequence" AND earlier."processingStatus" IN ('RECEIVED','PROCESSING') LIMIT 1) predecessor) ORDER BY candidate."receivedAt",candidate."id" LIMIT 25`,
      ),
      await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT "id" FROM "InboundEvent" WHERE "processingStatus"='PROCESSING' AND "processingStartedAt"<NOW() ORDER BY "processingStartedAt","id" LIMIT 25`,
      ),
      await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT "processingStatus",COUNT(*),MIN("receivedAt") FROM "InboundEvent" GROUP BY "processingStatus"`,
      ),
    ];
    const rendered = plans.map((plan) =>
      plan.map((row) => row["QUERY PLAN"]).join("\n"),
    );
    expect(rendered.every((plan) => plan.includes("actual time"))).toBe(true);
    console.info(
      JSON.stringify({ proof: "query_plans", rows: 10000, plans: rendered }),
    );
    const backlog = await new BacklogMetricsService(prisma).render();
    expect(backlog).toContain('subsystem="inbound"');
    await prisma.inboundEvent.deleteMany();
    await prisma.inboundEvent.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => ({
        provider: Provider.WHATSAPP,
        providerMessageId: `distributed-${index}`,
        senderPhone: `+26378${String(Math.floor(index / 2)).padStart(7, "0")}`,
        senderIngestSequence: BigInt(index % 2),
        eventType: InboundEventType.TEXT,
        processingStatus:
          index % 2
            ? InboundProcessingStatus.RECEIVED
            : InboundProcessingStatus.PROCESSING,
        processingStartedAt: index % 2 ? null : new Date(0),
        rawPayload: {},
      })),
    });
    await prisma.$executeRawUnsafe('ANALYZE "InboundEvent"');
    const distributed = await prisma.$queryRawUnsafe<
      Array<{ "QUERY PLAN": string }>
    >(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT candidate."id" FROM "InboundEvent" candidate WHERE candidate."processingStatus"='RECEIVED' AND NOT EXISTS (SELECT 1 FROM LATERAL (SELECT earlier."id" FROM "InboundEvent" earlier WHERE earlier."senderPhone"=candidate."senderPhone" AND earlier."senderIngestSequence"<candidate."senderIngestSequence" AND earlier."processingStatus" IN ('RECEIVED','PROCESSING') LIMIT 1) predecessor) ORDER BY candidate."receivedAt",candidate."id" LIMIT 25`,
    );
    console.info(
      JSON.stringify({
        proof: "distributed_sender_plan",
        rows: 10000,
        senders: 5000,
        plan: distributed.map((row) => row["QUERY PLAN"]).join("\n"),
      }),
    );
  });
});
