import { createHash, randomUUID } from "node:crypto";
import {
  ConversationState,
  EditorialCategoryStatus,
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Provider,
  ReporterStatus,
  StoryStatus,
  type Conversation,
  type InboundEvent,
  type Prisma,
  type Reporter,
  type Story,
} from "@prisma/client";
import { runReporterCli } from "../src/commands/reporter-cli";
import { PrismaService } from "../src/database/prisma.service";
import { MEDIA_STAGING_AUDIT } from "../src/modules/media-staging/media-staging.audit";
import { MediaStagingError } from "../src/modules/media-staging/media-staging.errors";
import { MediaStagingService } from "../src/modules/media-staging/media-staging.service";
import {
  mediaObjectKey,
  type DownloadedMedia,
  type MediaAuthority,
  type MediaObjectStore,
  type MediaProviderClient,
  type StoredObjectHead,
} from "../src/modules/media-staging/media-staging.types";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import {
  IGNORED_REASON,
  REPORTER_WORKFLOW_AUDIT,
} from "../src/modules/reporter-workflow/reporter-workflow.audit";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ReporterProvisioningService } from "../src/modules/reporter-workflow/reporter-provisioning.service";
import { ReporterWorkflowError } from "../src/modules/reporter-workflow/reporter-workflow.errors";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import { StoryCompletenessService } from "../src/modules/story-collection/story-completeness.service";
import { STORY_COLLECTION_AUDIT } from "../src/modules/story-collection/story-collection.audit";
import type { ParsedStoredEvent } from "../src/modules/story-collection/story-collection.types";
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
const stagedObjects = new Map<string, DownloadedMedia>();

class ProofMediaProvider implements MediaProviderClient {
  fetch(authority: MediaAuthority): Promise<DownloadedMedia> {
    const bytes =
      authority.mimeType === "image/png"
        ? Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])
        : Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    return Promise.resolve({
      bytes,
      mimeType: authority.mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

class ProofObjectStore implements MediaObjectStore {
  putIfAbsent(
    key: string,
    media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS"> {
    if (stagedObjects.has(key)) return Promise.resolve("EXISTS");
    stagedObjects.set(key, media);
    return Promise.resolve("CREATED");
  }
  head(key: string): Promise<StoredObjectHead | null> {
    const media = stagedObjects.get(key);
    return Promise.resolve(
      media
        ? { size: media.size, sha256: media.sha256, mimeType: media.mimeType }
        : null,
    );
  }
  read(key: string): Promise<Buffer> {
    const media = stagedObjects.get(key);
    if (!media) return Promise.reject(new Error("missing"));
    return Promise.resolve(media.bytes);
  }
}
const phone = (): string => `+2637${run}${String(sequence++).padStart(2, "0")}`;
const providerId = (name: string): string =>
  `round4b:${run}:${name}:${sequence++}`;

async function reset(): Promise<void> {
  stagedObjects.clear();
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
  const providerMessageId = providerId(name);
  const timestamp = "1760000000";
  return prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      senderPhone,
      senderIngestSequence: ingestSequence++,
      reporterId,
      eventType: InboundEventType.TEXT,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: senderPhone.slice(1),
          timestamp,
          type: "text",
          text: { body: name === "active" ? "/story" : "not a story command" },
        },
      },
      providerOccurredAt: new Date(Number(timestamp) * 1000),
    },
  });
}

async function storedEvent(
  senderPhone: string,
  name: string,
  eventType: InboundEventType,
  message: Record<string, unknown>,
): Promise<InboundEvent> {
  const providerMessageId = providerId(name);
  const timestamp = "1760000000";
  return prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      senderPhone,
      senderIngestSequence: ingestSequence++,
      eventType,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: senderPhone.slice(1),
          timestamp,
          type: eventType.toLowerCase(),
          ...message,
        },
      },
      providerOccurredAt: new Date(Number(timestamp) * 1000),
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
  const stateMachine = new ConversationStateMachineService(client);
  return new InboundEventProcessingService(
    client,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
    new StoredWhatsappEventParser(),
    new StoryEventProcessor(stateMachine),
    new MediaStagingService(
      client,
      new ProofMediaProvider(),
      new ProofObjectStore(),
    ),
  );
}

function storyProcessor(client: PrismaService): StoryEventProcessor {
  return new StoryEventProcessor(new ConversationStateMachineService(client));
}

async function provenance(
  owner: Reporter,
  name: string,
): Promise<InboundEvent> {
  const event = await storedEvent(
    owner.phoneNumber,
    name,
    InboundEventType.TEXT,
    {
      text: { body: name },
    },
  );
  return prisma.inboundEvent.update({
    where: { id: event.id },
    data: { reporterId: owner.id },
  });
}

