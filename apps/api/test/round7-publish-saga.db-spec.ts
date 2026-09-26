/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  ApprovalDecision,
  ConversationState,
  DraftPreparationStatus,
  InboundEventType,
  InboundProcessingStatus,
  OutboundMessageStatus,
  OutboundMessageType,
  Provider,
  PublishAttemptStatus,
  PublishOperation,
  ReporterStatus,
  StoryMediaType,
  StoryStatus,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../src/config/configuration";
import { PrismaService } from "../src/database/prisma.service";
import { PublishAttemptDriverService } from "../src/modules/publishing/publish-attempt-driver.service";
import { Round7PublishSagaService } from "../src/modules/publishing/round7-publish-saga.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { Round7ApprovalService } from "../src/modules/reporter-workflow/round7-approval.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import { draftStateFingerprint } from "../src/modules/wordpress-draft/wordpress-draft-state";
import type { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import {
  WordPressPublicationError,
  type LedgerEvidence,
  type PublicationIntent,
  type PublicationOutcome,
  type PublishedEvidence,
  type WordPressPublicationClient,
} from "../src/modules/wordpress-publication/wordpress-publication.client";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(120_000);
const prisma = new PrismaService();
const marker = `round7b3:${randomUUID()}`;
let postIdentity = BigInt(Date.now()) * 1000n;

class PublicationProof {
  readonly calls: string[] = [];
  getResult: PublicationOutcome | Error = { outcome: "NOT_FOUND" };
  postResult: PublishedEvidence | Error | undefined;

  async get(key: string): Promise<PublicationOutcome> {
    this.calls.push(`GET:${key}`);
    if (this.getResult instanceof Error) throw this.getResult;
    return this.getResult;
  }

  async publish(intent: PublicationIntent): Promise<PublishedEvidence> {
    this.calls.push(`POST:${intent.publishKey}`);
    if (this.postResult instanceof Error) throw this.postResult;
    return (
      this.postResult ?? {
        outcome: "PUBLISHED",
        publishKey: intent.publishKey,
        postId: intent.postId,
        status: "publish",
        appliedVersionBefore: intent.expectedAppliedVersion,
        publishedAt: "2026-09-23 12:00:00",
      }
    );
  }
}

async function seed(name: string) {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
      displayName: `${marker}:${name}`,
      status: ReporterStatus.ACTIVE,
    },
  });
  const category = await prisma.editorialCategory.create({
    data: {
      wordpressCategoryId: ++postIdentity,
      name: `${marker}:${name}`,
      slug: `r7b3-${randomUUID()}`,
    },
  });
  const appliedVersion = draftStateFingerprint({
    title: "Headline",
    content: "Body",
    excerpt: "",
    categories: [Number(category.wordpressCategoryId)],
    editorial_byline: "Byline",
    featured_media_key: null,
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.APPROVED,
      headline: "Headline",
      body: "Body",
      byline: "Byline",
      version: 3,
      approvedAt: new Date(),
      wordpressPostId: ++postIdentity,
    },
  });
  await prisma.storyCategory.create({
    data: { storyId: story.id, categoryId: category.id },
  });
  const conversation = await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      state: ConversationState.AWAITING_APPROVAL,
      currentStoryId: story.id,
    },
  });
  const preparationEvent = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: `${marker}:prep:${name}`,
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 1n,
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSED,
      rawPayload: { message: {} },
    },
  });
  const preparation = await prisma.draftPreparation.create({
    data: {
      storyId: story.id,
      inboundEventId: preparationEvent.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      wordpressPostId: story.wordpressPostId,
      wordpressAppliedVersion: appliedVersion,
      approvalPromptCorrelationKey: `round7b3:${randomUUID()}`,
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
      payload: { kind: "APPROVAL_PROMPT_V1" },
    },
  });
  await prisma.draftPreparation.update({
    where: { id: preparation.id },
    data: { approvalPromptOutboundMessageId: prompt.id },
  });
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: `${marker}:approve:${name}`,
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 2n,
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSING,
      processingAttempts: 1,
      processingContractVersion: 1,
      processingStartedAt: new Date(),
      rawPayload: { message: {} },
    },
  });
  const approval = await prisma.approval.create({
    data: {
      storyId: story.id,
      reporterId: reporter.id,
      inboundEventId: event.id,
      draftPreparationId: preparation.id,
      storyVersion: story.version,
      wordpressAppliedVersion: appliedVersion,
      decision: ApprovalDecision.APPROVED,
    },
  });
  const attempt = await prisma.publishAttempt.create({
    data: {
      storyId: story.id,
      operation: PublishOperation.PUBLISH,
      status: PublishAttemptStatus.PENDING,
      attemptNumber: 1,
      idempotencyKey: `draft-publish:${preparation.id}:${story.version}`,
      approvalId: approval.id,
      wordpressPostId: story.wordpressPostId,
    },
  });
  const wordpress = new PublicationProof();
  const saga = new Round7PublishSagaService(
    prisma,
    wordpress as unknown as WordPressPublicationClient,
    new ConversationStateMachineService(prisma),
  );
  return {
    reporter,
    category,
    story,
    conversation,
    preparation,
    event,
    approval,
    attempt,
    appliedVersion,
    wordpress,
    saga,
  };
}

