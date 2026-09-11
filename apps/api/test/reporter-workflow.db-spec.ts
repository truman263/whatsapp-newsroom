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

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required; this suite never reads .env");
jest.setTimeout(120_000);

const prisma = new PrismaService();
const run = Date.now().toString().slice(-8);
let sequence = 0;
const phone = (): string => `+2637${run}${String(sequence++).padStart(2, "0")}`;
const providerId = (name: string): string =>
  `round4b:${run}:${name}:${sequence++}`;

async function reset(): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE TABLE "Approval", "AuditLog", "StoryCategory", "StoryMedia", "OutboundMessage", "PublishAttempt", "Conversation", "InboundEvent", "Story", "EditorialCategory", "Reporter" CASCADE
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
      reporterId,
      eventType: InboundEventType.TEXT,
      rawPayload: { proof: "round4b" },
    },
  });
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
});