async function directRace(
  owner: Reporter,
  conversation: { id: string; state: ConversationState; version: number },
  expectedStoryVersion: number | null,
  parsed: (index: number) => ParsedStoredEvent,
): Promise<PromiseSettledResult<unknown>[]> {
  const events = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      provenance(owner, `direct-${Date.now()}-${index}`),
    ),
  );
  const pool = await clients(20);
  try {
    return await Promise.allSettled(
      pool.map((client, index) =>
        client.$transaction((tx) =>
          storyProcessor(client).process(tx, {
            eventId: events[index]!.id,
            reporterId: owner.id,
            conversationId: conversation.id,
            conversationState: conversation.state,
            conversationVersion: conversation.version,
            expectedStoryVersion,
            parsed: parsed(index),
          }),
        ),
      ),
    );
  } finally {
    await Promise.all(pool.map((client) => client.$disconnect()));
  }
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
    }).toEqual({ ...before, story: before.story + 1 });
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

  it("collects a Story, headline, body, categories, and preserves the byline snapshot", async () => {
    const owner = await prisma.reporter.create({
      data: {
        phoneNumber: phone(),
        displayName: "Display Byline",
        editorialByline: "  Editorial Byline  ",
      },
    });
    const start = await storedEvent(
      owner.phoneNumber,
      "story-start",
      InboundEventType.TEXT,
      {
        text: { body: "/story" },
      },
    );
    await expect(processor(prisma).process(start.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { reporterId: owner.id },
    });
    const storyId = conversation.currentStoryId!;
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: storyId } }),
    ).toMatchObject({
      status: StoryStatus.COLLECTING,
      version: 0,
      headline: null,
      body: null,
      byline: "Editorial Byline",
    });
    await prisma.reporter.update({
      where: { id: owner.id },
      data: { displayName: "Changed", editorialByline: "Changed Byline" },
    });
    const headline = await storedEvent(
      owner.phoneNumber,
      "headline",
      InboundEventType.TEXT,
      {
        text: { body: "  A newsroom headline  " },
      },
    );
    await expect(processor(prisma).process(headline.id)).resolves.toMatchObject(
      { outcome: "PROCESSED" },
    );
    const bodyEvent = await storedEvent(
      owner.phoneNumber,
      "body",
      InboundEventType.TEXT,
      {
        text: { body: "  First paragraph\r\n\r\nSecond paragraph  " },
      },
    );
    await expect(
      processor(prisma).process(bodyEvent.id),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    const categories = await Promise.all([
      prisma.editorialCategory.create({
        data: {
          wordpressCategoryId: 51001n,
          name: "Politics",
          slug: "sample-politics",
        },
      }),
      prisma.editorialCategory.create({
        data: {
          wordpressCategoryId: 51002n,
          name: "Business",
          slug: "sample-business",
        },
      }),
    ]);
    const categoryEvent = await storedEvent(
      owner.phoneNumber,
      "categories",
      InboundEventType.TEXT,
      {
        text: {
          body: "/categories Sample-Politics, sample-business,sample-politics",
        },
      },
    );
    await expect(
      processor(prisma).process(categoryEvent.id),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: storyId } }),
    ).toMatchObject({
      headline: "A newsroom headline",
      body: "First paragraph\n\nSecond paragraph",
      byline: "Editorial Byline",
      version: 3,
    });
    expect(
      await prisma.storyCategory.findMany({
        where: { storyId },
        orderBy: { categoryId: "asc" },
      }),
    ).toHaveLength(2);
    const noOp = await storedEvent(
      owner.phoneNumber,
      "categories-noop",
      InboundEventType.TEXT,
      {
        text: { body: "/categories sample-business,sample-politics" },
      },
    );
    await processor(prisma).process(noOp.id);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: storyId } }))
        .version,
    ).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId,
          eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
        },
      }),
    ).toBe(1);
    expect(categories).toHaveLength(2);
  });

  it("fails malformed retained evidence without creating a Conversation", async () => {
    const owner = await reporter();
    const event = await inbound(owner.phoneNumber, "malformed-story");
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: { rawPayload: { message: { id: "wrong" } } },
    });
    await expect(processor(prisma).process(event.id)).resolves.toEqual({
      outcome: "FAILED",
      reason: "MALFORMED_STORED_EVENT",
    });
    expect(
      await prisma.conversation.count({ where: { reporterId: owner.id } }),
    ).toBe(0);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: {
          processingStatus: true,
          lastErrorCode: true,
          lastErrorMessage: true,
        },
      }),
    ).toEqual({
      processingStatus: InboundProcessingStatus.FAILED,
      lastErrorCode: "MALFORMED_STORED_EVENT",
      lastErrorMessage: null,
    });
  });

  it("fails the malformed stored-evidence matrix terminally without domain writes", async () => {
    type MalformedCase = {
      name: string;
      eventType: InboundEventType;
      payload: (event: InboundEvent, owner: Reporter) => Prisma.InputJsonValue;
    };
    const message = (
      event: InboundEvent,
      owner: Reporter,
      value: Record<string, Prisma.JsonValue>,
    ): Prisma.InputJsonValue => ({
      message: {
        id: event.providerMessageId,
        from: owner.phoneNumber.slice(1),
        timestamp: "1760000000",
        type: event.eventType.toLowerCase(),
        ...value,
      },
    });
    const text = { text: { body: "evidence" } };
    const interactive = {
      interactive: {
        type: "button_reply",
        button_reply: { id: "unsupported:v1", title: "ignored title" },
      },
    };
    const image = {
      image: { id: "opaque.media:1", mime_type: "image/jpeg" },
    };
    const cases: MalformedCase[] = [
      {
        name: "payload-array",
        eventType: InboundEventType.TEXT,
        payload: () => [],
      },
      {
        name: "message-missing",
        eventType: InboundEventType.TEXT,
        payload: () => ({}),
      },
      {
        name: "message-null",
        eventType: InboundEventType.TEXT,
        payload: () => ({ message: null }),
      },
      {
        name: "id-missing",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { id: null, ...text }),
      },
      {
        name: "id-mismatch",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { id: "wrong", ...text }),
      },
      {
        name: "from-missing",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { from: null, ...text }),
      },
      {
        name: "sender-mismatch",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { from: "263700000000", ...text }),
      },
      {
        name: "timestamp-missing",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { timestamp: null, ...text }),
      },
      {
        name: "timestamp-invalid",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { timestamp: "invalid", ...text }),
      },
      {
        name: "timestamp-mismatch",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { timestamp: "1760000001", ...text }),
      },
      {
        name: "type-mismatch",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { type: "image", ...text }),
      },
      {
        name: "text-missing",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, {}),
      },
      {
        name: "text-null",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { text: null }),
      },
      {
        name: "body-missing",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { text: {} }),
      },
      {
        name: "body-non-string",
        eventType: InboundEventType.TEXT,
        payload: (e, o) => message(e, o, { text: { body: 7 } }),
      },
      {
        name: "interactive-missing",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) => message(e, o, {}),
      },
      {
        name: "interactive-null",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) => message(e, o, { interactive: null }),
      },
      {
        name: "interactive-type",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) => message(e, o, { interactive: { type: "bad" } }),
      },
      {
        name: "button-absent",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, { interactive: { type: "button_reply" } }),
      },
      {
        name: "list-absent",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, { interactive: { type: "list_reply" } }),
      },
      {
        name: "reply-null",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, {
            interactive: { type: "button_reply", button_reply: null },
          }),
      },
      {
        name: "reply-id-missing",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, {
            interactive: { type: "button_reply", button_reply: {} },
          }),
      },
      {
        name: "reply-id-non-string",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, {
            interactive: { type: "button_reply", button_reply: { id: 1 } },
          }),
      },
      {
        name: "reply-contradictory",
        eventType: InboundEventType.INTERACTIVE,
        payload: (e, o) =>
          message(e, o, {
            interactive: {
              type: "button_reply",
              button_reply: { id: "a" },
              list_reply: { id: "b" },
            },
          }),
      },
      {
        name: "image-missing",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) => message(e, o, {}),
      },
      {
        name: "image-null",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) => message(e, o, { image: null }),
      },
      {
        name: "media-id-missing",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { mime_type: "image/jpeg" } }),
      },
      {
        name: "media-id-blank",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { id: "", mime_type: "image/jpeg" } }),
      },
      {
        name: "media-id-long",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, {
            image: { id: "a".repeat(192), mime_type: "image/jpeg" },
          }),
      },
      {
        name: "media-id-slash",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { id: "a/b", mime_type: "image/jpeg" } }),
      },
      {
        name: "media-id-control",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { id: "a\u0001b", mime_type: "image/jpeg" } }),
      },
      {
        name: "mime-missing",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) => message(e, o, { image: { id: "opaque" } }),
      },
      {
        name: "mime-unsupported",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, {
            image: { id: "opaque", mime_type: "image/svg+xml" },
          }),
      },
      {
        name: "sha-invalid",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { ...image.image, sha256: "not-base64" } }),
      },
      {
        name: "sha-wrong-size",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, {
            image: {
              ...image.image,
              sha256: Buffer.alloc(31).toString("base64"),
            },
          }),
      },
      {
        name: "caption-non-string",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, { image: { ...image.image, caption: 4 } }),
      },
      {
        name: "caption-too-long",
        eventType: InboundEventType.IMAGE,
        payload: (e, o) =>
          message(e, o, {
            image: { ...image.image, caption: "😀".repeat(4097) },
          }),
      },
    ];
    for (const malformedCase of cases) {
      const owner = await reporter();
      const event = await storedEvent(
        owner.phoneNumber,
        `malformed-${malformedCase.name}`,
        malformedCase.eventType,
        malformedCase.eventType === InboundEventType.TEXT
          ? text
          : malformedCase.eventType === InboundEventType.INTERACTIVE
            ? interactive
            : image,
      );
      await prisma.inboundEvent.update({
        where: { id: event.id },
        data: { rawPayload: malformedCase.payload(event, owner) },
      });
      const beforeAudits = await prisma.auditLog.count();
      const beforeMedia = await prisma.storyMedia.count();
      await expect(processor(prisma).process(event.id)).resolves.toEqual({
        outcome: "FAILED",
        reason: "MALFORMED_STORED_EVENT",
      });
      const terminal = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: {
          processingStatus: true,
          processedAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
        },
      });
      expect(terminal).toMatchObject({
        processingStatus: InboundProcessingStatus.FAILED,
        lastErrorCode: "MALFORMED_STORED_EVENT",
        lastErrorMessage: null,
      });
      expect(terminal.processedAt).toBeInstanceOf(Date);
      expect(
        await prisma.story.count({ where: { reporterId: owner.id } }),
      ).toBe(0);
      expect(await prisma.storyMedia.count()).toBe(beforeMedia);
      expect(await prisma.auditLog.count()).toBe(beforeAudits);
    }
  });

  it("accepts valid retained IMAGE and unsupported INTERACTIVE evidence only into fixed policy outcomes", async () => {
    for (const [eventType, evidence, reason] of [
      [
        InboundEventType.IMAGE,
        {
          image: {
            id: "opaque.media:valid",
            mime_type: "image/png",
            sha256: Buffer.alloc(32).toString("base64"),
            caption: "valid",
          },
        },
        "IMAGE_NOT_ACCEPTED_IN_STATE",
      ],
      [
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "unsupported:v1", title: "/story" },
          },
        },
        "UNSUPPORTED_INTERACTION",
      ],
    ] as const) {
      const owner = await reporter();
      const event = await storedEvent(
        owner.phoneNumber,
        `valid-policy-${eventType}`,
        eventType,
        evidence,
      );
      await expect(processor(prisma).process(event.id)).resolves.toMatchObject({
        outcome: "IGNORED",
        reason,
      });
      const terminal = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(terminal).toMatchObject({
        processingStatus: InboundProcessingStatus.IGNORED,
        lastErrorCode: reason,
        lastErrorMessage: null,
      });
      expect(terminal.processedAt).toBeInstanceOf(Date);
      expect(
        await prisma.storyMedia.count({
          where: { providerMediaId: "opaque.media:valid" },
        }),
      ).toBe(0);
    }
  });

  it("proves command interpretation across IDLE, headline, and body states", async () => {
    const owner = await reporter();
    const start = await storedEvent(
      owner.phoneNumber,
      "matrix-interactive-start",
      InboundEventType.INTERACTIVE,
      {
        interactive: {
          type: "button_reply",
          button_reply: {
            id: "newsroom:v1:story:start",
            title: "title is not authority",
          },
        },
      },
    );
    await expect(processor(prisma).process(start.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { reporterId: owner.id },
    });
    const storyId = conversation.currentStoryId!;
    const headline = await storedEvent(
      owner.phoneNumber,
      "matrix-story-as-headline",
      InboundEventType.TEXT,
      { text: { body: "/story" } },
    );
    await expect(processor(prisma).process(headline.id)).resolves.toMatchObject(
      { outcome: "PROCESSED" },
    );
    const body = await storedEvent(
      owner.phoneNumber,
      "matrix-categories-as-body",
      InboundEventType.TEXT,
      { text: { body: "/categories politics" } },
    );
    await expect(processor(prisma).process(body.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: storyId } }),
    ).toMatchObject({
      headline: "/story",
      body: "/categories politics",
      version: 2,
    });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { reporterId: owner.id },
      }),
    ).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      currentStoryId: storyId,
    });
  });

  it("proves fixed ignored terminal policy throughout the Story state matrix", async () => {
    const cases = [
      [
        ConversationState.IDLE,
        InboundEventType.TEXT,
        { text: { body: "other" } },
        "STORY_START_REQUIRED",
      ],
      [
        ConversationState.IDLE,
        InboundEventType.TEXT,
        { text: { body: "/cancel" } },
        "STORY_START_REQUIRED",
      ],
      [
        ConversationState.IDLE,
        InboundEventType.TEXT,
        { text: { body: "/done" } },
        "CONTROL_NOT_ENABLED",
      ],
      [
        ConversationState.IDLE,
        InboundEventType.IMAGE,
        { image: { id: "idle-image", mime_type: "image/jpeg" } },
        "IMAGE_NOT_ACCEPTED_IN_STATE",
      ],
      [
        ConversationState.IDLE,
        InboundEventType.UNKNOWN,
        {},
        "UNSUPPORTED_EVENT_TYPE",
      ],
      [
        ConversationState.IDLE,
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "unsupported" },
          },
        },
        "UNSUPPORTED_INTERACTION",
      ],
      [
        ConversationState.AWAITING_HEADLINE,
        InboundEventType.IMAGE,
        { image: { id: "headline-image", mime_type: "image/jpeg" } },
        "IMAGE_NOT_ACCEPTED_IN_STATE",
      ],
      [
        ConversationState.AWAITING_HEADLINE,
        InboundEventType.UNKNOWN,
        {},
        "UNSUPPORTED_EVENT_TYPE",
      ],
      [
        ConversationState.AWAITING_HEADLINE,
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "unsupported" },
          },
        },
        "UNSUPPORTED_INTERACTION",
      ],
      [
        ConversationState.AWAITING_BODY,
        InboundEventType.IMAGE,
        { image: { id: "body-image", mime_type: "image/jpeg" } },
        "IMAGE_NOT_ACCEPTED_IN_STATE",
      ],
      [
        ConversationState.AWAITING_BODY,
        InboundEventType.UNKNOWN,
        {},
        "UNSUPPORTED_EVENT_TYPE",
      ],
      [
        ConversationState.AWAITING_BODY,
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "unsupported" },
          },
        },
        "UNSUPPORTED_INTERACTION",
      ],
      [
        ConversationState.COLLECTING_MEDIA,
        InboundEventType.TEXT,
        { text: { body: "/done" } },
        "CONTROL_NOT_ENABLED",
      ],
      [
        ConversationState.COLLECTING_MEDIA,
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "newsroom:v1:story:done" },
          },
        },
        "CONTROL_NOT_ENABLED",
      ],
      [
        ConversationState.COLLECTING_MEDIA,
        InboundEventType.TEXT,
        { text: { body: "other" } },
        "TEXT_NOT_ACCEPTED_IN_STATE",
      ],
      [
        ConversationState.COLLECTING_MEDIA,
        InboundEventType.UNKNOWN,
        {},
        "UNSUPPORTED_EVENT_TYPE",
      ],
      [
        ConversationState.COLLECTING_MEDIA,
        InboundEventType.INTERACTIVE,
        {
          interactive: {
            type: "button_reply",
            button_reply: { id: "unsupported" },
          },
        },
        "UNSUPPORTED_INTERACTION",
      ],
    ] as const;
    for (const [state, eventType, evidence, reason] of cases) {
      const owner = await reporter();
      const story =
        state === ConversationState.IDLE
          ? null
          : await prisma.story.create({
              data: { reporterId: owner.id, byline: "Matrix" },
            });
      const conversation = await prisma.conversation.create({
        data: {
          reporterId: owner.id,
          state,
          currentStoryId: story?.id,
        },
      });
      const event = await storedEvent(
        owner.phoneNumber,
        `state-${state}-${eventType}-${reason}`,
        eventType,
        evidence,
      );
      const result = await processor(prisma).process(event.id);
      expect(result).toMatchObject({ outcome: "IGNORED", reason });
      const terminal = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(terminal).toMatchObject({
        processingStatus: InboundProcessingStatus.IGNORED,
        lastErrorCode: reason,
        lastErrorMessage: null,
      });
      expect(terminal.processedAt).toBeInstanceOf(Date);
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        }),
      ).toMatchObject({ state, version: conversation.version });
      if (story) {
        expect(
          await prisma.story.findUniqueOrThrow({ where: { id: story.id } }),
        ).toMatchObject({ version: 0, status: StoryStatus.COLLECTING });
      }
      expect(
        await prisma.storyMedia.count({
          where: {
            storyId: story?.id ?? "00000000-0000-0000-0000-000000000000",
          },
        }),
      ).toBe(0);
    }
  });

  it.each([
    ConversationState.AWAITING_HEADLINE,
    ConversationState.AWAITING_BODY,
    ConversationState.COLLECTING_MEDIA,
  ])("cancels atomically from %s", async (state) => {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Byline" },
    });
    await prisma.conversation.create({
      data: { reporterId: owner.id, state, currentStoryId: story.id },
    });
    const event = await storedEvent(
      owner.phoneNumber,
      `cancel-${state}`,
      InboundEventType.TEXT,
      {
        text: { body: "/cancel" },
      },
    );
    await expect(processor(prisma).process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const cancelled = await prisma.story.findUniqueOrThrow({
      where: { id: story.id },
    });
    expect(cancelled).toMatchObject({
      status: StoryStatus.CANCELLED,
      version: 1,
    });
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { reporterId: owner.id },
      }),
    ).toMatchObject({
      state: ConversationState.IDLE,
      currentStoryId: null,
    });
  });

  it("validates completeness without mutations for zero or valid fetched media", async () => {
    const owner = await reporter();
    const category = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 52001n, name: "Complete", slug: "complete" },
    });
    const story = await prisma.story.create({
      data: {
        reporterId: owner.id,
        headline: "Headline",
        body: "Body",
        byline: "Byline",
      },
    });
    await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });
    const completeness = new StoryCompletenessService(prisma);
    await expect(completeness.isComplete(owner.id, story.id)).resolves.toBe(
      true,
    );
    const media = await prisma.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: providerId("complete-media"),
        mediaType: "IMAGE",
        status: MediaProcessingStatus.RECEIVED,
        position: 0,
      },
    });
    await expect(completeness.isComplete(owner.id, story.id)).resolves.toBe(
      false,
    );
    await prisma.storyMedia.update({
      where: { id: media.id },
      data: {
        status: MediaProcessingStatus.FETCHED,
        mimeType: "image/jpeg",
        fileSizeBytes: 1n,
        sha256: "a".repeat(64),
      },
    });
    await expect(completeness.isComplete(owner.id, story.id)).resolves.toBe(
      true,
    );
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .status,
    ).toBe(StoryStatus.COLLECTING);
    await prisma.editorialCategory.update({
      where: { id: category.id },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    await expect(completeness.isComplete(owner.id, story.id)).resolves.toBe(
      true,
    );
  });

  it("allows exactly one of 20 direct Story starts and commits no orphan losers", async () => {
    const owner = await reporter();
    const conversation = await prisma.conversation.create({
      data: { reporterId: owner.id },
    });
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storedEvent(
          owner.phoneNumber,
          `direct-start-${index}`,
          InboundEventType.TEXT,
          {
            text: { body: "/story" },
          },
        ),
      ),
    );
    await prisma.inboundEvent.updateMany({
      where: { id: { in: events.map(({ id }) => id) } },
      data: { reporterId: owner.id },
    });
    const pool = await clients(20);
    try {
      const results = await Promise.allSettled(
        pool.map((client, index) =>
          client.$transaction((tx) =>
            new StoryEventProcessor(
              new ConversationStateMachineService(client),
            ).process(tx, {
              eventId: events[index]!.id,
              reporterId: owner.id,
              conversationId: conversation.id,
              conversationState: ConversationState.IDLE,
              conversationVersion: 0,
              expectedStoryVersion: null,
              parsed: { kind: "TEXT", text: "/story" },
            }),
          ),
        ),
      );
      expect(
        results.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await prisma.story.count({ where: { reporterId: owner.id } }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            reporterId: owner.id,
            eventType: STORY_COLLECTION_AUDIT.STORY_CREATED,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        }),
      ).toMatchObject({
        state: ConversationState.AWAITING_HEADLINE,
        version: 1,
      });
    } finally {
      await Promise.all(pool.map((client) => client.$disconnect()));
    }
  });

  it("awards one direct winner for headline, body, categories, and cancellation", async () => {
    const headlineOwner = await reporter();
    const headlineStory = await prisma.story.create({
      data: { reporterId: headlineOwner.id, byline: "Byline" },
    });
    const headlineConversation = await prisma.conversation.create({
      data: {
        reporterId: headlineOwner.id,
        state: ConversationState.AWAITING_HEADLINE,
        currentStoryId: headlineStory.id,
      },
    });
    const headlineResults = await directRace(
      headlineOwner,
      headlineConversation,
      0,
      (index) => ({ kind: "TEXT", text: `Headline ${index}` }),
    );
    expect(
      headlineResults.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: headlineStory.id } }),
    ).toMatchObject({ version: 1 });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: headlineConversation.id },
      }),
    ).toMatchObject({ state: ConversationState.AWAITING_BODY, version: 1 });
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: headlineStory.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_HEADLINE_SET,
        },
      }),
    ).toBe(1);

    const bodyOwner = await reporter();
    const bodyStory = await prisma.story.create({
      data: {
        reporterId: bodyOwner.id,
        byline: "Byline",
        headline: "Headline",
      },
    });
    const bodyConversation = await prisma.conversation.create({
      data: {
        reporterId: bodyOwner.id,
        state: ConversationState.AWAITING_BODY,
        currentStoryId: bodyStory.id,
      },
    });
    const bodyResults = await directRace(
      bodyOwner,
      bodyConversation,
      0,
      (index) => ({ kind: "TEXT", text: `Body ${index}` }),
    );
    expect(
      bodyResults.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: bodyStory.id } }),
    ).toMatchObject({ version: 1 });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: bodyConversation.id },
      }),
    ).toMatchObject({ state: ConversationState.COLLECTING_MEDIA, version: 1 });
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: bodyStory.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_BODY_SET,
        },
      }),
    ).toBe(1);

    const categoryOwner = await reporter();
    const categoryStory = await prisma.story.create({
      data: { reporterId: categoryOwner.id, byline: "Byline" },
    });
    const categoryConversation = await prisma.conversation.create({
      data: {
        reporterId: categoryOwner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: categoryStory.id,
      },
    });
    const categoryRows = await Promise.all(
      [0, 1, 2].map((index) =>
        prisma.editorialCategory.create({
          data: {
            wordpressCategoryId: 53000n + BigInt(index),
            name: `Race ${index}`,
            slug: `race-${index}`,
          },
        }),
      ),
    );
    const categoryResults = await directRace(
      categoryOwner,
      categoryConversation,
      0,
      (index) => ({
        kind: "TEXT",
        text: `/categories race-${index % categoryRows.length}`,
      }),
    );
    expect(
      categoryResults.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        await prisma.story.findUniqueOrThrow({
          where: { id: categoryStory.id },
        })
      ).version,
    ).toBe(1);
    expect(
      await prisma.storyCategory.count({
        where: { storyId: categoryStory.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: categoryStory.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
        },
      }),
    ).toBe(1);

    const cancelOwner = await reporter();
    const cancelStory = await prisma.story.create({
      data: { reporterId: cancelOwner.id, byline: "Byline" },
    });
    const cancelConversation = await prisma.conversation.create({
      data: {
        reporterId: cancelOwner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: cancelStory.id,
      },
    });
    const cancelResults = await directRace(
      cancelOwner,
      cancelConversation,
      0,
      () => ({ kind: "TEXT", text: "/cancel" }),
    );
    expect(
      cancelResults.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: cancelStory.id } }),
    ).toMatchObject({ status: StoryStatus.CANCELLED, version: 1 });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: cancelConversation.id },
      }),
    ).toMatchObject({
      state: ConversationState.IDLE,
      currentStoryId: null,
      version: 1,
    });
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: cancelStory.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_CANCELLED,
        },
      }),
    ).toBe(1);
  });

  it("rolls back post-write Story operations when the transaction fails", async () => {
    const owner = await reporter();
    const unassociated = await storedEvent(
      owner.phoneNumber,
      "rollback-provenance",
      InboundEventType.TEXT,
      { text: { body: "value" } },
    );
    const idle = await prisma.conversation.create({
      data: { reporterId: owner.id },
    });
    await expect(
      prisma.$transaction((tx) =>
        storyProcessor(prisma).process(tx, {
          eventId: unassociated.id,
          reporterId: owner.id,
          conversationId: idle.id,
          conversationState: ConversationState.IDLE,
          conversationVersion: 0,
          expectedStoryVersion: null,
          parsed: { kind: "TEXT", text: "/story" },
        }),
      ),
    ).rejects.toBeDefined();
    expect(await prisma.story.count({ where: { reporterId: owner.id } })).toBe(
      0,
    );
    expect(
      await prisma.conversation.findUniqueOrThrow({ where: { id: idle.id } }),
    ).toMatchObject({
      state: ConversationState.IDLE,
      version: 0,
      currentStoryId: null,
    });

    for (const operation of ["headline", "body", "cancel"] as const) {
      const state =
        operation === "headline"
          ? ConversationState.AWAITING_HEADLINE
          : operation === "body"
            ? ConversationState.AWAITING_BODY
            : ConversationState.COLLECTING_MEDIA;
      const story = await prisma.story.create({
        data: { reporterId: owner.id, byline: "Byline" },
      });
      await prisma.conversation.update({
        where: { id: idle.id },
        data: { state, currentStoryId: story.id, version: { increment: 1 } },
      });
      const before = await prisma.conversation.findUniqueOrThrow({
        where: { id: idle.id },
      });
      await expect(
        prisma.$transaction((tx) =>
          storyProcessor(prisma).process(tx, {
            eventId: unassociated.id,
            reporterId: owner.id,
            conversationId: idle.id,
            conversationState: before.state,
            conversationVersion: before.version,
            expectedStoryVersion: 0,
            parsed: {
              kind: "TEXT",
              text: operation === "cancel" ? "/cancel" : "New value",
            },
          }),
        ),
      ).rejects.toBeDefined();
      expect(
        await prisma.story.findUniqueOrThrow({ where: { id: story.id } }),
      ).toMatchObject({
        version: 0,
        status: StoryStatus.COLLECTING,
        headline: null,
        body: null,
        cancelledAt: null,
      });
      expect(
        await prisma.auditLog.count({ where: { storyId: story.id } }),
      ).toBe(0);
      await prisma.conversation.update({
        where: { id: idle.id },
        data: {
          state: ConversationState.IDLE,
          currentStoryId: null,
          version: { increment: 1 },
        },
      });
    }

    const category = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 54001n, name: "Rollback", slug: "rollback" },
    });
    const categoryStory = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Byline" },
    });
    const current = await prisma.conversation.update({
      where: { id: idle.id },
      data: {
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: categoryStory.id,
        version: { increment: 1 },
      },
    });
    const associated = await provenance(owner, "category-rollback");
    await expect(
      prisma.$transaction(async (tx) => {
        await storyProcessor(prisma).process(tx, {
          eventId: associated.id,
          reporterId: owner.id,
          conversationId: idle.id,
          conversationState: current.state,
          conversationVersion: current.version,
          expectedStoryVersion: 0,
          parsed: { kind: "TEXT", text: "/categories rollback" },
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");
    expect(
      (
        await prisma.story.findUniqueOrThrow({
          where: { id: categoryStory.id },
        })
      ).version,
    ).toBe(0);
    expect(
      await prisma.storyCategory.count({
        where: { storyId: categoryStory.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { storyId: categoryStory.id } }),
    ).toBe(0);
    expect(category.id).toBeDefined();
  });

  it("rejects every direct cross-Reporter Story mutation", async () => {
    const ownerA = await reporter();
    const ownerB = await reporter();
    const category = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 55001n, name: "Owned", slug: "owned" },
    });
    const operations = [
      [ConversationState.AWAITING_HEADLINE, { kind: "TEXT", text: "Headline" }],
      [ConversationState.AWAITING_BODY, { kind: "TEXT", text: "Body" }],
      [
        ConversationState.COLLECTING_MEDIA,
        { kind: "TEXT", text: "/categories owned" },
      ],
      [ConversationState.COLLECTING_MEDIA, { kind: "TEXT", text: "/cancel" }],
    ] as const;
    for (const [state, parsed] of operations) {
      const story = await prisma.story.create({
        data: { reporterId: ownerB.id, byline: "B" },
      });
      const conversation = await prisma.conversation.upsert({
        where: { reporterId: ownerB.id },
        create: { reporterId: ownerB.id, state, currentStoryId: story.id },
        update: { state, currentStoryId: story.id, version: { increment: 1 } },
      });
      const event = await provenance(ownerA, `cross-${state}-${parsed.text}`);
      await expect(
        prisma.$transaction((tx) =>
          storyProcessor(prisma).process(tx, {
            eventId: event.id,
            reporterId: ownerA.id,
            conversationId: conversation.id,
            conversationState: conversation.state,
            conversationVersion: conversation.version,
            expectedStoryVersion: 0,
            parsed,
          }),
        ),
      ).rejects.toBeDefined();
      expect(
        await prisma.story.findUniqueOrThrow({ where: { id: story.id } }),
      ).toMatchObject({
        version: 0,
        status: StoryStatus.COLLECTING,
        headline: null,
        body: null,
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          state: ConversationState.IDLE,
          currentStoryId: null,
          version: { increment: 1 },
        },
      });
    }
    expect(
      await prisma.storyCategory.count({ where: { categoryId: category.id } }),
    ).toBe(0);
  });

  it("exhaustively validates category inputs, replacement, no-op, and atomic rejection", async () => {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: {
        reporterId: owner.id,
        byline: "Matrix Byline",
        headline: "Matrix headline",
        body: "Matrix body",
      },
    });
    await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    const politics = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 58001n, name: "Politics", slug: "politics" },
    });
    const business = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 58002n, name: "Business", slug: "business" },
    });
    const inactive = await prisma.editorialCategory.create({
      data: {
        wordpressCategoryId: 58003n,
        name: "Inactive",
        slug: "inactive",
        status: EditorialCategoryStatus.INACTIVE,
      },
    });
    await Promise.all([
      prisma.editorialCategory.create({
        data: { wordpressCategoryId: 58004n, name: "Dup A", slug: "duplicate" },
      }),
      prisma.editorialCategory.create({
        data: { wordpressCategoryId: 58005n, name: "Dup B", slug: "duplicate" },
      }),
    ]);
    const submit = async (
      body: string,
    ): Promise<{
      event: InboundEvent;
      result: Awaited<ReturnType<InboundEventProcessingService["process"]>>;
      terminal: {
        processingStatus: InboundProcessingStatus;
        processedAt: Date | null;
        lastErrorCode: string | null;
        lastErrorMessage: string | null;
      };
    }> => {
      const event = await storedEvent(
        owner.phoneNumber,
        `category-${sequence}`,
        InboundEventType.TEXT,
        {
          text: { body },
        },
      );
      const result = await processor(prisma).process(event.id);
      const terminal = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: {
          processingStatus: true,
          processedAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
        },
      });
      return { event, result, terminal };
    };
    const categoryIds = async (): Promise<string[]> =>
      (
        await prisma.storyCategory.findMany({
          where: { storyId: story.id },
          orderBy: { categoryId: "asc" },
          select: { categoryId: true },
        })
      ).map(({ categoryId }) => categoryId);

    for (const body of [
      "/categories politics",
      "/categories Politics",
      "/categories \tpolitics\t",
      "/categories \u2003politics\u2003",
      "/categories politics,politics",
    ]) {
      const { result } = await submit(body);
      expect({ body, result }).toMatchObject({
        body,
        result: { outcome: "PROCESSED" },
      });
      expect(await categoryIds()).toEqual([politics.id]);
    }
    await submit("/categories Politics, business,politics");
    expect(await categoryIds()).toEqual([business.id, politics.id].sort());
    const resolvedCategories = await prisma.storyCategory.findMany({
      where: { storyId: story.id },
      include: { category: true },
    });
    expect(
      resolvedCategories.find(({ categoryId }) => categoryId === politics.id)
        ?.category.wordpressCategoryId,
    ).toBe(58001n);
    expect(
      resolvedCategories.find(({ categoryId }) => categoryId === business.id)
        ?.category.wordpressCategoryId,
    ).toBe(58002n);
    const noOpVersion = (
      await prisma.story.findUniqueOrThrow({ where: { id: story.id } })
    ).version;
    const noOpAudits = await prisma.auditLog.count({
      where: {
        storyId: story.id,
        eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
      },
    });
    for (const body of [
      "/categories politics,business",
      "/categories business,politics",
      "/categories Politics,Politics,Business",
      "/categories \tbusiness, politics\u2003",
    ]) {
      const { result } = await submit(body);
      expect(result.outcome).toBe("PROCESSED");
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(noOpVersion);
      expect(await categoryIds()).toEqual([business.id, politics.id].sort());
    }
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
        },
      }),
    ).toBe(noOpAudits);

    const invalid = [
      ["/categories unknown", "CATEGORY_NOT_FOUND"],
      ["/categories inactive", "CATEGORY_NOT_FOUND"],
      ["/categories duplicate", "CATEGORY_AMBIGUOUS"],
      ["/categories ", "INVALID_CATEGORY_COMMAND"],
      ["/categories ,culture", "INVALID_CATEGORY_COMMAND"],
      ["/categories culture,", "INVALID_CATEGORY_COMMAND"],
      ["/categories culture,,business", "INVALID_CATEGORY_COMMAND"],
      ["/categories breaking news", "INVALID_CATEGORY_COMMAND"],
      ["/categories bad!", "INVALID_CATEGORY_COMMAND"],
      ["/categories bad/slug", "INVALID_CATEGORY_COMMAND"],
      ["/categories bad\\slug", "INVALID_CATEGORY_COMMAND"],
      ["/categories bad\u0001slug", "INVALID_CATEGORY_COMMAND"],
      ["/categories política", "INVALID_CATEGORY_COMMAND"],
      [`/categories ${"a".repeat(201)}`, "INVALID_CATEGORY_COMMAND"],
      ["/categories Politics Desk", "INVALID_CATEGORY_COMMAND"],
      ["/categories politic", "CATEGORY_NOT_FOUND"],
      ["/categories politics trailing", "INVALID_CATEGORY_COMMAND"],
      ["/category politics", "TEXT_NOT_ACCEPTED_IN_STATE"],
      ["/categories", "TEXT_NOT_ACCEPTED_IN_STATE"],
      ["/categoriespolitics", "TEXT_NOT_ACCEPTED_IN_STATE"],
      ["/categories politics,unknown", "CATEGORY_NOT_FOUND"],
      ["/categories politics,inactive", "CATEGORY_NOT_FOUND"],
      ["/categories politics,duplicate", "CATEGORY_AMBIGUOUS"],
    ] as const;
    for (const [body, reason] of invalid) {
      const beforeVersion = (
        await prisma.story.findUniqueOrThrow({ where: { id: story.id } })
      ).version;
      const beforeIds = await categoryIds();
      const beforeAudits = await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
        },
      });
      const { result, terminal } = await submit(body);
      expect(result).toMatchObject({ outcome: "IGNORED", reason });
      expect(terminal).toMatchObject({
        processingStatus: InboundProcessingStatus.IGNORED,
        lastErrorCode: reason,
        lastErrorMessage: null,
      });
      expect(terminal.processedAt).toBeInstanceOf(Date);
      expect(terminal.lastErrorCode).not.toContain(body);
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(beforeVersion);
      expect(await categoryIds()).toEqual(beforeIds);
      expect(
        await prisma.auditLog.count({
          where: {
            storyId: story.id,
            eventType: STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
          },
        }),
      ).toBe(beforeAudits);
    }
    expect(inactive.status).toBe(EditorialCategoryStatus.INACTIVE);
  });

  it("exhaustively validates completeness as a pure read", async () => {
    const owner = await reporter();
    const other = await reporter();
    const category = await prisma.editorialCategory.create({
      data: { wordpressCategoryId: 59001n, name: "Matrix", slug: "matrix" },
    });
    const story = await prisma.story.create({
      data: {
        reporterId: owner.id,
        headline: "Headline",
        body: "Body",
        byline: "Byline",
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });
    const completeness = new StoryCompletenessService(prisma);
    const snapshot = async (): Promise<object> => ({
      story: await prisma.story.findUniqueOrThrow({ where: { id: story.id } }),
      conversation: await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      }),
      categories: await prisma.storyCategory.findMany({
        where: { storyId: story.id },
      }),
      media: await prisma.storyMedia.findMany({ where: { storyId: story.id } }),
      audits: await prisma.auditLog.count(),
    });
    const pure = async (
      expected: boolean,
      reporterId = owner.id,
    ): Promise<void> => {
      const before = await snapshot();
      await expect(completeness.isComplete(reporterId, story.id)).resolves.toBe(
        expected,
      );
      expect(await snapshot()).toEqual(before);
    };
    await pure(true);
    await pure(false, other.id);

    for (const data of [
      { headline: null },
      { headline: " \t" },
      { body: null },
      { body: " \n" },
      { byline: null },
      { byline: " \u2003" },
    ]) {
      await prisma.story.update({ where: { id: story.id }, data });
      await pure(false);
      await prisma.story.update({
        where: { id: story.id },
        data: { headline: "Headline", body: "Body", byline: "Byline" },
      });
    }
    for (const status of Object.values(StoryStatus).filter(
      (value) => value !== StoryStatus.COLLECTING,
    )) {
      await prisma.story.update({ where: { id: story.id }, data: { status } });
      await pure(false);
    }
    await prisma.story.update({
      where: { id: story.id },
      data: { status: StoryStatus.COLLECTING },
    });

    for (const data of [
      { state: ConversationState.IDLE },
      { state: ConversationState.AWAITING_HEADLINE },
      { state: ConversationState.AWAITING_BODY },
    ]) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data,
      });
      await pure(false);
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { state: ConversationState.COLLECTING_MEDIA, currentStoryId: null },
    });
    await pure(false);
    const otherStory = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Other" },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { currentStoryId: otherStory.id },
    });
    await pure(false);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { currentStoryId: story.id },
    });

    await prisma.storyCategory.deleteMany({ where: { storyId: story.id } });
    await pure(false);
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });
    await prisma.editorialCategory.update({
      where: { id: category.id },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    await pure(true);

    const media = await prisma.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: providerId("matrix-media"),
        mediaType: "IMAGE",
        position: 0,
      },
    });
    for (const status of [
      MediaProcessingStatus.RECEIVED,
      MediaProcessingStatus.FETCHING,
      MediaProcessingStatus.FAILED,
      MediaProcessingStatus.UPLOADING,
      MediaProcessingStatus.UPLOADED,
    ]) {
      await prisma.storyMedia.update({
        where: { id: media.id },
        data: { status },
      });
      await pure(false);
    }
    const validMedia = {
      status: MediaProcessingStatus.FETCHED,
      mimeType: "image/jpeg",
      fileSizeBytes: 1n,
      sha256: "a".repeat(64),
    };
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]) {
      await prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, mimeType },
      });
      await pure(true);
    }
    for (const mimeType of [
      null,
      "text/plain",
      "application/octet-stream",
      "image/svg+xml",
      "image/bmp",
    ]) {
      await prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, mimeType },
      });
      await pure(false);
    }
    for (const fileSizeBytes of [null, 0n]) {
      await prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, fileSizeBytes },
      });
      await pure(false);
    }
    await expect(
      prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, fileSizeBytes: -1n },
      }),
    ).rejects.toBeDefined();
    for (const sha256 of [
      null,
      "a".repeat(63),
      "A".repeat(64),
      `${"a".repeat(63)}A`,
      `${"a".repeat(63)}g`,
      ` ${"a".repeat(63)}`,
      `${"a".repeat(63)} `,
      Buffer.alloc(32).toString("base64"),
    ]) {
      await prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, sha256 },
      });
      await pure(false);
    }
    await expect(
      prisma.storyMedia.update({
        where: { id: media.id },
        data: { ...validMedia, sha256: "a".repeat(65) },
      }),
    ).rejects.toBeDefined();
    await prisma.storyMedia.update({
      where: { id: media.id },
      data: validMedia,
    });
    const second = await prisma.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: providerId("matrix-media-two"),
        mediaType: "IMAGE",
        position: 1,
        ...validMedia,
      },
    });
    await pure(true);
    await prisma.storyMedia.update({
      where: { id: second.id },
      data: { status: MediaProcessingStatus.RECEIVED },
    });
    await pure(false);
    await prisma.storyMedia.update({
      where: { id: second.id },
      data: { ...validMedia, status: MediaProcessingStatus.FAILED },
    });
    await pure(false);
    await prisma.storyMedia.update({
      where: { id: second.id },
      data: { ...validMedia, sha256: "Z".repeat(64) },
    });
    await pure(false);
  });

  it("stages sequential IMAGE events durably with zero-based positions and one Story version each", async () => {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: {
        reporterId: owner.id,
        byline: "Media Byline",
        headline: "Media headline",
        body: "Media body",
      },
    });
    await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    const category = await prisma.editorialCategory.create({
      data: {
        wordpressCategoryId: 61001n,
        name: "Media",
        slug: "media-proof",
      },
    });
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });
    for (let index = 0; index < 3; index += 1) {
      const event = await storedEvent(
        owner.phoneNumber,
        `media-sequential-${index}`,
        InboundEventType.IMAGE,
        {
          image: {
            id: `opaque.media.sequential:${index}`,
            mime_type: "image/jpeg",
            caption: `line one\r\nline ${index}`,
          },
        },
      );
      await expect(processor(prisma).process(event.id)).resolves.toMatchObject({
        outcome: "PROCESSED",
      });
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({
        processingStatus: InboundProcessingStatus.PROCESSED,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    }
    const media = await prisma.storyMedia.findMany({
      where: { storyId: story.id },
      orderBy: { position: "asc" },
    });
    expect(media.map(({ position }) => position)).toEqual([0, 1, 2]);
    expect(media.map(({ caption }) => caption)).toEqual([
      "line one\nline 0",
      "line one\nline 1",
      "line one\nline 2",
    ]);
    for (const row of media) {
      expect(row).toMatchObject({
        status: MediaProcessingStatus.FETCHED,
        mimeType: "image/jpeg",
        fileSizeBytes: 4n,
        altText: null,
        wordpressMediaId: null,
      });
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(stagedObjects.has(`story-media/v1/${row.id}/source`)).toBe(true);
    }
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      }),
    ).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_STAGED,
        },
      }),
    ).toBe(3);
    await expect(
      new StoryCompletenessService(prisma).isComplete(owner.id, story.id),
    ).resolves.toBe(true);
  });

  it("commits media intent before any provider/store I/O and completes afterward", async () => {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Boundary" },
    });
    await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    const providerMediaId = "opaque.boundary";
    const event = await storedEvent(
      owner.phoneNumber,
      "media-boundary",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    let externalObservedCommittedIntent = false;
    const provider: MediaProviderClient = {
      fetch: async (authority) => {
        const intent = await prisma.storyMedia.findUniqueOrThrow({
          where: { providerMediaId: authority.providerMediaId },
        });
        await prisma.$queryRaw`SELECT "id" FROM "Story" WHERE "id" = ${story.id}::uuid FOR UPDATE NOWAIT`;
        expect(intent.status).toBe(MediaProcessingStatus.FETCHING);
        expect(
          await prisma.inboundEvent.findUniqueOrThrow({
            where: { id: event.id },
          }),
        ).toMatchObject({
          processingStatus: InboundProcessingStatus.PROCESSING,
        });
        externalObservedCommittedIntent = true;
        return new ProofMediaProvider().fetch(authority);
      },
    };
    const service = new InboundEventProcessingService(
      prisma,
      new ReporterAuthorizationService(),
      new ConversationProvisioningService(),
      new StoredWhatsappEventParser(),
      storyProcessor(prisma),
      new MediaStagingService(prisma, provider, new ProofObjectStore()),
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(externalObservedCommittedIntent).toBe(true);
  });

  it("allows one of 20 direct media intents for one expected Story version", async () => {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Race" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    const results = await directRace(owner, conversation, 0, (index) => ({
      kind: "IMAGE",
      providerMediaId: `opaque.race:${index}`,
      mimeType: "image/jpeg",
    }));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      await prisma.storyMedia.findMany({ where: { storyId: story.id } }),
    ).toHaveLength(1);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      }),
    ).toBe(1);
  });

  it("rejects duplicate provider media IDs without another association, version, or audit", async () => {
    const owner = await reporter();
    const other = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Owner" },
    });
    const otherStory = await prisma.story.create({
      data: { reporterId: other.id, byline: "Other" },
    });
    await Promise.all([
      prisma.conversation.create({
        data: {
          reporterId: owner.id,
          state: ConversationState.COLLECTING_MEDIA,
          currentStoryId: story.id,
        },
      }),
      prisma.conversation.create({
        data: {
          reporterId: other.id,
          state: ConversationState.COLLECTING_MEDIA,
          currentStoryId: otherStory.id,
        },
      }),
    ]);
    const providerMediaId = "opaque.duplicate";
    const first = await storedEvent(
      owner.phoneNumber,
      "duplicate-first",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    await processor(prisma).process(first.id);
    for (const candidate of [owner, other]) {
      const duplicate = await storedEvent(
        candidate.phoneNumber,
        `duplicate-${candidate.id}`,
        InboundEventType.IMAGE,
        { image: { id: providerMediaId, mime_type: "image/jpeg" } },
      );
      await expect(processor(prisma).process(duplicate.id)).rejects.toThrow(
        "STORY_DOMAIN_CONFLICT",
      );
    }
    expect(await prisma.storyMedia.count({ where: { providerMediaId } })).toBe(
      1,
    );
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: otherStory.id } }))
        .version,
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      }),
    ).toBe(1);
  });
});

