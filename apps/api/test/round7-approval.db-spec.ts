/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  ApprovalDecision,
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
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
import {
  Round7ApprovalError,
  Round7ApprovalService,
} from "../src/modules/reporter-workflow/round7-approval.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { Round6RevisionService } from "../src/modules/reporter-workflow/round6-revision.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import type { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import {
  draftStateFingerprint,
  type WordPressDraftState,
} from "../src/modules/wordpress-draft/wordpress-draft-state";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(120_000);
const prisma = new PrismaService();
const marker = `round7b2:${randomUUID()}`;
let wordpressIdentity = BigInt(Date.now()) * 1000n;

class DraftProof {
  calls = 0;
  state!: WordPressDraftState;
  error?: Error;
  beforeGet?: () => Promise<void>;
  async getDraftState(): Promise<WordPressDraftState> {
    this.calls++;
    await this.beforeGet?.();
    if (this.error) throw this.error;
    return this.state;
  }
}
function inbound(
  approval: Round7ApprovalService,
  config: ConfigService<ApplicationConfiguration, true>,
): InboundEventProcessingService {
  return new InboundEventProcessingService(
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
  );
}
async function approvalEvent(
  x: Awaited<ReturnType<typeof seed>>,
  name: string,
  replyId: string,
  sequence: bigint,
) {
  const occurred = new Date("2026-09-14T00:00:00.000Z");
  const providerMessageId = `${marker}:integration:${name}`;
  return prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      reporterId: x.reporter.id,
      senderPhone: x.reporter.phoneNumber,
      senderIngestSequence: sequence,
      eventType: InboundEventType.INTERACTIVE,
      processingStatus: InboundProcessingStatus.RECEIVED,
      providerOccurredAt: occurred,
      receivedAt: x.receivedAt,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: x.reporter.phoneNumber.slice(1),
          timestamp: String(occurred.getTime() / 1000),
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: replyId } },
        },
      },
    },
  });
}

async function seed(
  name: string,
  status: OutboundMessageStatus = OutboundMessageStatus.SENT,
) {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
      displayName: `${marker}:${name}`,
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
      version: 3,
      wordpressPostId: ++wordpressIdentity,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      state: ConversationState.AWAITING_APPROVAL,
      currentStoryId: story.id,
    },
  });
  const category = await prisma.editorialCategory.create({
    data: {
      wordpressCategoryId: ++wordpressIdentity,
      name: `${marker}:${name}`,
      slug: `r7-${randomUUID()}`,
      status: EditorialCategoryStatus.ACTIVE,
    },
  });
  await prisma.storyCategory.create({
    data: { storyId: story.id, categoryId: category.id },
  });
  const prepEvent = await prisma.inboundEvent.create({
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
      inboundEventId: prepEvent.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      wordpressPostId: story.wordpressPostId,
      wordpressAppliedVersion: "a".repeat(64),
      approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
      previewExpiresAt: new Date(Date.now() + 60000),
    },
  });
  const prompt = await prisma.outboundMessage.create({
    data: {
      reporterId: reporter.id,
      storyId: story.id,
      type: OutboundMessageType.INTERACTIVE,
      status,
      correlationKey: preparation.approvalPromptCorrelationKey,
      payload: {
        kind: "APPROVAL_PROMPT_V1",
        draftPreparationId: preparation.id,
        storyId: story.id,
        storyVersion: story.version,
        wordpressAppliedVersion: preparation.wordpressAppliedVersion,
      },
    },
  });
  await prisma.draftPreparation.update({
    where: { id: preparation.id },
    data: { approvalPromptOutboundMessageId: prompt.id },
  });
  const receivedAt = new Date("2026-09-14T00:00:00.000Z");
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: `${marker}:approve:${name}`,
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: 2n,
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSING,
      receivedAt,
      rawPayload: { message: {} },
    },
  });
  const desired = {
    title: "Headline",
    content: "Body",
    excerpt: "",
    categories: [Number(category.wordpressCategoryId)],
    editorial_byline: "Byline",
    featured_media_key: null,
  };
  const draft = new DraftProof();
  draft.state = {
    draft_key: story.wordpressDraftKey,
    post_id: Number(story.wordpressPostId),
    status: "draft",
    author_id: 3,
    applied_version: draftStateFingerprint(desired),
    ...desired,
  };
  await prisma.draftPreparation.update({
    where: { id: preparation.id },
    data: { wordpressAppliedVersion: draft.state.applied_version },
  });
  await prisma.outboundMessage.update({
    where: { id: prompt.id },
    data: {
      payload: {
        kind: "APPROVAL_PROMPT_V1",
        draftPreparationId: preparation.id,
        storyId: story.id,
        storyVersion: story.version,
        wordpressAppliedVersion: draft.state.applied_version,
      },
    },
  });
  const config = new ConfigService<ApplicationConfiguration, true>({
    round7: { controlCutoverAt: receivedAt },
  } as ApplicationConfiguration);
  const service = new Round7ApprovalService(
    prisma,
    draft as unknown as WordPressDraftClient,
    config,
  );
  return {
    reporter,
    story,
    conversation,
    category,
    preparation,
    prompt,
    event,
    draft,
    service,
    receivedAt,
  };
}