function ledger(
  x: Awaited<ReturnType<typeof seed>>,
  status: "PUBLISHED" | "RESERVED",
): LedgerEvidence {
  return {
    outcome: status,
    publishKey: x.attempt.id,
    draftKey: x.story.wordpressDraftKey,
    postId: Number(x.story.wordpressPostId),
    expectedAppliedVersion: x.appliedVersion,
    publishedAt: status === "PUBLISHED" ? "2026-09-23 12:00:00" : null,
  };
}

describe("Round 7B.3 durable publication saga", () => {
  it("fences old publication completion and reconciles the same ledger with the new generation", async () => {
    const x = await seed("old-generation");
    const original = x.wordpress.publish.bind(x.wordpress);
    let afterReclaim: unknown;
    x.wordpress.publish = async (intent) => {
      const result = await original(intent);
      x.wordpress.getResult = ledger(x, "PUBLISHED");
      await prisma.inboundEvent.update({
        where: { id: x.event.id },
        data: { processingAttempts: 2 },
      });
      afterReclaim = await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: x.attempt.id },
      });
      return result;
    };
    await x.saga.run(x.attempt.id);
    expect(
      await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: x.attempt.id },
      }),
    ).toEqual(afterReclaim);
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({ status: StoryStatus.PUBLISHING, publishedAt: null });
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: x.event.id },
      }),
    ).toMatchObject({
      processingAttempts: 2,
      processingStatus: InboundProcessingStatus.PROCESSING,
    });
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(x.wordpress.calls).toEqual([
      `GET:${x.attempt.id}`,
      `POST:${x.attempt.id}`,
      `GET:${x.attempt.id}`,
    ]);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
  });

  it.each([null, 999])(
    "rejects independent publication authority with contract %s",
    async (version) => {
      const x = await seed(`unsupported-${version}`);
      await prisma.inboundEvent.update({
        where: { id: x.event.id },
        data: { processingContractVersion: version },
      });
      await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
        outcome: "PUBLISH_NOT_CLAIMED",
      });
      expect(x.wordpress.calls).toEqual([]);
      expect(
        await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
      ).toEqual(x.story);
      expect(
        await prisma.publishAttempt.findUniqueOrThrow({
          where: { id: x.attempt.id },
        }),
      ).toEqual(x.attempt);
      expect(
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: x.event.id },
        }),
      ).toMatchObject({
        processingAttempts: 1,
        processingContractVersion: version,
        processingStatus: InboundProcessingStatus.PROCESSING,
      });
    },
  );
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it("claims, performs GET before POST, and atomically finalises without a version increment", async () => {
    const x = await seed("success");
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    expect(x.wordpress.calls).toEqual([
      `GET:${x.attempt.id}`,
      `POST:${x.attempt.id}`,
    ]);
    expect(
      await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: x.attempt.id },
      }),
    ).toMatchObject({
      status: PublishAttemptStatus.SUCCEEDED,
      httpStatus: 200,
      errorCode: null,
    });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({ status: StoryStatus.PUBLISHED, version: 3 });
    expect(
      await prisma.conversation.findUniqueOrThrow({
        where: { id: x.conversation.id },
      }),
    ).toMatchObject({ state: ConversationState.IDLE, currentStoryId: null });
    expect(
      await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: x.event.id },
      }),
    ).toMatchObject({ processingStatus: InboundProcessingStatus.PROCESSED });
    expect(
      await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: x.preparation.id },
      }),
    ).toMatchObject({ status: DraftPreparationStatus.READY_FOR_APPROVAL });
  });

  it("recovers ledger-backed success with GET only and remains terminal on re-entry", async () => {
    const x = await seed("lost-response");
    x.wordpress.getResult = ledger(x, "PUBLISHED");
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "ALREADY_SUCCEEDED",
    });
    expect(x.wordpress.calls).toEqual([`GET:${x.attempt.id}`]);
    expect(
      await prisma.auditLog.count({
        where: { storyId: x.story.id, eventType: "story_publish_succeeded" },
      }),
    ).toBe(1);
  });

  it.each([
    [
      "reserved",
      (x: Awaited<ReturnType<typeof seed>>) => ledger(x, "RESERVED"),
      "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
    ],
    [
      "stale",
      () => new WordPressPublicationError("STALE_VERSION", "stale", 409),
      "PUBLISH_CAS_CONFLICT",
    ],
    [
      "manual",
      () => new WordPressPublicationError("STATE_MISMATCH", "state", 409),
      "WORDPRESS_PUBLISH_BLOCKED",
    ],
    [
      "auth",
      () => new WordPressPublicationError("AUTHORITY_BLOCKED", "auth", 403),
      "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
    ],
    [
      "timeout",
      () => new WordPressPublicationError("UNCERTAIN_OUTCOME", "timeout"),
      "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
    ],
  ] as const)(
    "moves %s uncertainty to reconciliation-required without success",
    async (_name, result, code) => {
      const x = await seed(`remote-${_name}`);
      const value = result(x);
      if (value instanceof Error) x.wordpress.postResult = value;
      else x.wordpress.getResult = value;
      await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
        outcome: "PUBLISH_RECONCILIATION_REQUIRED",
        reason: code,
      });
      expect(
        await prisma.publishAttempt.findUniqueOrThrow({
          where: { id: x.attempt.id },
        }),
      ).toMatchObject({
        status: PublishAttemptStatus.RECONCILIATION_REQUIRED,
        errorCode: code,
        completedAt: null,
      });
      expect(
        await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
      ).toMatchObject({ status: StoryStatus.PUBLISHING, version: 3 });
      expect(
        await prisma.conversation.findUniqueOrThrow({
          where: { id: x.conversation.id },
        }),
      ).toMatchObject({
        state: ConversationState.PUBLISHING,
        currentStoryId: x.story.id,
      });
      expect(
        (
          await prisma.inboundEvent.findUniqueOrThrow({
            where: { id: x.event.id },
          })
        ).processingStatus,
      ).toBe(InboundProcessingStatus.PROCESSING);
    },
  );

  it("allows catalogue deactivation after approval but fails local epoch mutation before remote I/O", async () => {
    const allowed = await seed("inactive-catalogue");
    await prisma.editorialCategory.update({
      where: { id: allowed.category.id },
      data: { status: "INACTIVE" },
    });
    await expect(allowed.saga.run(allowed.attempt.id)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const corrupted = await seed("mutated-story");
    await prisma.story.update({
      where: { id: corrupted.story.id },
      data: { body: "mutated" },
    });
    await expect(
      corrupted.saga.run(corrupted.attempt.id),
    ).resolves.toMatchObject({
      outcome: "PUBLISH_FAILED",
      reason: "PUBLISH_LOCAL_INVARIANT_CORRUPTION",
    });
    expect(corrupted.wordpress.calls).toEqual([]);
    expect(
      await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: corrupted.attempt.id },
      }),
    ).toMatchObject({
      status: PublishAttemptStatus.FAILED,
      errorMessage: null,
    });
  });

  it("fails closed when category membership is mutated after Approval", async () => {
    const x = await seed("mutated-category-membership");
    await prisma.storyCategory.delete({
      where: {
        storyId_categoryId: { storyId: x.story.id, categoryId: x.category.id },
      },
    });
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "PUBLISH_FAILED",
      reason: "PUBLISH_LOCAL_INVARIANT_CORRUPTION",
    });
    expect(x.wordpress.calls).toEqual([]);
  });

  it("fails closed when media membership is mutated after Approval", async () => {
    const x = await seed("mutated-media-membership");
    await prisma.storyMedia.create({
      data: {
        storyId: x.story.id,
        providerMediaId: `${marker}:late-media:${randomUUID()}`,
        mediaType: StoryMediaType.IMAGE,
        status: "UPLOADED",
        wordpressMediaId: ++postIdentity,
        position: 0,
      },
    });
    await expect(x.saga.run(x.attempt.id)).resolves.toMatchObject({
      outcome: "PUBLISH_FAILED",
      reason: "PUBLISH_LOCAL_INVARIANT_CORRUPTION",
    });
    expect(x.wordpress.calls).toEqual([]);
  });

  it("permits exactly one claim under 20-way contention", async () => {
    const x = await seed("contention");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => x.saga.run(x.attempt.id)),
    );
    expect(
      results.filter((result) => result.outcome === "PROCESSED"),
    ).toHaveLength(1);
    expect(
      x.wordpress.calls.filter((call) => call.startsWith("POST:")),
    ).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { storyId: x.story.id, eventType: "story_publish_started" },
      }),
    ).toBe(1);
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
  });

  it("driver selects only PENDING/IN_PROGRESS and supervised reconciliation only finalises exact ledger evidence", async () => {
    const pending = await seed("driver-pending");
    const blocked = await seed("driver-blocked");
    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: blocked.attempt.id },
        data: {
          status: PublishAttemptStatus.RECONCILIATION_REQUIRED,
          startedAt: new Date(),
        },
      }),
      prisma.story.update({
        where: { id: blocked.story.id },
        data: { status: StoryStatus.PUBLISHING },
      }),
      prisma.conversation.update({
        where: { id: blocked.conversation.id },
        data: { state: ConversationState.PUBLISHING },
      }),
    ]);
    const driver = new PublishAttemptDriverService(prisma, pending.saga);
    const results = await driver.runOnce(100);
    expect(
      results.some((result) => result.publishAttemptId === pending.attempt.id),
    ).toBe(true);
    expect(
      results.some((result) => result.publishAttemptId === blocked.attempt.id),
    ).toBe(false);
    blocked.wordpress.getResult = ledger(blocked, "PUBLISHED");
    await expect(
      blocked.saga.reconcileSupervised(blocked.attempt.id),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(blocked.wordpress.calls).toEqual([`GET:${blocked.attempt.id}`]);
  });

  it("makes process(eventId) recovery and scan-driver recovery converge on one attempt", async () => {
    const x = await seed("process-driver-race");
    const config = new ConfigService<ApplicationConfiguration, true>({
      round7: { controlCutoverAt: new Date(0) },
    } as ApplicationConfiguration);
    const approval = new Round7ApprovalService(
      prisma,
      {} as WordPressDraftClient,
      config,
    );
    const processor = new InboundEventProcessingService(
      prisma,
      new ReporterAuthorizationService(),
      new ConversationProvisioningService(),
      new StoredWhatsappEventParser(),
      new StoryEventProcessor(new ConversationStateMachineService(prisma)),
      undefined,
      config,
      undefined,
      undefined,
      undefined,
      approval,
      x.saga,
    );
    const driver = new PublishAttemptDriverService(prisma, x.saga);
    const settled = await Promise.allSettled([
      processor.process(x.event.id),
      driver.runOnce(100),
    ]);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      x.wordpress.calls.filter((call) => call.startsWith("POST:")),
    ).toHaveLength(1);
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: x.attempt.id },
      }),
    ).toMatchObject({
      status: PublishAttemptStatus.SUCCEEDED,
      attemptNumber: 1,
    });
  });
});