describe("Round 5B.2 PostgreSQL closure proofs", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const JPEG_SHA = createHash("sha256").update(JPEG).digest("hex");

  async function collectingStory(): Promise<{
    owner: Reporter;
    story: Story;
    conversation: Conversation;
  }> {
    const owner = await reporter();
    const story = await prisma.story.create({
      data: { reporterId: owner.id, byline: "Closure B" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: owner.id,
        state: ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    return { owner, story, conversation };
  }

  class RecordingProvider implements MediaProviderClient {
    readonly calls: MediaAuthority[] = [];
    constructor(private readonly inner: MediaProviderClient) {}

    async fetch(authority: MediaAuthority): Promise<DownloadedMedia> {
      this.calls.push(authority);
      return this.inner.fetch(authority);
    }
  }

  class RecordingStore implements MediaObjectStore {
    readonly puts: string[] = [];
    constructor(private readonly inner: MediaObjectStore) {}

    async putIfAbsent(
      key: string,
      media: DownloadedMedia,
    ): Promise<"CREATED" | "EXISTS"> {
      this.puts.push(key);
      return this.inner.putIfAbsent(key, media);
    }
    async head(key: string): Promise<StoredObjectHead | null> {
      return this.inner.head(key);
    }
    async read(key: string): Promise<Buffer> {
      return this.inner.read(key);
    }
  }

  class ThrowingProvider implements MediaProviderClient {
    readonly calls: MediaAuthority[] = [];
    constructor(private readonly error: MediaStagingError) {}

    fetch(authority: MediaAuthority): Promise<DownloadedMedia> {
      this.calls.push(authority);
      throw new MediaStagingError(this.error.code, this.error.definitive);
    }
  }

  class ConflictingHeadStore implements MediaObjectStore {
    async putIfAbsent(_key: string, _media: DownloadedMedia): Promise<"CREATED" | "EXISTS"> {
      return Promise.resolve("EXISTS");
    }
    async head(_key: string): Promise<StoredObjectHead | null> {
      return Promise.resolve({
        size: 999999,
        sha256: "0".repeat(64),
        mimeType: "image/jpeg",
      });
    }
    async read(_key: string): Promise<Buffer> {
      return Promise.resolve(Buffer.from([0]));
    }
  }

  function serviceWith(
    client: PrismaService,
    provider: MediaProviderClient,
    store: MediaObjectStore,
  ): InboundEventProcessingService {
    return new InboundEventProcessingService(
      client,
      new ReporterAuthorizationService(),
      new ConversationProvisioningService(),
      new StoredWhatsappEventParser(),
      storyProcessor(client),
      new MediaStagingService(client, provider, store),
    );
  }

  it("commits the full staging intent before any external I/O and never re-increments the Story version", async () => {
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.intent`;
    let observedColumn: string | null = null;
    const recording = new RecordingProvider({
      fetch: async (authority): Promise<DownloadedMedia> => {
        expect(authority.providerMediaId).toBe(providerMediaId);
        const intent = await prisma.storyMedia.findUniqueOrThrow({
          where: { providerMediaId: authority.providerMediaId },
        });
        await prisma.$queryRaw`SELECT "id" FROM "Story" WHERE "id" = ${story.id}::uuid FOR UPDATE NOWAIT`;
        const storyRow = await prisma.story.findUniqueOrThrow({
          where: { id: story.id },
        });
        expect(intent).toMatchObject({
          storyId: story.id,
          providerMediaId,
          mediaType: "IMAGE",
          status: MediaProcessingStatus.FETCHING,
          position: 0,
          caption: "one\ntwo",
          altText: null,
          wordpressMediaId: null,
          sha256: null,
          fileSizeBytes: null,
          mimeType: "image/jpeg",
        });
        expect(storyRow.version).toBe(1);
        const eventRow = await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(eventRow).toMatchObject({
          processingStatus: InboundProcessingStatus.PROCESSING,
          processedAt: null,
        });
        expect(
          await prisma.auditLog.count({
            where: {
              storyId: story.id,
              eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
            },
          }),
        ).toBe(1);
        observedColumn = intent.caption;
        return {
          bytes: JPEG,
          mimeType: "image/jpeg",
          size: JPEG.length,
          sha256: JPEG_SHA,
        };
      },
    });
    const storeRecording = new RecordingStore(new ProofObjectStore());
    const service = serviceWith(prisma, recording, storeRecording);
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-intent",
      InboundEventType.IMAGE,
      {
        image: {
          id: providerMediaId,
          mime_type: "image/jpeg",
          caption: "one\r\ntwo",
        },
      },
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(observedColumn).toBe("one\ntwo");
    expect(recording.calls).toHaveLength(1);
    expect(storeRecording.puts).toHaveLength(1);
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    expect(storeRecording.puts).toEqual([mediaObjectKey(media.id)]);
    expect(media.status).toBe(MediaProcessingStatus.FETCHED);
    expect(media.fileSizeBytes).toBe(4n);
    expect(media.sha256).toBe(JPEG_SHA);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({
      processingStatus: InboundProcessingStatus.PROCESSED,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    const completedEvent = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(completedEvent.processedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
        },
      }),
    ).toBe(1);
  });

  it("proves the object write is in flight before the completion transaction and completion waits for verified evidence", async () => {
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.io`;
    let objectObservedFetching = false;
    const provider = new RecordingProvider({
      fetch: async (authority): Promise<DownloadedMedia> => {
        await prisma.$queryRaw`SELECT "id" FROM "Story" WHERE "id" = ${story.id}::uuid FOR UPDATE NOWAIT`;
        expect(
          await prisma.storyMedia.findUniqueOrThrow({
            where: { providerMediaId: authority.providerMediaId },
          }),
        ).toMatchObject({ status: MediaProcessingStatus.FETCHING });
        return {
          bytes: JPEG,
          mimeType: "image/jpeg",
          size: JPEG.length,
          sha256: JPEG_SHA,
        };
      },
    });
    const store = new RecordingStore({
      putIfAbsent: async (key, media): Promise<"CREATED" | "EXISTS"> => {
        stagedObjects.set(key, media);
        const observed = await prisma.storyMedia.findUniqueOrThrow({
          where: { providerMediaId },
        });
        expect(observed.status).toBe(MediaProcessingStatus.FETCHING);
        const eventRow = await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: event.id },
        });
        expect(eventRow.processingStatus).toBe(
          InboundProcessingStatus.PROCESSING,
        );
        expect(eventRow.processedAt).toBeNull();
        objectObservedFetching = true;
        return "CREATED";
      },
      head: (key): Promise<StoredObjectHead | null> => {
        const media = stagedObjects.get(key);
        return Promise.resolve(
          media
            ? { size: media.size, sha256: media.sha256, mimeType: media.mimeType }
            : null,
        );
      },
      read: async (key): Promise<Buffer> => {
        const media = stagedObjects.get(key);
        if (!media) return Promise.reject(new Error("missing"));
        return media.bytes;
      },
    });
    const service = serviceWith(prisma, provider, store);
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-io",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(objectObservedFetching).toBe(true);
  });

  it("keeps the durable object, a reconciliation path, and no false terminal state when the completion transaction fails", async () => {
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.completion-failure`;
    const runClient = new PrismaService();
    let failCompletion = false;
    const rawTransaction = runClient.$transaction.bind(runClient);
    runClient.$transaction = ((interactive: unknown, ...rest: unknown[]) => {
      if (failCompletion) {
        failCompletion = false;
        return Promise.reject(new Error("simulated completion write failure"));
      }
      return rawTransaction(interactive as never, ...(rest as never[]));
    }) as typeof runClient.$transaction;
    try {
      const provider = new RecordingProvider({
        fetch: (authority): Promise<DownloadedMedia> => {
          expect(authority.providerMediaId).toBe(providerMediaId);
          failCompletion = true;
          return Promise.resolve({
            bytes: JPEG,
            mimeType: "image/jpeg",
            size: JPEG.length,
            sha256: JPEG_SHA,
          });
        },
      });
      const store = new RecordingStore(new ProofObjectStore());
      const service = serviceWith(runClient, provider, store);
      const event = await storedEvent(
        owner.phoneNumber,
        "closure-completion-failure",
        InboundEventType.IMAGE,
        { image: { id: providerMediaId, mime_type: "image/jpeg" } },
      );
      await expect(service.process(event.id)).resolves.toMatchObject({
        outcome: "RETRY_REQUIRED",
        reason: "MEDIA_OBJECT_UNAVAILABLE",
      });
      const media = await prisma.storyMedia.findUniqueOrThrow({
        where: { providerMediaId },
      });
      const key = mediaObjectKey(media.id);
      expect(media).toMatchObject({
        status: MediaProcessingStatus.FETCHING,
        mimeType: "image/jpeg",
        fileSizeBytes: null,
        sha256: null,
      });
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({
        processingStatus: InboundProcessingStatus.PROCESSING,
        processedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(1);
      expect(store.puts).toEqual([key]);
      const stagedObject = stagedObjects.get(key);
      expect(stagedObject).toBeDefined();
      expect(stagedObject?.sha256).toBe(JPEG_SHA);

      const recoveryProvider = new RecordingProvider(new ProofMediaProvider());
      const recoveryStore = new RecordingStore(new ProofObjectStore());
      const recovered = await new MediaStagingService(
        prisma,
        recoveryProvider,
        recoveryStore,
      ).reconcile(media.id, event.id);
      expect(recovered).toEqual({ outcome: "PROCESSED" });
      expect(recoveryProvider.calls).toHaveLength(0);
      expect(recoveryStore.puts).toHaveLength(0);
      const after = await prisma.storyMedia.findUniqueOrThrow({
        where: { id: media.id },
      });
      expect(after).toMatchObject({
        status: MediaProcessingStatus.FETCHED,
        mimeType: "image/jpeg",
        fileSizeBytes: 4n,
        sha256: JPEG_SHA,
      });
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({
        processingStatus: InboundProcessingStatus.PROCESSED,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            storyId: story.id,
            eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            storyId: story.id,
            eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
          },
        }),
      ).toBe(1);
    } finally {
      await runClient.$disconnect();
    }
  });

  it("finalises a matching pre-existing object without provider I/O and rejects a mismatching one", async () => {
    const { owner } = await collectingStory();
    const providerMediaId = `closure.reconcile`;
    const provider = new RecordingProvider({
      fetch: (): Promise<DownloadedMedia> =>
        Promise.reject(
          new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false),
        ),
    });
    const service = serviceWith(prisma, provider, new ProofObjectStore());
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-reconcile",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "RETRY_REQUIRED",
      reason: "MEDIA_PROVIDER_UNAVAILABLE",
    });
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    expect(media.status).toBe(MediaProcessingStatus.FETCHING);
    const key = mediaObjectKey(media.id);
    expect(stagedObjects.has(key)).toBe(false);

    stagedObjects.set(key, {
      bytes: JPEG,
      mimeType: "image/jpeg",
      size: JPEG.length,
      sha256: JPEG_SHA,
    });
    const recoveryProvider = new RecordingProvider(new ProofMediaProvider());
    const recoveryStore = new RecordingStore(new ProofObjectStore());
    const recovered = await new MediaStagingService(
      prisma,
      recoveryProvider,
      recoveryStore,
    ).reconcile(media.id, event.id);
    expect(recovered).toEqual({ outcome: "PROCESSED" });
    expect(recoveryProvider.calls).toHaveLength(0);
    expect(recoveryStore.puts).toHaveLength(0);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({ processingStatus: InboundProcessingStatus.PROCESSED });

    const mismatchingEvent = await storedEvent(
      owner.phoneNumber,
      "closure-reconcile-mismatch",
      InboundEventType.IMAGE,
      { image: { id: `closure.reconcile.mismatch`, mime_type: "image/jpeg" } },
    );
    const mismatchService = serviceWith(
      prisma,
      new RecordingProvider({
        fetch: (): Promise<DownloadedMedia> =>
          Promise.reject(
            new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false),
          ),
      }),
      new ProofObjectStore(),
    );
    await expect(mismatchService.process(mismatchingEvent.id)).resolves.toMatchObject({
      outcome: "RETRY_REQUIRED",
      reason: "MEDIA_PROVIDER_UNAVAILABLE",
    });
    const mismatchMedia = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId: "closure.reconcile.mismatch" },
    });
    const mismatchKey = mediaObjectKey(mismatchMedia.id);
    stagedObjects.set(mismatchKey, {
      bytes: Buffer.from([0x01]),
      mimeType: "image/png",
      size: 1,
      sha256: createHash("sha256").update(Buffer.from([0x01])).digest("hex"),
    });
    const conflictStore = new RecordingStore(new ProofObjectStore());
    const conflicted = await new MediaStagingService(
      prisma,
      recoveryProvider,
      conflictStore,
    ).reconcile(mismatchMedia.id, mismatchingEvent.id);
    expect(conflicted).toMatchObject({
      outcome: "RETRY_REQUIRED",
      reason: "MEDIA_OBJECT_CONFLICT",
    });
    expect(conflictStore.puts).toHaveLength(0);
    expect(
      await prisma.storyMedia.findUniqueOrThrow({
        where: { id: mismatchMedia.id },
      }),
    ).toMatchObject({ status: MediaProcessingStatus.FETCHING });
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: mismatchingEvent.id },
      }),
    ).toMatchObject({ processingStatus: InboundProcessingStatus.PROCESSING });
    expect(stagedObjects.get(mismatchKey)?.size).toBe(1);
  });

  it("reconciles idempotently without additional DB mutations or I/O", async () => {
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.idempotent`;
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-idempotent",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    await expect(processor(prisma).process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    const first = await new MediaStagingService(
      prisma,
      new ProofMediaProvider(),
      new ProofObjectStore(),
    ).reconcile(media.id, event.id);
    expect(first).toEqual({ outcome: "PROCESSED" });
    const prior = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    const provider = new RecordingProvider(new ProofMediaProvider());
    const store = new RecordingStore(new ProofObjectStore());
    const second = await new MediaStagingService(
      prisma,
      provider,
      store,
    ).reconcile(media.id, event.id);
    expect(second).toEqual({ outcome: "PROCESSED" });
    expect(provider.calls).toHaveLength(0);
    expect(store.puts).toHaveLength(0);
    const after = await prisma.storyMedia.findUniqueOrThrow({
      where: { id: media.id },
    });
    expect(after).toMatchObject({ status: MediaProcessingStatus.FETCHED });
    const now = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(now.processedAt).toEqual(prior.processedAt);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: story.id,
          eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
        },
      }),
    ).toBe(1);
  });

  it("leaves stable terminal database states for every definitive media failure", async () => {
    const cases: Array<{
      label: string;
      error: MediaStagingError;
    }> = [
      {
        label: "mime-mismatch",
        error: new MediaStagingError("MEDIA_MIME_MISMATCH", true),
      },
      {
        label: "too-large",
        error: new MediaStagingError("MEDIA_TOO_LARGE", true),
      },
      {
        label: "size-mismatch",
        error: new MediaStagingError("MEDIA_SIZE_MISMATCH", true),
      },
      {
        label: "hash-mismatch",
        error: new MediaStagingError("MEDIA_HASH_MISMATCH", true),
      },
    ];
    for (const testCase of cases) {
      const { owner, story } = await collectingStory();
      const providerMediaId = `closure.definitive.${testCase.label}`;
      const event = await storedEvent(
        owner.phoneNumber,
        `closure-definitive-${testCase.label}`,
        InboundEventType.IMAGE,
        { image: { id: providerMediaId, mime_type: "image/jpeg" } },
      );
      const service = serviceWith(
        prisma,
        new ThrowingProvider(testCase.error),
        new ProofObjectStore(),
      );
      await expect(service.process(event.id)).resolves.toMatchObject({
        outcome: "FAILED",
        reason: testCase.error.code,
      });
      const media = await prisma.storyMedia.findUniqueOrThrow({
        where: { providerMediaId },
      });
      expect(media.status).toBe(MediaProcessingStatus.FAILED);
      expect(media.sha256).toBeNull();
      expect(media.fileSizeBytes).toBeNull();
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: event.id },
        }),
      ).toMatchObject({
        processingStatus: InboundProcessingStatus.FAILED,
        lastErrorCode: testCase.error.code,
        lastErrorMessage: null,
      });
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            storyId: story.id,
            eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_FAILED,
          },
        }),
      ).toBe(1);
    }
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.definitive.conflict`;
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-definitive-conflict",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    const service = serviceWith(
      prisma,
      new ProofMediaProvider(),
      new ConflictingHeadStore(),
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "FAILED",
      reason: "MEDIA_OBJECT_CONFLICT",
    });
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    expect(media.status).toBe(MediaProcessingStatus.FAILED);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
    expect(
      await prisma.storyMedia.count({ where: { storyId: story.id } }),
    ).toBe(1);
  });

  it("never claims a false terminal state for transient or ambiguous staging failures", async () => {
    const transient: Array<{ label: string; error: MediaStagingError }> = [
      {
        label: "metadata-timeout",
        error: new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false),
      },
      {
        label: "connection-reset",
        error: new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false),
      },
      {
        label: "store-before-effect",
        error: new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false),
      },
    ];
    for (const testCase of transient) {
      const { owner, story } = await collectingStory();
      const providerMediaId = `closure.transient.${testCase.label}`;
      const event = await storedEvent(
        owner.phoneNumber,
        `closure-transient-${testCase.label}`,
        InboundEventType.IMAGE,
        { image: { id: providerMediaId, mime_type: "image/jpeg" } },
      );
      const thrower = new ThrowingProvider(testCase.error);
      const service = serviceWith(
        prisma,
        thrower,
        new ProofObjectStore(),
      );
      await expect(service.process(event.id)).resolves.toMatchObject({
        outcome: "RETRY_REQUIRED",
        reason: testCase.error.code,
      });
      expect(thrower.calls).toHaveLength(1);
      const media = await prisma.storyMedia.findUniqueOrThrow({
        where: { providerMediaId },
      });
      expect(media.status).toBe(MediaProcessingStatus.FETCHING);
      expect(media.sha256).toBeNull();
      expect(media.fileSizeBytes).toBeNull();
      const eventRow = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(eventRow.processingStatus).toBe(InboundProcessingStatus.PROCESSING);
      expect(eventRow.processedAt).toBeNull();
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(1);
    }
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.transient.ambiguous-after-effect`;
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-transient-ambiguous",
      InboundEventType.IMAGE,
      { image: { id: providerMediaId, mime_type: "image/jpeg" } },
    );
    const ambiguousStore = new RecordingStore({
      putIfAbsent(
        key: string,
        media: DownloadedMedia,
      ): Promise<"CREATED" | "EXISTS"> {
        stagedObjects.set(key, media);
        throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
      },
      head(key: string): Promise<StoredObjectHead | null> {
        const media = stagedObjects.get(key);
        return Promise.resolve(
          media
            ? { size: media.size, sha256: media.sha256, mimeType: media.mimeType }
            : null,
        );
      },
      async read(key: string): Promise<Buffer> {
        const media = stagedObjects.get(key);
        if (!media) return Promise.reject(new Error("missing"));
        return media.bytes;
      },
    });
    const service = serviceWith(
      prisma,
      new ProofMediaProvider(),
      ambiguousStore,
    );
    await expect(service.process(event.id)).resolves.toMatchObject({
      outcome: "RETRY_REQUIRED",
      reason: "MEDIA_OBJECT_UNAVAILABLE",
    });
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    expect(media.status).toBe(MediaProcessingStatus.FETCHING);
    const key = mediaObjectKey(media.id);
    expect(stagedObjects.has(key)).toBe(true);
    expect(ambiguousStore.puts).toEqual([key]);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toMatchObject({
      processingStatus: InboundProcessingStatus.PROCESSING,
      processedAt: null,
    });
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
        .version,
    ).toBe(1);
  });

  it("regresses IMAGE events outside COLLECTING_MEDIA to IGNORED without any staging I/O", async () => {
    for (const state of [
      ConversationState.IDLE,
      ConversationState.AWAITING_HEADLINE,
      ConversationState.AWAITING_BODY,
    ]) {
      const owner = await reporter();
      const conversation = await prisma.conversation.create({
        data: {
          reporterId: owner.id,
          state,
          currentStoryId: null,
        },
      });
      const mediaBefore = await prisma.storyMedia.count();
      const provider = new RecordingProvider(new ProofMediaProvider());
      const store = new RecordingStore(new ProofObjectStore());
      const service = serviceWith(prisma, provider, store);
      const event = await storedEvent(
        owner.phoneNumber,
        `closure-state-${state}`,
        InboundEventType.IMAGE,
        {
          image: {
            id: `closure.image.${state}`,
            mime_type: "image/jpeg",
          },
        },
      );
      await expect(service.process(event.id)).resolves.toMatchObject({
        outcome: "IGNORED",
        reason: "IMAGE_NOT_ACCEPTED_IN_STATE",
      });
      expect(await prisma.storyMedia.count()).toBe(mediaBefore);
      expect(provider.calls).toHaveLength(0);
      expect(store.puts).toHaveLength(0);
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({
        processingStatus: InboundProcessingStatus.IGNORED,
        lastErrorCode: "IMAGE_NOT_ACCEPTED_IN_STATE",
      });
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        }),
      ).toMatchObject({ state, currentStoryId: null });
    }
  });

  it("keeps a later IMAGE order-blocked without intent, version, audit, or staging I/O", async () => {
    const owner = await reporter();
    const first = await storedEvent(
      owner.phoneNumber,
      "closure-blocked-earlier",
      InboundEventType.TEXT,
      { text: { body: "blocking" } },
    );
    const provider = new RecordingProvider(new ProofMediaProvider());
    const store = new RecordingStore(new ProofObjectStore());
    const service = serviceWith(prisma, provider, store);
    const later = await storedEvent(
      owner.phoneNumber,
      "closure-blocked-later",
      InboundEventType.IMAGE,
      {
        image: {
          id: "closure.image.blocked",
          mime_type: "image/jpeg",
        },
      },
    );
    await expect(service.process(later.id)).resolves.toMatchObject({
      outcome: "ORDER_BLOCKED",
    });
    const blocked = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: later.id },
    });
    expect(blocked.processingStatus).toBe(InboundProcessingStatus.RECEIVED);
    expect(blocked.processingAttempts).toBe(0);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ processingStatus: InboundProcessingStatus.RECEIVED });
    expect(
      await prisma.storyMedia.count({ where: { providerMediaId: "closure.image.blocked" } }),
    ).toBe(0);
    expect(
      await prisma.story.count({ where: { reporterId: owner.id } }),
    ).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(store.puts).toHaveLength(0);
    expect(
      await prisma.auditLog.count({
        where: {
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
          inboundEventId: later.id,
        },
      }),
    ).toBe(0);
  });

  it("leaves unknown and inactive IMAGE events IGNORED with zero staging I/O", async () => {
    const unknownPhone = `+2999${run}${String(sequence++).padStart(2, "0")}`;
    const unknownEvent = await storedEvent(
      unknownPhone,
      "closure-unknown",
      InboundEventType.IMAGE,
      { image: { id: "closure.image.unknown", mime_type: "image/jpeg" } },
    );
    const unknownProvider = new RecordingProvider(new ProofMediaProvider());
    const unknownStore = new RecordingStore(new ProofObjectStore());
    const unknownService = serviceWith(prisma, unknownProvider, unknownStore);
    await expect(unknownService.process(unknownEvent.id)).resolves.toMatchObject({
      outcome: "IGNORED",
      reason: IGNORED_REASON.UNKNOWN,
    });
    expect(unknownProvider.calls).toHaveLength(0);
    expect(unknownStore.puts).toHaveLength(0);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: unknownEvent.id },
      }),
    ).toMatchObject({
      processingStatus: InboundProcessingStatus.IGNORED,
      lastErrorCode: IGNORED_REASON.UNKNOWN,
    });

    const inactive = await reporter(ReporterStatus.INACTIVE);
    const inactiveEvent = await storedEvent(
      inactive.phoneNumber,
      "closure-inactive",
      InboundEventType.IMAGE,
      { image: { id: "closure.image.inactive", mime_type: "image/jpeg" } },
    );
    const inactiveProvider = new RecordingProvider(new ProofMediaProvider());
    const inactiveStore = new RecordingStore(new ProofObjectStore());
    const inactiveService = serviceWith(prisma, inactiveProvider, inactiveStore);
    await expect(inactiveService.process(inactiveEvent.id)).resolves.toMatchObject({
      outcome: "IGNORED",
      reason: IGNORED_REASON.INACTIVE,
    });
    expect(inactiveProvider.calls).toHaveLength(0);
    expect(inactiveStore.puts).toHaveLength(0);
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: inactiveEvent.id },
      }),
    ).toMatchObject({
      processingStatus: InboundProcessingStatus.IGNORED,
      lastErrorCode: IGNORED_REASON.INACTIVE,
    });
    expect(
      await prisma.storyMedia.count({
        where: {
          providerMediaId: { in: ["closure.image.unknown", "closure.image.inactive"] },
        },
      }),
    ).toBe(0);
  });

  it("isolates cross-Reporter media: no association, mutation, audit, or I/O against another Reporter's Story", async () => {
    const {
      owner: attacker,
      story: attackerStory,
      conversation: attackerConversation,
    } = await collectingStory();
    const { story: victimStory, conversation: victimConversation } =
      await collectingStory();
    const provider = new RecordingProvider(new ProofMediaProvider());
    const store = new RecordingStore(new ProofObjectStore());
    const attackerEvent = await storedEvent(
      attacker.phoneNumber,
      "closure-cross-attacker",
      InboundEventType.IMAGE,
      {
        image: {
          id: "closure.image.attacker-own",
          mime_type: "image/jpeg",
        },
      },
    );
    await expect(
      serviceWith(prisma, provider, store).process(attackerEvent.id),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(
      await prisma.storyMedia.count({ where: { storyId: attackerStory.id } }),
    ).toBe(1);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: attackerStory.id } }))
        .version,
    ).toBe(1);
    const callsBeforeForged = provider.calls.length;
    const putsBeforeForged = store.puts.length;

    const forged = await storedEvent(
      attacker.phoneNumber,
      "closure-cross-forged",
      InboundEventType.IMAGE,
      {
        image: {
          id: "closure.image.forged",
          mime_type: "image/jpeg",
        },
      },
    );
    const pool = await clients(1);
    try {
      await expect(
        pool[0]!.$transaction((tx) =>
          storyProcessor(pool[0]!).process(tx, {
            eventId: forged.id,
            reporterId: attacker.id,
            conversationId: victimConversation.id,
            conversationState: ConversationState.COLLECTING_MEDIA,
            conversationVersion: victimConversation.version,
            expectedStoryVersion: victimStory.version,
            parsed: {
              kind: "IMAGE",
              providerMediaId: "closure.image.forged",
              mimeType: "image/jpeg",
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await pool[0]!.$disconnect();
    }
    expect(provider.calls).toHaveLength(callsBeforeForged);
    expect(store.puts).toHaveLength(putsBeforeForged);
    expect(
      await prisma.storyMedia.count({ where: { storyId: victimStory.id } }),
    ).toBe(0);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: victimStory.id } }))
        .version,
    ).toBe(0);
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: victimConversation.id },
      }),
    ).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      version: victimConversation.version,
    });
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: victimStory.id,
          eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
        },
      }),
    ).toBe(0);
    expect(attackerStory.id).not.toBe(victimStory.id);
    expect(attackerConversation.id).not.toBe(victimConversation.id);
  });

  it("stores only safe content-free fields in every media audit and never duplicates the association", async () => {
    const { owner, story } = await collectingStory();
    const providerMediaId = `closure.audit-safe`;
    const event = await storedEvent(
      owner.phoneNumber,
      "closure-audit-safe",
      InboundEventType.IMAGE,
      {
        image: {
          id: providerMediaId,
          mime_type: "image/jpeg",
          caption: "sensitive-caption-never-audited",
        },
      },
    );
    await expect(processor(prisma).process(event.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const media = await prisma.storyMedia.findUniqueOrThrow({
      where: { providerMediaId },
    });
    const audits = await prisma.auditLog.findMany({
      where: {
        storyId: story.id,
        eventType: {
          in: [
            STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
            MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
          ],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit.reporterId).toBe(owner.id);
      expect(audit.storyId).toBe(story.id);
      expect(audit.inboundEventId).toBe(event.id);
      expect(audit.entityType).toBe("StoryMedia");
      expect(audit.entityId).toBe(media.id);
      expect(JSON.stringify(audit.metadata)).not.toContain(
        "sensitive-caption-never-audited",
      );
      expect(JSON.stringify({ ...audit, metadata: audit.metadata })).not.toContain(
        owner.phoneNumber,
      );
      expect(JSON.stringify({ ...audit, metadata: audit.metadata })).not.toContain(
        "https://",
      );
    }
    expect(audits[0]).toMatchObject({
      eventType: STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
      metadata: {
        versionBefore: 0,
        versionAfter: 1,
        storyMediaId: media.id,
        position: 0,
        mimeType: "image/jpeg",
      },
    });
    expect(audits[1]).toMatchObject({
      eventType: MEDIA_STAGING_AUDIT.STORY_MEDIA_STAGED,
      metadata: {
        mimeType: "image/jpeg",
        size: JPEG.length,
        sha256: JPEG_SHA,
      },
    });
  });
});