describe("Round 7B.2 approval authority", () => {
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());
  it.each([OutboundMessageStatus.SENT, OutboundMessageStatus.DELIVERED])(
    "creates exact local authority for %s prompt and preserves handoff posture",
    async (status) => {
      const x = await seed(`success-${status}`, status);
      const result = await x.service.process(x.event.id, {
        kind: "INTERACTIVE",
        promptId: x.prompt.id,
      });
      const approval = await prisma.approval.findUniqueOrThrow({
        where: { id: result.approvalId },
      });
      const attempt = await prisma.publishAttempt.findUniqueOrThrow({
        where: { id: result.publishAttemptId },
      });
      const story = await prisma.story.findUniqueOrThrow({
        where: { id: x.story.id },
      });
      const event = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: x.event.id },
      });
      const prep = await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: x.preparation.id },
      });
      expect(approval).toMatchObject({
        storyId: x.story.id,
        reporterId: x.reporter.id,
        inboundEventId: x.event.id,
        draftPreparationId: x.preparation.id,
        storyVersion: 3,
        decision: "APPROVED",
      });
      expect(attempt).toMatchObject({
        operation: "PUBLISH",
        status: "PENDING",
        approvalId: approval.id,
        idempotencyKey: `draft-publish:${x.preparation.id}:3`,
        attemptNumber: 1,
      });
      expect(story).toMatchObject({
        status: "APPROVED",
        version: 3,
        publishedAt: null,
        wordpressPostUrl: null,
      });
      expect(story.approvedAt).not.toBeNull();
      expect(event.processingStatus).toBe("PROCESSING");
      expect(prep.status).toBe("READY_FOR_APPROVAL");
      expect(x.draft.calls).toBe(1);
    },
  );
  it("resolves exactly one text fallback and deterministically recovers without duplicates", async () => {
    const x = await seed("text");
    const first = await x.service.process(x.event.id, { kind: "TEXT" });
    const second = await x.service.recover(x.event.id);
    expect(second).toEqual(first);
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: "PUBLISH" },
      }),
    ).toBe(1);
  });
  it("fails approval closed on partial existing authority and creates no duplicate authority", async () => {
    const x = await seed("partial-authority");
    const approval = await prisma.approval.create({
      data: {
        storyId: x.story.id,
        reporterId: x.reporter.id,
        inboundEventId: x.event.id,
        draftPreparationId: x.preparation.id,
        storyVersion: x.story.version,
        wordpressAppliedVersion: x.draft.state.applied_version,
        decision: ApprovalDecision.APPROVED,
      },
    });
    await prisma.publishAttempt.create({
      data: {
        storyId: x.story.id,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
        attemptNumber: 1,
        idempotencyKey: `wrong:${x.preparation.id}`,
        approvalId: approval.id,
        wordpressPostId: x.story.wordpressPostId,
      },
    });
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_INVARIANT_CORRUPTION" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: PublishOperation.PUBLISH },
      }),
    ).toBe(1);
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({
      status: StoryStatus.AWAITING_APPROVAL,
      version: x.story.version,
    });
  });
  it("fails Phase 0 closed before creating local authority", async () => {
    const x = await seed("drift");
    x.draft.state = { ...x.draft.state, title: "drift" };
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject<Partial<Round7ApprovalError>>({
      code: "WORDPRESS_STATE_MISMATCH",
    });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: "PUBLISH" },
      }),
    ).toBe(0);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }))
        .status,
    ).toBe("AWAITING_APPROVAL");
  });
  it("uses receivedAt equality for cutover and ignores provider time", async () => {
    const x = await seed("cutover");
    const future = new Date(x.receivedAt.getTime() + 1);
    const service = new Round7ApprovalService(
      prisma,
      x.draft as unknown as WordPressDraftClient,
      new ConfigService({ round7: { controlCutoverAt: future } }),
    );
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { providerOccurredAt: new Date("2099-01-01T00:00:00Z") },
    });
    await expect(
      service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "CONTROL_NOT_ENABLED" });
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).resolves.toMatchObject({ outcome: "APPROVAL_PENDING" });
  });
  it.each([
    OutboundMessageStatus.PENDING,
    OutboundMessageStatus.SENDING,
    OutboundMessageStatus.FAILED,
  ])("rejects non-authoritative prompt status %s", async (status) => {
    const x = await seed(`prompt-${status}`, status);
    await expect(
      x.service.process(x.event.id, {
        kind: "INTERACTIVE",
        promptId: x.prompt.id,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_PROMPT_NOT_SENT" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
  it("does not ordinarily resume a valid reconciliation-required publishing posture", async () => {
    const x = await seed("reconcile");
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: bound.publishAttemptId },
        data: { status: PublishAttemptStatus.RECONCILIATION_REQUIRED },
      }),
      prisma.story.update({
        where: { id: x.story.id },
        data: { status: StoryStatus.PUBLISHING },
      }),
      prisma.conversation.update({
        where: { id: x.conversation.id },
        data: { state: ConversationState.PUBLISHING },
      }),
    ]);
    await expect(x.service.recover(x.event.id)).resolves.toBeNull();
  });
  it("recovers the exact IN_PROGRESS publishing handoff without executing publication", async () => {
    const x = await seed("progress");
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: bound.publishAttemptId },
        data: { status: PublishAttemptStatus.IN_PROGRESS },
      }),
      prisma.story.update({
        where: { id: x.story.id },
        data: { status: StoryStatus.PUBLISHING },
      }),
      prisma.conversation.update({
        where: { id: x.conversation.id },
        data: { state: ConversationState.PUBLISHING },
      }),
    ]);
    await expect(x.service.recover(x.event.id)).resolves.toEqual(bound);
    expect(x.draft.calls).toBe(1);
  });
  it.each([
    [PublishAttemptStatus.PENDING, true],
    [PublishAttemptStatus.IN_PROGRESS, false],
    [PublishAttemptStatus.RECONCILIATION_REQUIRED, false],
  ])("rejects impossible %s status posture", async (status, publishing) => {
    const x = await seed(`impossible-${status}`);
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.publishAttempt.update({
      where: { id: bound.publishAttemptId },
      data: { status },
    });
    if (publishing)
      await prisma.$transaction([
        prisma.story.update({
          where: { id: x.story.id },
          data: { status: StoryStatus.PUBLISHING },
        }),
        prisma.conversation.update({
          where: { id: x.conversation.id },
          data: { state: ConversationState.PUBLISHING },
        }),
      ]);
    await expect(x.service.recover(x.event.id)).rejects.toMatchObject({
      code: "APPROVAL_INVARIANT_CORRUPTION",
    });
  });
  it("fails closed when exact approval authority has no publish attempt", async () => {
    const x = await seed("corrupt");
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.publishAttempt.delete({
      where: { id: bound.publishAttemptId },
    });
    await expect(x.service.recover(x.event.id)).rejects.toMatchObject({
      code: "APPROVAL_INVARIANT_CORRUPTION",
    });
  });
  it("rejects recovery when the approval event reporter binding is corrupted", async () => {
    const x = await seed("recover-event-reporter");
    await x.service.process(x.event.id, { kind: "TEXT" });
    const other = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
        displayName: `${marker}:other-event`,
      },
    });
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { reporterId: other.id },
    });
    await expect(x.service.recover(x.event.id)).rejects.toMatchObject({
      code: "APPROVAL_INVARIANT_CORRUPTION",
    });
  });
  it("rejects recovery when the attached Conversation reporter binding is corrupted", async () => {
    const x = await seed("recover-conversation-reporter");
    await x.service.process(x.event.id, { kind: "TEXT" });
    const other = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
        displayName: `${marker}:other-conversation`,
      },
    });
    await prisma.conversation.update({
      where: { id: x.conversation.id },
      data: { reporterId: other.id },
    });
    await expect(x.service.recover(x.event.id)).rejects.toMatchObject({
      code: "APPROVAL_INVARIANT_CORRUPTION",
    });
  });
  it("rejects all-null WordPress post identity during recovery", async () => {
    const x = await seed("recover-null-post");
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.$transaction([
      prisma.story.update({
        where: { id: x.story.id },
        data: { wordpressPostId: null },
      }),
      prisma.draftPreparation.update({
        where: { id: x.preparation.id },
        data: { wordpressPostId: null },
      }),
      prisma.publishAttempt.update({
        where: { id: bound.publishAttemptId },
        data: { wordpressPostId: null },
      }),
    ]);
    await expect(x.service.recover(x.event.id)).rejects.toMatchObject({
      code: "APPROVAL_INVARIANT_CORRUPTION",
    });
  });
  it("revalidates event reporter ownership under lock after Phase 0", async () => {
    const x = await seed("event-reporter-toctou");
    const other = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${Math.floor(100000000 + Math.random() * 899999999)}`,
        displayName: `${marker}:toctou-other`,
      },
    });
    x.draft.beforeGet = async () => {
      await prisma.inboundEvent.update({
        where: { id: x.event.id },
        data: { reporterId: other.id },
      });
    };
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_IDENTITY_CONFLICT" });
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: x.event.id },
        })
      ).reporterId,
    ).toBe(other.id);
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: "PUBLISH" },
      }),
    ).toBe(0);
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }))
        .status,
    ).toBe(StoryStatus.AWAITING_APPROVAL);
  });
  it("allows exactly one winner under 20-way same-event concurrency", async () => {
    const x = await seed("concurrent");
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        x.service.process(x.event.id, {
          kind: "INTERACTIVE",
          promptId: x.prompt.id,
        }),
      ),
    );
    expect(settled.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(1);
    expect(
      await prisma.publishAttempt.count({
        where: { storyId: x.story.id, operation: "PUBLISH" },
      }),
    ).toBe(1);
  });
  it("fails when a selected category is inactive before authority", async () => {
    const x = await seed("inactive-category");
    await prisma.editorialCategory.update({
      where: { id: x.category.id },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_STATE_MISMATCH" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
  it("does not revoke durable approval when category deactivates afterward", async () => {
    const x = await seed("category-after");
    const bound = await x.service.process(x.event.id, { kind: "TEXT" });
    await prisma.editorialCategory.update({
      where: { id: x.category.id },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    expect(
      await prisma.approval.findUnique({ where: { id: bound.approvalId } }),
    ).not.toBeNull();
    expect(
      (await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }))
        .status,
    ).toBe("APPROVED");
  });
  it("fails text fallback closed when no prompt qualifies", async () => {
    const x = await seed("zero", OutboundMessageStatus.PENDING);
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_AMBIGUOUS" });
  });
  it("fails text fallback closed if candidate resolution returns multiple qualifying prompts", async () => {
    const x = await seed("multiple-fallback");
    const lookup = jest
      .spyOn(prisma.draftPreparation, "findMany")
      .mockResolvedValueOnce([
        { id: x.preparation.id },
        { id: x.preparation.id },
      ] as never);
    try {
      await expect(
        x.service.process(x.event.id, { kind: "TEXT" }),
      ).rejects.toMatchObject({ code: "APPROVAL_AMBIGUOUS" });
      expect(
        await prisma.approval.count({ where: { storyId: x.story.id } }),
      ).toBe(0);
    } finally {
      lookup.mockRestore();
    }
  });
  it.each([
    [
      "wrong post",
      (s: WordPressDraftState) => ({ ...s, post_id: s.post_id + 1 }),
    ],
    [
      "wrong key",
      (s: WordPressDraftState) => ({ ...s, draft_key: randomUUID() }),
    ],
    [
      "stale version",
      (s: WordPressDraftState) => ({ ...s, applied_version: "b".repeat(64) }),
    ],
    [
      "title drift",
      (s: WordPressDraftState) => ({ ...s, title: `${s.title}x` }),
    ],
    [
      "content drift",
      (s: WordPressDraftState) => ({ ...s, content: `${s.content}x` }),
    ],
    ["excerpt drift", (s: WordPressDraftState) => ({ ...s, excerpt: "x" })],
    [
      "category drift",
      (s: WordPressDraftState) => ({
        ...s,
        categories: [...s.categories, 999999],
      }),
    ],
    [
      "byline drift",
      (s: WordPressDraftState) => ({ ...s, editorial_byline: "other" }),
    ],
    [
      "featured drift",
      (s: WordPressDraftState) => ({ ...s, featured_media_key: randomUUID() }),
    ],
  ])("rejects Phase 0 %s without authority", async (name, change) => {
    const x = await seed(`phase-${name}`);
    x.draft.state = change(x.draft.state);
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "WORDPRESS_STATE_MISMATCH" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
  it("rejects authoritative WordPress/technical-author verification failure", async () => {
    const x = await seed("wp-failure");
    x.draft.error = new Error(
      "author mismatch rejected by authoritative endpoint",
    );
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "WORDPRESS_STATE_MISMATCH" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
  it("rejects unreconciled media before approval", async () => {
    const x = await seed("media");
    await prisma.storyMedia.create({
      data: {
        storyId: x.story.id,
        providerMediaId: `${marker}:media:${randomUUID()}`,
        mediaType: StoryMediaType.IMAGE,
        status: MediaProcessingStatus.RECEIVED,
        position: 0,
      },
    });
    await expect(
      x.service.process(x.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_STATE_MISMATCH" });
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
  it("enforces both /approve versus /revise acquisition orders", async () => {
    const revise = new Round6RevisionService(
      new ConversationStateMachineService(prisma),
    );
    const approveFirst = await seed("approve-first");
    await approveFirst.service.process(approveFirst.event.id, { kind: "TEXT" });
    const reviseEvent = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: `${marker}:revise:a`,
        reporterId: approveFirst.reporter.id,
        senderPhone: approveFirst.reporter.phoneNumber,
        senderIngestSequence: 3n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.PROCESSING,
        rawPayload: { message: {} },
      },
    });
    await expect(
      prisma.$transaction((tx) =>
        revise.reviseInTransaction(tx, {
          inboundEventId: reviseEvent.id,
          reporterId: approveFirst.reporter.id,
          conversationId: approveFirst.conversation.id,
          storyId: approveFirst.story.id,
          expectedStoryVersion: approveFirst.story.version,
        }),
      ),
    ).rejects.toMatchObject({ code: "STORY_REVISION_CONFLICT" });
    const reviseFirst = await seed("revise-first");
    const reviseEvent2 = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: `${marker}:revise:b`,
        reporterId: reviseFirst.reporter.id,
        senderPhone: reviseFirst.reporter.phoneNumber,
        senderIngestSequence: 3n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.PROCESSING,
        rawPayload: { message: {} },
      },
    });
    await prisma.$transaction((tx) =>
      revise.reviseInTransaction(tx, {
        inboundEventId: reviseEvent2.id,
        reporterId: reviseFirst.reporter.id,
        conversationId: reviseFirst.conversation.id,
        storyId: reviseFirst.story.id,
        expectedStoryVersion: reviseFirst.story.version,
      }),
    );
    await expect(
      reviseFirst.service.process(reviseFirst.event.id, { kind: "TEXT" }),
    ).rejects.toMatchObject({ code: "APPROVAL_AMBIGUOUS" });
    expect(
      (
        await prisma.story.findUniqueOrThrow({
          where: { id: reviseFirst.story.id },
        })
      ).status,
    ).toBe("COLLECTING");
  });
  it("rejects revision when durable publish authority exists in an awaiting-approval posture", async () => {
    const x = await seed("revise-inconsistent-authority");
    const approval = await prisma.approval.create({
      data: {
        storyId: x.story.id,
        reporterId: x.reporter.id,
        inboundEventId: x.event.id,
        draftPreparationId: x.preparation.id,
        storyVersion: x.story.version,
        wordpressAppliedVersion: x.draft.state.applied_version,
        decision: ApprovalDecision.APPROVED,
      },
    });
    await prisma.publishAttempt.create({
      data: {
        storyId: x.story.id,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
        attemptNumber: 1,
        idempotencyKey: `draft-publish:${x.preparation.id}:${x.story.version}`,
        approvalId: approval.id,
        wordpressPostId: x.story.wordpressPostId,
      },
    });
    const revision = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: `${marker}:revise:inconsistent`,
        reporterId: x.reporter.id,
        senderPhone: x.reporter.phoneNumber,
        senderIngestSequence: 3n,
        eventType: InboundEventType.TEXT,
        processingStatus: InboundProcessingStatus.PROCESSING,
        rawPayload: { message: {} },
      },
    });
    const revise = new Round6RevisionService(
      new ConversationStateMachineService(prisma),
    );
    await expect(
      prisma.$transaction((tx) =>
        revise.reviseInTransaction(tx, {
          inboundEventId: revision.id,
          reporterId: x.reporter.id,
          conversationId: x.conversation.id,
          storyId: x.story.id,
          expectedStoryVersion: x.story.version,
        }),
      ),
    ).rejects.toMatchObject({ code: "STORY_REVISION_CONFLICT" });
    expect(
      await prisma.story.findUniqueOrThrow({ where: { id: x.story.id } }),
    ).toMatchObject({
      status: StoryStatus.AWAITING_APPROVAL,
      version: x.story.version,
    });
    expect(
      await prisma.draftPreparation.findUniqueOrThrow({
        where: { id: x.preparation.id },
      }),
    ).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      supersededAt: null,
    });
  });
  it("runs real overlapping approve/revise races with exactly one winner", async () => {
    for (const first of ["approve", "revise"] as const) {
      const x = await seed(`race-${first}`);
      const revision = await prisma.inboundEvent.create({
        data: {
          provider: Provider.WHATSAPP,
          providerMessageId: `${marker}:race:${first}`,
          reporterId: x.reporter.id,
          senderPhone: x.reporter.phoneNumber,
          senderIngestSequence: 3n,
          eventType: InboundEventType.TEXT,
          processingStatus: InboundProcessingStatus.PROCESSING,
          rawPayload: { message: {} },
        },
      });
      let release!: () => void;
      const locked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const config = new ConfigService<ApplicationConfiguration, true>({
        round7: { controlCutoverAt: x.receivedAt },
      } as ApplicationConfiguration);
      const approvalService = new Round7ApprovalService(
        prisma,
        x.draft as unknown as WordPressDraftClient,
        config,
        first === "approve" ? release : undefined,
      );
      const revise = new Round6RevisionService(
        new ConversationStateMachineService(prisma),
        first === "revise" ? release : undefined,
      );
      const approve = () =>
        approvalService.process(x.event.id, { kind: "TEXT" });
      const reviseCall = () =>
        prisma.$transaction(
          (tx) =>
            revise.reviseInTransaction(tx, {
              inboundEventId: revision.id,
              reporterId: x.reporter.id,
              conversationId: x.conversation.id,
              storyId: x.story.id,
              expectedStoryVersion: x.story.version,
            }),
          { timeout: 10000 },
        );
      const lead = first === "approve" ? approve() : reviseCall();
      await locked;
      const follow = first === "approve" ? reviseCall() : approve();
      const results = await Promise.allSettled([lead, follow]);
      expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      const story = await prisma.story.findUniqueOrThrow({
        where: { id: x.story.id },
      });
      expect(
        first === "approve"
          ? story.status === StoryStatus.APPROVED && story.version === 3
          : story.status === StoryStatus.COLLECTING && story.version === 4,
      ).toBe(true);
      expect(
        await prisma.approval.count({ where: { storyId: x.story.id } }),
      ).toBe(first === "approve" ? 1 : 0);
      expect(
        await prisma.publishAttempt.count({
          where: { storyId: x.story.id, operation: "PUBLISH" },
        }),
      ).toBe(first === "approve" ? 1 : 0);
    }
  });
  it("runs deterministic barrier-controlled category/approval locking races", async () => {
    for (const first of ["category", "approval"] as const) {
      const x = await seed(`category-race-${first}`);
      let signalCategory!: () => void, releaseCategory!: () => void;
      const categoryLocked = new Promise<void>((resolve) => {
        signalCategory = resolve;
      });
      const categoryGate = new Promise<void>((resolve) => {
        releaseCategory = resolve;
      });
      const deactivate = () =>
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "EditorialCategory" WHERE "id"=${x.category.id}::uuid FOR UPDATE`;
            await tx.editorialCategory.update({
              where: { id: x.category.id },
              data: { status: EditorialCategoryStatus.INACTIVE },
            });
            signalCategory();
            await categoryGate;
          },
          { timeout: 10000 },
        );
      let signalApproval!: () => void;
      const approvalLocked = new Promise<void>((resolve) => {
        signalApproval = resolve;
      });
      const config = new ConfigService<ApplicationConfiguration, true>({
        round7: { controlCutoverAt: x.receivedAt },
      } as ApplicationConfiguration);
      const approvalService = new Round7ApprovalService(
        prisma,
        x.draft as unknown as WordPressDraftClient,
        config,
        signalApproval,
      );
      const approval = () =>
        approvalService.process(x.event.id, { kind: "TEXT" });
      let lead: Promise<unknown>, follow: Promise<unknown>;
      if (first === "category") {
        lead = deactivate();
        await categoryLocked;
        follow = approval();
        releaseCategory();
      } else {
        lead = approval();
        await approvalLocked;
        follow = deactivate();
        releaseCategory();
      }
      const results = await Promise.allSettled([lead, follow]);
      expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(
        first === "category" ? 1 : 2,
      );
      expect(
        await prisma.approval.count({ where: { storyId: x.story.id } }),
      ).toBe(first === "category" ? 0 : 1);
      expect(
        await prisma.publishAttempt.count({
          where: { storyId: x.story.id, operation: "PUBLISH" },
        }),
      ).toBe(first === "category" ? 0 : 1);
    }
  });
  it.each([
    OutboundMessageStatus.PENDING,
    OutboundMessageStatus.SENDING,
    OutboundMessageStatus.FAILED,
  ])(
    "terminally ignores %s prompt conflict and releases sender ordering",
    async (status) => {
      const x = await seed(`integration-${status}`, status);
      await prisma.inboundEvent.update({
        where: { id: x.event.id },
        data: { processingStatus: InboundProcessingStatus.IGNORED },
      });
      const event = await approvalEvent(
        x,
        `bad-${status}`,
        `newsroom:v1:story:approve:${x.prompt.id}`,
        3n,
      );
      const config = new ConfigService<ApplicationConfiguration, true>({
        round7: { controlCutoverAt: x.receivedAt },
      } as ApplicationConfiguration);
      const service = inbound(x.service, config);
      await expect(service.process(event.id)).resolves.toEqual({
        outcome: "IGNORED",
        reason: "APPROVAL_PROMPT_NOT_SENT",
      });
      expect(
        await prisma.inboundEvent
          .findUnique({ where: { id: event.id } })
          .then((v) => v?.processingStatus),
      ).toBe(InboundProcessingStatus.IGNORED);
      const following = await approvalEvent(
        x,
        `following-${status}`,
        `newsroom:v1:story:approve:${x.prompt.id}`,
        4n,
      );
      await expect(service.claim(following.id)).resolves.toEqual({
        outcome: "CLAIMED",
        processingAttempt: 1,
        processingContractVersion: 1,
      });
    },
  );
  it("terminally ignores wrong bound prompt but preserves WordPress mismatch as non-terminal", async () => {
    const x = await seed("integration-conflicts");
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { processingStatus: InboundProcessingStatus.IGNORED },
    });
    const config = new ConfigService<ApplicationConfiguration, true>({
      round7: { controlCutoverAt: x.receivedAt },
    } as ApplicationConfiguration);
    const service = inbound(x.service, config);
    const wrong = await approvalEvent(
      x,
      "wrong",
      `newsroom:v1:story:approve:${randomUUID()}`,
      3n,
    );
    await expect(service.process(wrong.id)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "APPROVAL_IDENTITY_CONFLICT",
    });
    x.draft.state = { ...x.draft.state, title: "drift" };
    const mismatch = await approvalEvent(
      x,
      "mismatch",
      `newsroom:v1:story:approve:${x.prompt.id}`,
      4n,
    );
    await expect(service.process(mismatch.id)).resolves.toEqual({
      outcome: "RETRY_REQUIRED",
      reason: "WORDPRESS_STATE_MISMATCH",
    });
    expect(
      (
        await prisma.inboundEvent.findUniqueOrThrow({
          where: { id: mismatch.id },
        })
      ).processingStatus,
    ).toBe(InboundProcessingStatus.PROCESSING);
  });
  it("keeps a later approval ORDER_BLOCKED behind an earlier same-sender event", async () => {
    const x = await seed("ordered");
    await prisma.inboundEvent.update({
      where: { id: x.event.id },
      data: { processingStatus: InboundProcessingStatus.IGNORED },
    });
    await approvalEvent(
      x,
      "earlier",
      `newsroom:v1:story:approve:${x.prompt.id}`,
      3n,
    );
    const later = await approvalEvent(
      x,
      "later",
      `newsroom:v1:story:approve:${x.prompt.id}`,
      4n,
    );
    const config = new ConfigService<ApplicationConfiguration, true>({
      round7: { controlCutoverAt: x.receivedAt },
    } as ApplicationConfiguration);
    await expect(inbound(x.service, config).process(later.id)).resolves.toEqual(
      { outcome: "ORDER_BLOCKED" },
    );
    expect(
      await prisma.approval.count({ where: { storyId: x.story.id } }),
    ).toBe(0);
  });
});
