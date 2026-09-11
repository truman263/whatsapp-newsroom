import { randomUUID } from "node:crypto";
import {
  ConversationState,
  InboundEventType,
  InboundProcessingStatus,
  Provider,
  type InboundEvent,
  type Reporter,
  ReporterStatus,
} from "@prisma/client";
import { runReporterCli } from "../src/commands/reporter-cli";
import { PrismaService } from "../src/database/prisma.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { REPORTER_WORKFLOW_AUDIT } from "../src/modules/reporter-workflow/reporter-workflow.audit";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ReporterProvisioningService } from "../src/modules/reporter-workflow/reporter-provisioning.service";
import { ReporterWorkflowError } from "../src/modules/reporter-workflow/reporter-workflow.errors";
import { WhatsappWebhookIngestionService } from "../src/modules/whatsapp-webhook/whatsapp-webhook-ingestion.service";
import type {
  NormalizedInboundEvent,
  NormalizedWebhookBatch,
} from "../src/modules/whatsapp-webhook/whatsapp-webhook.types";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required; this suite never reads .env");
jest.setTimeout(120_000);

const prisma = new PrismaService();
const run = Date.now().toString().slice(-8);
let sequence = 0;
let ingestSequence = 0n;
const phone = (): string => `+2637${run}${String(sequence++).padStart(2, "0")}`;
const providerId = (name: string): string =>
  `round4b:${run}:${name}:${sequence++}`;

