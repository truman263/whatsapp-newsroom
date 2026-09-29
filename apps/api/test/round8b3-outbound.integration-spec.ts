/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  ConversationState,
  DraftPreparationStatus,
  InboundEventType,
  InboundProcessingStatus,
  OutboundMessageStatus,
  OutboundMessageType,
  Provider,
  ReporterStatus,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { ApprovalPromptService } from "../src/modules/whatsapp-outbound/approval-prompt.service";
import { WhatsappOutboundClient } from "../src/modules/whatsapp-outbound/whatsapp-outbound.client";
import { WhatsappOutboundDispatcher } from "../src/modules/whatsapp-outbound/whatsapp-outbound.dispatcher";
import { WhatsappOutboundStatusService } from "../src/modules/whatsapp-outbound/whatsapp-outbound-status.service";
import type {
  MetaOutboundTransport,
  MetaTransportRequest,
  MetaTransportResponse,
} from "../src/modules/whatsapp-outbound/whatsapp-outbound.types";

if (!process.env.DATABASE_URL)
  throw new Error("Run with pnpm test:round8b3-outbound");

jest.setTimeout(120_000);
const prisma = new PrismaService();
const queue = new ApprovalPromptService();
const config = new ConfigService({
  preview: { publicOrigin: "https://newsroom.test" },
  whatsapp: {
    accessToken: "disposable-proof-token",
    phoneNumberId: "123456789",
    graphApiVersion: "v99.0",
    outboundRequestTimeoutMs: 5000,
  },
});

type Mode =
  | { kind: "response"; response: MetaTransportResponse; accepted?: boolean }
  | { kind: "lost-after-accept" }
  | { kind: "network" }
  | { kind: "timeout" };

class ControlledMetaTransport implements MetaOutboundTransport {
  calls = 0;
  accepted = 0;
  readonly requests: MetaTransportRequest[] = [];
  constructor(private readonly mode: Mode) {}
  send(request: MetaTransportRequest): Promise<MetaTransportResponse> {
    this.calls++;
    this.requests.push(request);
    if (this.mode.kind === "lost-after-accept") {
      this.accepted++;
      return Promise.reject(new Error("response lost after acceptance"));
    }
    if (this.mode.kind === "network")
      return Promise.reject(new Error("network unavailable"));
    if (this.mode.kind === "timeout")
      return Promise.reject(new Error("request timeout"));
    if (this.mode.accepted) this.accepted++;
    return Promise.resolve(this.mode.response);
  }
}

