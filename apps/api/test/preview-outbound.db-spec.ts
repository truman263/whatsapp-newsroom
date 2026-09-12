import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  ConversationState,
  DraftPreparationStatus,
  InboundEventType,
  InboundProcessingStatus,
  OutboundMessageStatus,
  Provider,
  ReporterStatus,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { ApprovalPromptService } from "../src/modules/whatsapp-outbound/approval-prompt.service";
import { WhatsappOutboundDispatcher } from "../src/modules/whatsapp-outbound/whatsapp-outbound.dispatcher";
import { WhatsappOutboundStatusService } from "../src/modules/whatsapp-outbound/whatsapp-outbound-status.service";

const prisma = new PrismaService();

async function seed(): Promise<{
  story: { id: string; version: number };
  preparation: { id: string };
}> {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+26377${Date.now().toString().slice(-7)}`,
      displayName: "Proof",
      status: ReporterStatus.ACTIVE,
    },
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.AWAITING_APPROVAL,
      headline: "Headline",
      body: "Body",
      byline: "Byline",
      version: 4,
      wordpressPostId: BigInt(Date.now()),
    },
  });
  const conversation = await prisma.conversation.create({
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
  void conversation;
  return { story, preparation };
}

describe("preview/outbound durable authority", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE');
  });
  afterAll(async () => prisma.$disconnect());

  it("serializes 20 queue and 20 dispatch contenders into one durable prompt and one Meta send", async () => {
    const value = await seed();
    const queue = new ApprovalPromptService();
    const authority = {
      preparationId: value.preparation.id,
      storyId: value.story.id,
      storyVersion: value.story.version,
      wordpressAppliedVersion: "a".repeat(64),
    };
    const queued = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction(
          (tx) => queue.queueApprovalPromptInTransaction(tx, authority),
          { maxWait: 30_000, timeout: 30_000 },
        ),
      ),
    );
    expect(new Set(queued.map((row) => row.id)).size).toBe(1);
    expect(
      await prisma.outboundMessage.count({
        where: { storyId: value.story.id },
      }),
    ).toBe(1);
    expect(Object.keys(queued[0]!.payload as object).sort()).toEqual([
      "draftPreparationId",
      "kind",
      "storyId",
      "storyVersion",
      "wordpressAppliedVersion",
    ]);
    expect(JSON.stringify(queued[0]!.payload)).not.toMatch(
      /token|preview|headline|body|byline|phone/i,
    );

    const client = {
      sendApprovalPrompt: jest.fn().mockResolvedValue("wamid.authoritative"),
    };
    const dispatcher = new WhatsappOutboundDispatcher(
      prisma,
      { issue: jest.fn().mockResolvedValue("capability.token") } as never,
      client as never,
      new ConfigService({
        preview: { publicOrigin: "https://newsroom.test" },
      }) as never,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => dispatcher.dispatchOne(queued[0]!.id)),
    );
    expect(results.filter((result) => result === "SENT")).toHaveLength(1);
    expect(client.sendApprovalPrompt).toHaveBeenCalledTimes(1);
    const final = await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: queued[0]!.id },
    });
    expect(final).toMatchObject({
      status: OutboundMessageStatus.SENT,
      sendAttempts: 1,
      providerMessageId: "wamid.authoritative",
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    expect(JSON.stringify(final.payload)).not.toContain("capability.token");

    const statuses = new WhatsappOutboundStatusService(prisma);
    await expect(
      statuses.applyProviderStatus({
        providerMessageId: "wamid.authoritative",
        status: "delivered",
      }),
    ).resolves.toBe("APPLIED");
    await expect(
      statuses.applyProviderStatus({
        providerMessageId: "wamid.authoritative",
        status: "sent",
      }),
    ).resolves.toBe("UNCHANGED");
    await expect(statuses.isPromptSendProven(final.id)).resolves.toBe(true);
    expect(
      (
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { id: final.id },
        })
      ).status,
    ).toBe(OutboundMessageStatus.DELIVERED);
  });

  it("leaves uncertain sends in SENDING and never dispatches or recovers them automatically", async () => {
    const value = await seed();
    const queue = new ApprovalPromptService();
    const message = await prisma.$transaction((tx) =>
      queue.queueApprovalPromptInTransaction(tx, {
        preparationId: value.preparation.id,
        storyId: value.story.id,
        storyVersion: value.story.version,
        wordpressAppliedVersion: "a".repeat(64),
      }),
    );
    const client = {
      sendApprovalPrompt: jest
        .fn()
        .mockRejectedValue(new Error("response lost")),
    };
    const dispatcher = new WhatsappOutboundDispatcher(
      prisma,
      { issue: jest.fn().mockResolvedValue("capability.token") } as never,
      client as never,
      new ConfigService({
        preview: { publicOrigin: "https://newsroom.test" },
      }) as never,
    );
    await expect(dispatcher.dispatchOne(message.id)).resolves.toBe(
      "OUTCOME_UNCERTAIN",
    );
    await expect(dispatcher.dispatchPending(10)).resolves.toEqual([]);
    await expect(dispatcher.recoverUncertainSend(message.id)).resolves.toBe(
      "MANUAL_RECONCILIATION_REQUIRED",
    );
    expect(client.sendApprovalPrompt).toHaveBeenCalledTimes(1);
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({
        where: { id: message.id },
      }),
    ).toMatchObject({
      status: OutboundMessageStatus.SENDING,
      sendAttempts: 1,
      providerMessageId: null,
      lastErrorCode: "WHATSAPP_SEND_OUTCOME_UNCERTAIN",
      lastErrorMessage: null,
      failedAt: null,
    });
  });
});