async function reset(): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE TABLE "Approval", "AuditLog", "StoryCategory", "StoryMedia", "OutboundMessage", "PublishAttempt", "Conversation", "InboundEvent", "InboundSenderSequence", "Story", "EditorialCategory", "Reporter" CASCADE
  `;
}

async function reporter(
  status: ReporterStatus = ReporterStatus.ACTIVE,
): Promise<Reporter> {
  return prisma.reporter.create({
    data: { phoneNumber: phone(), displayName: `Round4B ${sequence}`, status },
  });
}

async function inbound(
  senderPhone: string,
  name: string,
  reporterId?: string,
): Promise<InboundEvent> {
  return prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: providerId(name),
      senderPhone,
      senderIngestSequence: ingestSequence++,
      reporterId,
      eventType: InboundEventType.TEXT,
      rawPayload: { proof: "round4b" },
    },
  });
}

function normalized(senderPhone: string, name: string): NormalizedInboundEvent {
  return {
    providerMessageId: providerId(name),
    senderPhone,
    eventType: InboundEventType.TEXT,
    rawPayload: { proof: "round5b0" },
    providerOccurredAt: new Date(),
  };
}

function batch(events: NormalizedInboundEvent[]): NormalizedWebhookBatch {
  return { events, foreignPhoneChanges: 0, unsupportedChanges: 0 };
}

function processor(client: PrismaService): InboundEventProcessingService {
  return new InboundEventProcessingService(
    client,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
  );
}

async function clients(count: number): Promise<PrismaService[]> {
  const result = Array.from({ length: count }, () => new PrismaService());
  await Promise.all(result.map((client) => client.$connect()));
  return result;
}

describe("Round 4B disposable PostgreSQL proof", () => {
  beforeAll(async () => {
    await prisma.$connect();
    await reset();
  });

  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it("provisions, conflicts, deactivates, and reactivates with deterministic CLI semantics", async () => {
    const service = new ReporterProvisioningService(prisma);
    const number = phone();
    const output = { log: jest.fn(), error: jest.fn() };
    const args = [
      "reporter",
      "provision",
      "--phone",
      number,
      "--display-name",
      " Reporter ",
      "--editorial-byline",
      "   ",
    ];
    await expect(runReporterCli(args, service, output)).resolves.toBe(0);
    await expect(runReporterCli(args, service, output)).resolves.toBe(0);
    await expect(
      runReporterCli(
        ["reporter", "provision", "--phone", number, "--display-name", "Other"],
        service,
        output,
      ),
    ).resolves.toBe(3);
    await expect(
      runReporterCli(
        ["reporter", "deactivate", "--phone", number],
        service,
        output,
      ),
    ).resolves.toBe(0);
    await expect(
      runReporterCli(
        ["reporter", "deactivate", "--phone", number],
        service,
        output,
      ),
    ).resolves.toBe(0);
    await expect(
      runReporterCli(
        ["reporter", "reactivate", "--phone", number],
        service,
        output,
      ),
    ).resolves.toBe(0);
    await expect(
      runReporterCli(
        ["reporter", "reactivate", "--phone", number],
        service,
        output,
      ),
    ).resolves.toBe(0);
    await expect(
      runReporterCli(
        ["reporter", "deactivate", "--phone", phone()],
        service,
        output,
      ),
    ).resolves.toBe(4);
    await expect(
      runReporterCli(
        ["reporter", "reactivate", "--phone", phone()],
        service,
        output,
      ),
    ).resolves.toBe(4);
    await expect(
      runReporterCli(
        [
          "reporter",
          "provision",
          "--phone",
          "bad",
          "--display-name",
          "Reporter",
        ],
        service,
        output,
      ),
    ).resolves.toBe(2);
    await expect(
      runReporterCli(
        ["reporter", "provision", "--phone", phone(), "--display-name", " "],
        service,
        output,
      ),
    ).resolves.toBe(2);

    expect(
      await prisma.reporter.count({ where: { phoneNumber: number } }),
    ).toBe(1);
    expect(
      await prisma.conversation.count({
        where: { reporter: { phoneNumber: number } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.groupBy({
        by: ["eventType"],
        where: { reporter: { phoneNumber: number } },
        _count: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: REPORTER_WORKFLOW_AUDIT.REPORTER_PROVISIONED,
          _count: 1,
        }),
        expect.objectContaining({
          eventType: REPORTER_WORKFLOW_AUDIT.REPORTER_DEACTIVATED,
          _count: 1,
        }),
        expect.objectContaining({
          eventType: REPORTER_WORKFLOW_AUDIT.REPORTER_REACTIVATED,
          _count: 1,
        }),
      ]),
    );
    expect(
      JSON.stringify([output.log.mock.calls, output.error.mock.calls]),
    ).not.toContain(number);
    expect(
      JSON.stringify(
        await prisma.auditLog.findMany({
          where: { reporter: { phoneNumber: number } },
          select: { metadata: true },
        }),
      ),
    ).not.toContain(number);
  });

  it("conditionally awards exactly one of 20 event claims", async () => {
    const event = await inbound(phone(), "claim");
    const pool = await clients(20);
    try {
      const results = await Promise.all(
        pool.map((client) => processor(client).claim(event.id)),
      );
      expect(
        results.filter(({ outcome }) => outcome === "CLAIMED"),
      ).toHaveLength(1);
      expect(
        results.filter(({ outcome }) => outcome === "NOT_CLAIMED"),
      ).toHaveLength(19);
      expect(
        await prisma.inboundEvent.findUnique({
          where: { id: event.id },
          select: { processingStatus: true, processingAttempts: true },
        }),
      ).toEqual({
        processingStatus: InboundProcessingStatus.PROCESSING,
        processingAttempts: 1,
      });
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("converges 20 Conversation provisioners on one ID and one audit", async () => {
    const owner = await reporter();
    const pool = await clients(20);
    try {
      const rows = await Promise.all(
        pool.map((client) =>
          client.$transaction((tx) =>
            new ConversationProvisioningService().getOrCreateInTransaction(
              tx,
              owner.id,
            ),
          ),
        ),
      );
      expect(new Set(rows.map(({ id }) => id)).size).toBe(1);
      expect(
        await prisma.conversation.findMany({
          where: { reporterId: owner.id },
          select: { state: true, version: true, currentStoryId: true },
        }),
      ).toEqual([
        { state: ConversationState.IDLE, version: 0, currentStoryId: null },
      ]);
      expect(
        await prisma.auditLog.count({
          where: {
            eventType: REPORTER_WORKFLOW_AUDIT.CONVERSATION_PROVISIONED,
            reporterId: owner.id,
          },
        }),
      ).toBe(1);
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("processes active and ignores unknown/inactive without downstream domain mutations", async () => {
    const active = await reporter();
    const inactive = await reporter(ReporterStatus.INACTIVE);
    const activeEvent = await inbound(active.phoneNumber, "active");
    const unknownEvent = await inbound(phone(), "unknown");
    const inactiveEvent = await inbound(inactive.phoneNumber, "inactive");
    const before = {
      story: await prisma.story.count(),
      storyMedia: await prisma.storyMedia.count(),
      storyCategory: await prisma.storyCategory.count(),
      approval: await prisma.approval.count(),
      publishAttempt: await prisma.publishAttempt.count(),
      outbound: await prisma.outboundMessage.count(),
    };
    await expect(
      processor(prisma).process(activeEvent.id),
    ).resolves.toMatchObject({ outcome: "PROCESSED", reporterId: active.id });
    await expect(processor(prisma).process(unknownEvent.id)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "REPORTER_UNKNOWN",
    });
    await expect(processor(prisma).process(inactiveEvent.id)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "REPORTER_INACTIVE",
    });
    await expect(processor(prisma).process(activeEvent.id)).resolves.toEqual({
      outcome: "NOT_CLAIMED",
    });
    const ignoredUnknown = await prisma.inboundEvent.findUnique({
      where: { id: unknownEvent.id },
      select: {
        processingStatus: true,
        lastErrorCode: true,
        lastErrorMessage: true,
        reporterId: true,
        processedAt: true,
      },
    });
    expect(ignoredUnknown).toMatchObject({
      processingStatus: InboundProcessingStatus.IGNORED,
      lastErrorCode: "REPORTER_UNKNOWN",
      lastErrorMessage: null,
      reporterId: null,
    });
    expect(ignoredUnknown?.processedAt).toBeInstanceOf(Date);
    expect(
      await prisma.inboundEvent.findUnique({
        where: { id: inactiveEvent.id },
        select: {
          processingStatus: true,
          lastErrorCode: true,
          reporterId: true,
        },
      }),
    ).toEqual({
      processingStatus: InboundProcessingStatus.IGNORED,
      lastErrorCode: "REPORTER_INACTIVE",
      reporterId: null,
    });
    expect(
      await prisma.conversation.count({ where: { reporterId: active.id } }),
    ).toBe(1);
    expect(
      await prisma.conversation.count({ where: { reporterId: inactive.id } }),
    ).toBe(0);
    expect({
      story: await prisma.story.count(),
      storyMedia: await prisma.storyMedia.count(),
      storyCategory: await prisma.storyCategory.count(),
      approval: await prisma.approval.count(),
      publishAttempt: await prisma.publishAttempt.count(),
      outbound: await prisma.outboundMessage.count(),
    }).toEqual(before);
  });

  it("fails closed on an immutable Reporter association conflict and leaves PROCESSING", async () => {
    const ownerA = await reporter();
    const ownerB = await reporter();
    const event = await inbound(
      ownerB.phoneNumber,
      "association-conflict",
      ownerA.id,
    );
    await expect(processor(prisma).process(event.id)).rejects.toMatchObject({
      code: "INBOUND_EVENT_ASSOCIATION_CONFLICT",
    });
    expect(
      await prisma.inboundEvent.findUnique({
        where: { id: event.id },
        select: {
          processingStatus: true,
          reporterId: true,
          processingAttempts: true,
        },
      }),
    ).toEqual({
      processingStatus: InboundProcessingStatus.PROCESSING,
      reporterId: ownerA.id,
      processingAttempts: 1,
    });
    expect(
      await prisma.conversation.count({ where: { reporterId: ownerB.id } }),
    ).toBe(0);
  });

  it("enforces Story mutation ownership, mutation kinds, preserve, and clear", async () => {
    const ownerA = await reporter();
    const ownerB = await reporter();
    const conversation = await prisma.conversation.create({
      data: { reporterId: ownerA.id },
    });
    const storyA = await prisma.story.create({
      data: { reporterId: ownerA.id },
    });
    const storyB = await prisma.story.create({
      data: { reporterId: ownerB.id },
    });
    const machine = new ConversationStateMachineService(prisma);
    const base = {
      conversationId: conversation.id,
      reporterId: ownerA.id,
      expectedState: ConversationState.IDLE,
      expectedVersion: 0,
      targetState: ConversationState.AWAITING_HEADLINE,
    };
    await expect(
      machine.transition({
        ...base,
        storyMutation: { kind: "ATTACH", storyId: storyB.id },
      }),
    ).rejects.toBeInstanceOf(ReporterWorkflowError);
    await expect(
      machine.transition({
        ...base,
        storyMutation: { kind: "ATTACH", storyId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(ReporterWorkflowError);
    await expect(
      machine.transition({ ...base, storyMutation: { kind: "PRESERVE" } }),
    ).rejects.toBeInstanceOf(ReporterWorkflowError);
    await expect(
      machine.transition({
        ...base,
        storyMutation: { kind: "ATTACH", storyId: storyA.id },
      }),
    ).resolves.toEqual({ outcome: "TRANSITIONED", version: 1 });
    await expect(
      machine.transition({
        conversationId: conversation.id,
        reporterId: ownerA.id,
        expectedState: ConversationState.AWAITING_HEADLINE,
        expectedVersion: 1,
        targetState: ConversationState.AWAITING_BODY,
        storyMutation: { kind: "ATTACH", storyId: storyA.id },
      }),
    ).rejects.toBeInstanceOf(ReporterWorkflowError);
    await expect(
      machine.transition({
        conversationId: conversation.id,
        reporterId: ownerA.id,
        expectedState: ConversationState.AWAITING_HEADLINE,
        expectedVersion: 1,
        targetState: ConversationState.AWAITING_BODY,
        storyMutation: { kind: "PRESERVE" },
      }),
    ).resolves.toEqual({ outcome: "TRANSITIONED", version: 2 });
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).currentStoryId,
    ).toBe(storyA.id);
    await expect(
      machine.transition({
        conversationId: conversation.id,
        reporterId: ownerA.id,
        expectedState: ConversationState.AWAITING_BODY,
        expectedVersion: 2,
        targetState: ConversationState.IDLE,
        storyMutation: { kind: "PRESERVE" },
      }),
    ).rejects.toBeInstanceOf(ReporterWorkflowError);
    await expect(
      machine.transition({
        conversationId: conversation.id,
        reporterId: ownerA.id,
        expectedState: ConversationState.AWAITING_BODY,
        expectedVersion: 2,
        targetState: ConversationState.IDLE,
        storyMutation: { kind: "CLEAR" },
      }),
    ).resolves.toEqual({ outcome: "TRANSITIONED", version: 3 });
    expect(
      await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { currentStoryId: true },
      }),
    ).toEqual({ currentStoryId: null });
  });

  it("rolls back composed domain mutation, CAS, Story attachment, and audit", async () => {
    const owner = await reporter();
    const conversation = await prisma.conversation.create({
      data: { reporterId: owner.id },
    });
    const story = await prisma.story.create({
      data: { reporterId: owner.id, headline: "before" },
    });
    const machine = new ConversationStateMachineService(prisma);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.story.update({
          where: { id: story.id },
          data: { headline: "after" },
        });
        await machine.transitionInTransaction(tx, {
          conversationId: conversation.id,
          reporterId: owner.id,
          expectedState: ConversationState.IDLE,
          expectedVersion: 0,
          targetState: ConversationState.AWAITING_HEADLINE,
          storyMutation: { kind: "ATTACH", storyId: story.id },
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");
    expect(
      await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { state: true, version: true, currentStoryId: true },
      }),
    ).toEqual({
      state: ConversationState.IDLE,
      version: 0,
      currentStoryId: null,
    });
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .headline,
    ).toBe("before");
    expect(
      await prisma.auditLog.count({ where: { entityId: conversation.id } }),
    ).toBe(0);

    const otherOwner = await reporter();
    const otherStory = await prisma.story.create({
      data: { reporterId: otherOwner.id },
    });
    for (const invalidStoryId of [otherStory.id, randomUUID()]) {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.story.update({
            where: { id: story.id },
            data: { headline: "must-roll-back" },
          });
          await machine.transitionInTransaction(tx, {
            conversationId: conversation.id,
            reporterId: owner.id,
            expectedState: ConversationState.IDLE,
            expectedVersion: 0,
            targetState: ConversationState.AWAITING_HEADLINE,
            storyMutation: { kind: "ATTACH", storyId: invalidStoryId },
          });
        }),
      ).rejects.toMatchObject({ code: "STORY_NOT_FOUND_OR_NOT_OWNED" });
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .headline,
      ).toBe("before");
      expect(
        await prisma.conversation.findUnique({
          where: { id: conversation.id },
          select: { state: true, version: true, currentStoryId: true },
        }),
      ).toEqual({
        state: ConversationState.IDLE,
        version: 0,
        currentStoryId: null,
      });
      expect(
        await prisma.auditLog.count({ where: { entityId: conversation.id } }),
      ).toBe(0);
    }
  });

  it("allows exactly one of 20 identical CAS contenders", async () => {
    const owner = await reporter();
    const story = await prisma.story.create({ data: { reporterId: owner.id } });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.AWAITING_HEADLINE,
        currentStoryId: story.id,
      },
    });
    const pool = await clients(20);
    try {
      const results = await Promise.all(
        pool.map((client) =>
          new ConversationStateMachineService(client).transition({
            conversationId: conversation.id,
            reporterId: owner.id,
            expectedState: ConversationState.AWAITING_HEADLINE,
            expectedVersion: 0,
            targetState: ConversationState.AWAITING_BODY,
            storyMutation: { kind: "PRESERVE" },
          }),
        ),
      );
      expect(
        results.filter(({ outcome }) => outcome === "TRANSITIONED"),
      ).toHaveLength(1);
      expect(results.filter(({ outcome }) => outcome === "STALE")).toHaveLength(
        19,
      );
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
          })
        ).version,
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            eventType: REPORTER_WORKFLOW_AUDIT.CONVERSATION_TRANSITIONED,
            entityId: conversation.id,
          },
        }),
      ).toBe(1);
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("allows exactly one of 20 conflicting valid CAS contenders and isolates Reporters", async () => {
    const ownerA = await reporter();
    const ownerB = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: ownerA.id },
    });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: ownerA.id,
        state: ConversationState.AWAITING_APPROVAL,
        currentStoryId: story.id,
      },
    });
    const machine = new ConversationStateMachineService(prisma);
    await expect(
      machine.transition({
        conversationId: conversation.id,
        reporterId: ownerB.id,
        expectedState: ConversationState.AWAITING_APPROVAL,
        expectedVersion: 0,
        targetState: ConversationState.PUBLISHING,
        storyMutation: { kind: "PRESERVE" },
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_NOT_OWNED" });
    const pool = await clients(20);
    try {
      const results = await Promise.all(
        pool.map((client, index) =>
          new ConversationStateMachineService(client).transition({
            conversationId: conversation.id,
            reporterId: ownerA.id,
            expectedState: ConversationState.AWAITING_APPROVAL,
            expectedVersion: 0,
            targetState:
              index % 2 === 0
                ? ConversationState.PUBLISHING
                : ConversationState.COLLECTING_MEDIA,
            storyMutation: { kind: "PRESERVE" },
          }),
        ),
      );
      expect(
        results.filter(({ outcome }) => outcome === "TRANSITIONED"),
      ).toHaveLength(1);
      expect(results.filter(({ outcome }) => outcome === "STALE")).toHaveLength(
        19,
      );
      expect(
        (
          await prisma.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
          })
        ).version,
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            eventType: REPORTER_WORKFLOW_AUDIT.CONVERSATION_TRANSITIONED,
            entityId: conversation.id,
          },
        }),
      ).toBe(1);
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("serializes authorisation with status changes and never lets a Conversation bypass inactivity", async () => {
    const owner = await reporter();
    await prisma.conversation.create({ data: { reporterId: owner.id } });
    const event = await inbound(owner.phoneNumber, "status-race");
    const statusService = new ReporterProvisioningService(prisma);
    const [processing, statusChange] = await Promise.allSettled([
      processor(prisma).process(event.id),
      statusService.deactivate(owner.phoneNumber),
    ]);
    expect(statusChange.status).toBe("fulfilled");
    expect(processing.status).toBe("fulfilled");
    expect(
      (await prisma.reporter.findUniqueOrThrow({ where: { id: owner.id } }))
        .status,
    ).toBe(ReporterStatus.INACTIVE);
    if (processing.status === "fulfilled")
      expect(["PROCESSED", "IGNORED"]).toContain(processing.value.outcome);
    const later = await inbound(owner.phoneNumber, "after-deactivate");
    await expect(processor(prisma).process(later.id)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "REPORTER_INACTIVE",
    });
  });

  it("allocates non-overlapping same-sender ranges across 20 concurrent ingestion transactions", async () => {
    const sender = phone();
    const pool = await clients(20);
    try {
      await Promise.all(
        pool.map((client, index) =>
          new WhatsappWebhookIngestionService(client).persist(
            batch([normalized(sender, `same-sender-${index}`)]),
          ),
        ),
      );
      const rows = await prisma.inboundEvent.findMany({
        where: { senderPhone: sender },
        orderBy: { senderIngestSequence: "asc" },
        select: { senderIngestSequence: true },
      });
      expect(
        rows.map(({ senderIngestSequence }) => senderIngestSequence),
      ).toEqual(Array.from({ length: 20 }, (_, index) => BigInt(index)));
      expect(
        await prisma.inboundSenderSequence.findUniqueOrThrow({
          where: { senderPhone: sender },
          select: { nextValue: true },
        }),
      ).toEqual({ nextValue: 20n });
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("preserves retained traversal order and permits provider-replay reservation gaps", async () => {
    const sender = phone();
    const service = new WhatsappWebhookIngestionService(prisma);
    const first = normalized(sender, "gap-replay-first");
    const afterDuplicate = normalized(sender, "gap-replay-after-duplicate");
    await service.persist(batch([first]));
    await service.persist(batch([first, afterDuplicate]));
    const rows = await prisma.inboundEvent.findMany({
      where: { senderPhone: sender },
      orderBy: { senderIngestSequence: "asc" },
      select: { providerMessageId: true, senderIngestSequence: true },
    });
    expect(rows).toEqual([
      { providerMessageId: first.providerMessageId, senderIngestSequence: 0n },
      {
        providerMessageId: afterDuplicate.providerMessageId,
        senderIngestSequence: 2n,
      },
    ]);
    expect(
      await prisma.inboundSenderSequence.findUniqueOrThrow({
        where: { senderPhone: sender },
        select: { nextValue: true },
      }),
    ).toEqual({ nextValue: 3n });

    const orderedSender = phone();
    const ordered = [
      normalized(orderedSender, "traversal-a"),
      normalized(orderedSender, "traversal-b"),
      normalized(orderedSender, "traversal-c"),
    ];
    await service.persist(batch(ordered));
    expect(
      await prisma.inboundEvent.findMany({
        where: { senderPhone: orderedSender },
        orderBy: { senderIngestSequence: "asc" },
        select: { providerMessageId: true, senderIngestSequence: true },
      }),
    ).toEqual(
      ordered.map(({ providerMessageId }, index) => ({
        providerMessageId,
        senderIngestSequence: BigInt(index),
      })),
    );
  });

  it("keeps sender cursors independent and avoids reversed multi-sender deadlocks", async () => {
    const senderA = phone();
    const senderB = phone();
    const pool = await clients(2);
    try {
      await Promise.all([
        new WhatsappWebhookIngestionService(pool[0]!).persist(
          batch([
            normalized(senderB, "reverse-b-first"),
            normalized(senderA, "reverse-a-second"),
          ]),
        ),
        new WhatsappWebhookIngestionService(pool[1]!).persist(
          batch([
            normalized(senderA, "forward-a-first"),
            normalized(senderB, "forward-b-second"),
          ]),
        ),
      ]);
      for (const senderPhone of [senderA, senderB]) {
        const values = await prisma.inboundEvent.findMany({
          where: { senderPhone },
          orderBy: { senderIngestSequence: "asc" },
          select: { senderIngestSequence: true },
        });
        expect(
          values.map(({ senderIngestSequence }) => senderIngestSequence),
        ).toEqual([0n, 1n]);
      }
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("rolls back every cursor when a later sender makes event insertion fail", async () => {
    const senderA = phone();
    const invalidSenderB = `+${"9".repeat(16)}`;
    const service = new WhatsappWebhookIngestionService(prisma);
    await expect(
      service.persist(
        batch([
          normalized(senderA, "rollback-a"),
          normalized(invalidSenderB, "rollback-b"),
        ]),
      ),
    ).rejects.toThrow("Webhook persistence unavailable.");
    expect(
      await prisma.inboundEvent.count({ where: { senderPhone: senderA } }),
    ).toBe(0);
    expect(
      await prisma.inboundSenderSequence.count({
        where: { senderPhone: { in: [senderA, invalidSenderB] } },
      }),
    ).toBe(0);
    await expect(
      service.persist(batch([normalized(senderA, "rollback-safe-retry")])),
    ).resolves.toEqual({ inserted: 1 });
    expect(
      await prisma.inboundEvent.findFirstOrThrow({
        where: { senderPhone: senderA },
        select: { senderIngestSequence: true },
      }),
    ).toEqual({ senderIngestSequence: 0n });
  });

  it("rolls back a reserved range when event insertion fails", async () => {
    const sender = phone();
    const service = new WhatsappWebhookIngestionService(prisma);
    const invalid = normalized(sender, "post-reservation-failure");
    invalid.providerMessageId = "x".repeat(192);
    await expect(service.persist(batch([invalid]))).rejects.toThrow(
      "Webhook persistence unavailable.",
    );
    expect(
      await prisma.inboundEvent.count({ where: { senderPhone: sender } }),
    ).toBe(0);
    expect(
      await prisma.inboundSenderSequence.count({
        where: { senderPhone: sender },
      }),
    ).toBe(0);
    await service.persist(
      batch([normalized(sender, "post-reservation-retry")]),
    );
    expect(
      await prisma.inboundEvent.findFirstOrThrow({
        where: { senderPhone: sender },
        select: { senderIngestSequence: true },
      }),
    ).toEqual({ senderIngestSequence: 0n });
  });

  it.each([
    InboundProcessingStatus.RECEIVED,
    InboundProcessingStatus.PROCESSING,
  ])("blocks a successor while its predecessor is %s", async (status) => {
    const sender = phone();
    const earlier = await inbound(sender, `blocked-earlier-${status}`);
    await prisma.inboundEvent.update({
      where: { id: earlier.id },
      data: { processingStatus: status },
    });
    const later = await inbound(sender, `blocked-later-${status}`);
    await expect(processor(prisma).process(later.id)).resolves.toEqual({
      outcome: "ORDER_BLOCKED",
    });
    expect(
      await prisma.auditLog.count({ where: { inboundEventId: later.id } }),
    ).toBe(0);
  });

  it.each([
    InboundProcessingStatus.PROCESSED,
    InboundProcessingStatus.IGNORED,
    InboundProcessingStatus.FAILED,
  ])("allows a successor after a %s predecessor", async (status) => {
    const sender = phone();
    const earlier = await inbound(sender, `terminal-earlier-${status}`);
    await prisma.inboundEvent.update({
      where: { id: earlier.id },
      data: { processingStatus: status },
    });
    const later = await inbound(sender, `terminal-later-${status}`);
    await expect(processor(prisma).claim(later.id)).resolves.toEqual({
      outcome: "CLAIMED",
    });
  });

  it("claims across a persisted sequence gap", async () => {
    const sender = phone();
    await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: providerId("gap-zero"),
        senderPhone: sender,
        senderIngestSequence: 0n,
        eventType: InboundEventType.TEXT,
        rawPayload: { proof: "gap" },
        processingStatus: InboundProcessingStatus.PROCESSED,
      },
    });
    const later = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: providerId("gap-two"),
        senderPhone: sender,
        senderIngestSequence: 2n,
        eventType: InboundEventType.TEXT,
        rawPayload: { proof: "gap" },
      },
    });
    await expect(processor(prisma).claim(later.id)).resolves.toEqual({
      outcome: "CLAIMED",
    });
  });

  it("serializes adjacent claims and orders unknown-Reporter terminal handling", async () => {
    const sender = phone();
    const first = await inbound(sender, "adjacent-first");
    const second = await inbound(sender, "adjacent-second");
    const pool = await clients(2);
    try {
      const results = await Promise.all([
        processor(pool[0]!).claim(first.id),
        processor(pool[1]!).claim(second.id),
      ]);
      expect(
        results.filter(({ outcome }) => outcome === "CLAIMED"),
      ).toHaveLength(1);
      expect(await processor(prisma).process(second.id)).toEqual({
        outcome: "ORDER_BLOCKED",
      });
      await prisma.inboundEvent.update({
        where: { id: first.id },
        data: {
          processingStatus: InboundProcessingStatus.RECEIVED,
          processingStartedAt: null,
          processingAttempts: 0,
        },
      });
      await expect(processor(prisma).process(first.id)).resolves.toEqual({
        outcome: "IGNORED",
        reason: "REPORTER_UNKNOWN",
      });
      await expect(processor(prisma).process(second.id)).resolves.toEqual({
        outcome: "IGNORED",
        reason: "REPORTER_UNKNOWN",
      });
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });
});