async function fixture() {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
      displayName: "Round 8B.3 proof",
      status: ReporterStatus.ACTIVE,
    },
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.AWAITING_APPROVAL,
      headline: "Proof headline",
      body: "Proof body",
      byline: "Proof byline",
      version: 4,
      wordpressPostId: BigInt(Date.now()),
    },
  });
  await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      state: ConversationState.AWAITING_APPROVAL,
      currentStoryId: story.id,
    },
  });
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: randomUUID(),
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: BigInt(Date.now()),
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSED,
      processedAt: new Date(),
      rawPayload: {},
    },
  });
  const preparation = await prisma.draftPreparation.create({
    data: {
      storyId: story.id,
      inboundEventId: event.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      wordpressPostId: story.wordpressPostId,
      wordpressAppliedVersion: "a".repeat(64),
      approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
      previewExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const message = await prisma.$transaction((tx) =>
    queue.queueApprovalPromptInTransaction(tx, {
      preparationId: preparation.id,
      storyId: story.id,
      storyVersion: story.version,
      wordpressAppliedVersion: "a".repeat(64),
    }),
  );
  return { reporter, story, preparation, message };
}

function dispatcher(
  transport: MetaOutboundTransport,
  database: PrismaService = prisma,
) {
  return new WhatsappOutboundDispatcher(
    database,
    { issue: jest.fn().mockResolvedValue("disposable.preview.capability") } as never,
    new WhatsappOutboundClient(config as never, transport),
    config as never,
  );
}

async function makeStale(id: string, milliseconds = 60_000): Promise<Date> {
  const at = new Date(Date.now() - milliseconds);
  await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt"=${at} WHERE "id"=${id}::uuid`;
  return at;
}

async function heldEvidence(id: string) {
  const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
  const audits = await prisma.auditLog.count({
    where: { entityId: id, eventType: "approval_prompt_send_uncertain" },
  });
  return { row, audits };
}

describe("Round 8B.3 outbound authority", () => {
  beforeAll(async () => prisma.$connect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE');
  });
  afterAll(async () => prisma.$disconnect());

  it("serializes twenty PENDING dispatchers into one successful external send", async () => {
    const { message, preparation } = await fixture();
    const transport = new ControlledMetaTransport({
      kind: "response",
      accepted: true,
      response: { status: 200, body: { messages: [{ id: "wamid.success" }] } },
    });
    const service = dispatcher(transport);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.dispatchOne(message.id)),
    );
    expect(results.filter((result) => result === "SENT")).toHaveLength(1);
    expect(transport.calls).toBe(1);
    expect(transport.accepted).toBe(1);
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      status: OutboundMessageStatus.SENT,
      providerMessageId: "wamid.success",
      sendAttempts: 1,
      correlationKey: message.correlationKey,
    });
    expect(await prisma.outboundMessage.count()).toBe(1);
    expect(
      await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: preparation.id },
        select: { approvalPromptOutboundMessageId: true },
      }),
    ).toEqual({ approvalPromptOutboundMessageId: message.id });
    const request = JSON.parse(transport.requests[0]!.body) as {
      interactive: { action: { buttons: Array<{ reply: { id: string } }> } };
    };
    expect(request.interactive.action.buttons[0]!.reply.id).toBe(
      `newsroom:v1:story:approve:${message.id}`,
    );
  });

  it("holds accepted-response-lost exactly once and never resends", async () => {
    const { message } = await fixture();
    const transport = new ControlledMetaTransport({ kind: "lost-after-accept" });
    const service = dispatcher(transport);
    await expect(service.dispatchOne(message.id)).resolves.toBe(
      "OUTCOME_UNCERTAIN",
    );
    const before = await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: message.id },
    });
    await Promise.all([
      ...Array.from({ length: 5 }, () => service.recoverUncertainSend(message.id)),
      ...Array.from({ length: 20 }, () => service.recoverUncertainSend(message.id)),
    ]);
    const { row, audits } = await heldEvidence(message.id);
    expect(row).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      providerMessageId: null,
      sendAttempts: 1,
      lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN",
      lastErrorMessage: null,
      failedAt: null,
    });
    expect(row.updatedAt).toEqual(before.updatedAt);
    expect(audits).toBe(1);
    expect(transport.accepted).toBe(1);
    expect(transport.calls).toBe(1);
    expect(await prisma.outboundMessage.count()).toBe(1);
  });

  it.each([
    ["connection refusal", { kind: "network" }, "OUTCOME_UNCERTAIN", OutboundMessageStatus.SENDING],
    ["timeout", { kind: "timeout" }, "OUTCOME_UNCERTAIN", OutboundMessageStatus.SENDING],
    ["HTTP 5xx", { kind: "response", response: { status: 503, body: { error: "private provider text" } } }, "OUTCOME_UNCERTAIN", OutboundMessageStatus.SENDING],
    ["HTTP 429", { kind: "response", response: { status: 429, body: {} } }, "OUTCOME_UNCERTAIN", OutboundMessageStatus.SENDING],
    ["malformed HTTP 200", { kind: "response", response: { status: 200, body: { messages: [] } } }, "OUTCOME_UNCERTAIN", OutboundMessageStatus.SENDING],
    ["definitive HTTP 400", { kind: "response", response: { status: 400, body: {} } }, "FAILED", OutboundMessageStatus.FAILED],
    ["authentication HTTP 401", { kind: "response", response: { status: 401, body: {} } }, "FAILED", OutboundMessageStatus.FAILED],
  ] as const)("classifies %s without automatic resend", async (_label, mode, result, status) => {
    const { message } = await fixture();
    const transport = new ControlledMetaTransport(mode);
    const first = dispatcher(transport);
    expect(await first.dispatchOne(message.id)).toBe(result);
    const restarted = new PrismaService();
    await restarted.$connect();
    try {
      const second = dispatcher(transport, restarted);
      expect(await second.dispatchPending(10)).toEqual([]);
      expect(await second.recoverStaleSending(new Date(Date.now() + 1000), 10))
        .toHaveLength(status === OutboundMessageStatus.SENDING ? 1 : 0);
    } finally {
      await restarted.$disconnect();
    }
    expect(transport.calls).toBe(1);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.status).toBe(status);
    expect(row.sendAttempts).toBe(1);
    expect(row.lastErrorMessage).toBeNull();
    expect(await prisma.auditLog.count({
      where: { entityId: message.id, eventType: "approval_prompt_send_uncertain" },
    })).toBe(status === OutboundMessageStatus.SENDING ? 1 : 0);
  });

  it("holds a stale SENDING while an unresolved external send is in flight without recovery resend", async () => {
    const { message } = await fixture();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const blocked = new Promise<MetaTransportResponse>((_resolve, reject) => {
      release = () => reject(new Error("abandoned sender"));
    });
    const transport: MetaOutboundTransport = {
      send: jest.fn(() => {
        entered();
        return blocked;
      }),
    };
    const active = dispatcher(transport).dispatchOne(message.id);
    await enteredPromise;
    await makeStale(message.id);
    const recoveryTransport = new ControlledMetaTransport({ kind: "network" });
    const recovery = dispatcher(recoveryTransport);
    await expect(
      recovery.recoverStaleSending(new Date(Date.now() - 1000), 10),
    ).resolves.toEqual([
      { messageId: message.id, result: "MANUAL_RECONCILIATION_REQUIRED" },
    ]);
    const { row, audits } = await heldEvidence(message.id);
    expect(row.sendAttempts).toBe(1);
    expect(audits).toBe(1);
    expect(recoveryTransport.calls).toBe(0);
    release();
    await expect(active).resolves.toBe("OUTCOME_UNCERTAIN");
    expect((transport.send as jest.Mock).mock.calls).toHaveLength(1);
    expect((await heldEvidence(message.id)).audits).toBe(1);
  });

  it("holds the durable post-claim state after a crash before any Meta invocation", async () => {
    const { message } = await fixture();
    expect(message).toMatchObject({
      status: OutboundMessageStatus.PENDING,
      sendAttempts: 0,
    });
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: {
        status: OutboundMessageStatus.SENDING,
        sendAttempts: 1,
        providerMessageId: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        failedAt: null,
      },
    });
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      sendAttempts: 1,
      providerMessageId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      failedAt: null,
    });
    const transport = new ControlledMetaTransport({ kind: "network" });
    expect(transport.calls).toBe(0);
    expect(transport.accepted).toBe(0);
    await makeStale(message.id);
    const service = dispatcher(transport);
    await expect(
      service.recoverStaleSending(new Date(Date.now() - 1000), 10),
    ).resolves.toEqual([
      { messageId: message.id, result: "MANUAL_RECONCILIATION_REQUIRED" },
    ]);
    let evidence = await heldEvidence(message.id);
    expect(evidence.row).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      sendAttempts: 1,
      providerMessageId: null,
      lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN",
      lastErrorMessage: null,
      failedAt: null,
    });
    expect(evidence.audits).toBe(1);
    expect(transport.calls).toBe(0);
    expect(transport.accepted).toBe(0);
    await service.recoverUncertainSend(message.id);
    await Promise.all(
      Array.from({ length: 20 }, () => service.recoverUncertainSend(message.id)),
    );
    evidence = await heldEvidence(message.id);
    expect(evidence.row.sendAttempts).toBe(1);
    expect(evidence.row.status).toBe(OutboundMessageStatus.SENDING);
    expect(evidence.audits).toBe(1);
    expect(transport.calls).toBe(0);
    expect(transport.accepted).toBe(0);
    expect(await prisma.outboundMessage.count()).toBe(1);
  });

  it("holds valid Meta success when local SENT persistence is lost", async () => {
    const { message } = await fixture();
    const transport = new ControlledMetaTransport({
      kind: "response",
      accepted: true,
      response: { status: 200, body: { messages: [{ id: "wamid.lost-local" }] } },
    });
    let transactions = 0;
    const database = new Proxy(prisma, {
      get(target, property, receiver) {
        // Prisma's generated client surface is intentionally forwarded unchanged.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          transactions++;
          if (transactions === 2) throw new Error("injected local persistence loss");
          return (target.$transaction as (...values: unknown[]) => unknown)(...args);
        };
      },
    });
    await expect(dispatcher(transport, database).dispatchOne(message.id)).rejects.toThrow(
      "injected local persistence loss",
    );
    expect(transport.accepted).toBe(1);
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      providerMessageId: null,
      sendAttempts: 1,
    });
    await makeStale(message.id);
    const recoveryTransport = new ControlledMetaTransport({ kind: "network" });
    await dispatcher(recoveryTransport).recoverStaleSending(
      new Date(Date.now() - 1000),
      10,
    );
    expect((await heldEvidence(message.id)).audits).toBe(1);
    expect(recoveryTransport.calls).toBe(0);
    expect(transport.calls).toBe(1);
  });

  const uncertainModes: Array<[string, Mode]> = [
    ["network", { kind: "network" }],
    ["timeout", { kind: "timeout" }],
    ["429", { kind: "response", response: { status: 429, body: {} } }],
    ["5xx", { kind: "response", response: { status: 503, body: {} } }],
    ["missing id", { kind: "response", response: { status: 200, body: {} } }],
    ["malformed success", { kind: "response", response: { status: 200, body: { messages: [{ id: 7 }] } } }],
  ];
  it.each(uncertainModes)("maps uncertain %s outcome to the same durable hold", async (_name, mode) => {
    const { message } = await fixture();
    const transport = new ControlledMetaTransport(mode);
    const service = dispatcher(transport);
    await expect(service.dispatchOne(message.id)).resolves.toBe("OUTCOME_UNCERTAIN");
    const { row, audits } = await heldEvidence(message.id);
    expect(row).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      sendAttempts: 1,
      lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN",
      lastErrorMessage: null,
      failedAt: null,
    });
    expect(audits).toBe(1);
    await service.recoverUncertainSend(message.id);
    expect(transport.calls).toBe(1);
    expect((await heldEvidence(message.id)).audits).toBe(1);
  });

  it.each([401, 403, 400])(
    "moves definitive HTTP %i rejection to FAILED only",
    async (status) => {
      const { message } = await fixture();
      const transport = new ControlledMetaTransport({
        kind: "response",
        response: { status, body: { ignored: "remote text" } },
      });
      const service = dispatcher(transport);
      await expect(service.dispatchOne(message.id)).resolves.toBe("FAILED");
      const row = await prisma.outboundMessage.findUniqueOrThrow({
        where: { id: message.id },
      });
      expect(row.status).toBe(OutboundMessageStatus.FAILED);
      expect(row.failedAt).not.toBeNull();
      expect(row.lastErrorMessage).toBeNull();
      expect(row.lastErrorCode).toBe(
        status === 401 || status === 403
          ? "WHATSAPP_AUTHENTICATION_FAILURE"
          : "WHATSAPP_REQUEST_REJECTED",
      );
      expect(JSON.stringify(row)).not.toContain("remote text");
      expect(await service.recoverUncertainSend(message.id)).toBe("NOT_CLAIMED");
      expect(transport.calls).toBe(1);
    },
  );

  it("fails an invalid local prompt before Meta and never enters recovery", async () => {
    const { message } = await fixture();
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { payload: {} },
    });
    const transport = new ControlledMetaTransport({ kind: "network" });
    const service = dispatcher(transport);
    await expect(service.dispatchOne(message.id)).resolves.toBe("FAILED");
    expect(transport.calls).toBe(0);
    expect(await service.recoverUncertainSend(message.id)).toBe("NOT_CLAIMED");
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      status: OutboundMessageStatus.FAILED,
      sendAttempts: 0,
      lastErrorCode: "WHATSAPP_PROMPT_CONTRACT_FAILURE",
      lastErrorMessage: null,
    });
  });

  it("yields to SENT, DELIVERED, FAILED and provider-status authority", async () => {
    const services = dispatcher(new ControlledMetaTransport({ kind: "network" }));
    for (const status of [
      OutboundMessageStatus.SENT,
      OutboundMessageStatus.DELIVERED,
      OutboundMessageStatus.FAILED,
    ]) {
      const { message } = await fixture();
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: { status, sendAttempts: 1 },
      });
      expect(await services.recoverUncertainSend(message.id)).toBe("NOT_CLAIMED");
    }
    const { message } = await fixture();
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: {
        status: OutboundMessageStatus.SENDING,
        sendAttempts: 1,
        providerMessageId: "wamid.callback-race",
      },
    });
    const statusService = new WhatsappOutboundStatusService(prisma);
    await expect(
      statusService.applyProviderStatus({
        providerMessageId: "wamid.callback-race",
        status: "sent",
      }),
    ).resolves.toBe("APPLIED");
    await expect(services.recoverUncertainSend(message.id)).resolves.toBe(
      "NOT_CLAIMED",
    );
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({ status: OutboundMessageStatus.SENT });
  });

  it("scans only stale SENDING in stable bounded order without Meta or audit spam", async () => {
    const { reporter, story, message } = await fixture();
    const create = async (status: OutboundMessageStatus, suffix: string) =>
      prisma.outboundMessage.create({
        data: {
          reporterId: reporter.id,
          storyId: story.id,
          type: OutboundMessageType.TEXT,
          status,
          correlationKey: `r8b3:${suffix}:${randomUUID()}`,
          payload: {},
          sendAttempts: status === OutboundMessageStatus.PENDING ? 0 : 1,
        },
      });
    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: { status: OutboundMessageStatus.SENDING, sendAttempts: 1 },
    });
    const staleA = message;
    const staleB = await create(OutboundMessageStatus.SENDING, "stale-b");
    const staleC = await create(OutboundMessageStatus.SENDING, "stale-c");
    const fresh = await create(OutboundMessageStatus.SENDING, "fresh");
    await create(OutboundMessageStatus.PENDING, "pending");
    await create(OutboundMessageStatus.SENT, "sent");
    await create(OutboundMessageStatus.DELIVERED, "delivered");
    await create(OutboundMessageStatus.FAILED, "failed");
    const held = await create(OutboundMessageStatus.SENDING, "held");
    await prisma.outboundMessage.update({
      where: { id: held.id },
      data: { lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN" },
    });
    const base = Date.now() - 120_000;
    const times = [
      [staleA.id, new Date(base)],
      [staleB.id, new Date(base + 1000)],
      [staleC.id, new Date(base + 2000)],
      [held.id, new Date(base + 3000)],
    ] as const;
    for (const [id, at] of times)
      await prisma.$executeRaw`UPDATE "OutboundMessage" SET "updatedAt"=${at} WHERE "id"=${id}::uuid`;
    const transport = new ControlledMetaTransport({ kind: "network" });
    const service = dispatcher(transport);
    const first = await service.recoverStaleSending(
      new Date(Date.now() - 60_000),
      2,
    );
    expect(first.map(({ messageId }) => messageId)).toEqual([
      staleA.id,
      staleB.id,
    ]);
    const second = await service.recoverStaleSending(
      new Date(Date.now() - 60_000),
      100,
    );
    expect(second.map(({ messageId }) => messageId)).toEqual([
      staleC.id,
      held.id,
    ]);
    expect(transport.calls).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { eventType: "approval_prompt_send_uncertain" },
      }),
    ).toBe(3);
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: fresh.id } }),
    ).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      lastErrorCode: null,
    });
    await Promise.all(
      Array.from({ length: 20 }, () => service.recoverUncertainSend(staleA.id)),
    );
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: staleA.id,
          eventType: "approval_prompt_send_uncertain",
        },
      }),
    ).toBe(1);
  });
});
