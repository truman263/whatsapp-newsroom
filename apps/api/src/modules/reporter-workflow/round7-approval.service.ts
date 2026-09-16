import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApprovalDecision,
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundProcessingStatus,
  MediaProcessingStatus,
  OutboundMessageStatus,
  OutboundMessageType,
  Prisma,
  PublishAttemptStatus,
  PublishOperation,
  ReporterStatus,
  StoryStatus,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../../config/configuration";
import { PrismaService } from "../../database/prisma.service";
import type { ParsedStoredEvent } from "../story-collection/story-collection.types";
import { WordPressDraftClient } from "../wordpress-draft/wordpress-draft.client";
import type { CanonicalDraftState } from "../wordpress-draft/wordpress-draft-state";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const PREFIX = "newsroom:v1:story:approve:";
const ALLOWED_PROMPT_STATUS = new Set<OutboundMessageStatus>([
  OutboundMessageStatus.SENT,
  OutboundMessageStatus.DELIVERED,
]);

export type ApprovalControl =
  { kind: "TEXT" } | { kind: "INTERACTIVE"; promptId: string };
export type ApprovalHandoff = {
  outcome: "APPROVAL_PENDING";
  approvalId: string;
  publishAttemptId: string;
  storyId: string;
};
export class Round7ApprovalError extends Error {
  constructor(
    readonly code:
      | "CONTROL_NOT_ENABLED"
      | "APPROVAL_AMBIGUOUS"
      | "APPROVAL_IDENTITY_CONFLICT"
      | "APPROVAL_PROMPT_NOT_SENT"
      | "APPROVAL_STATE_MISMATCH"
      | "WORDPRESS_STATE_MISMATCH"
      | "APPROVAL_INVARIANT_CORRUPTION",
  ) {
    super(code);
  }
}

export function approvalControl(
  parsed: ParsedStoredEvent,
): ApprovalControl | null {
  if (parsed.kind === "TEXT")
    return parsed.text.trim() === "/approve" ? { kind: "TEXT" } : null;
  if (parsed.kind !== "INTERACTIVE" || !parsed.replyId.startsWith(PREFIX))
    return null;
  const promptId = parsed.replyId.slice(PREFIX.length);
  return UUID.test(promptId) && parsed.replyId === `${PREFIX}${promptId}`
    ? { kind: "INTERACTIVE", promptId }
    : null;
}

type Candidate = Prisma.DraftPreparationGetPayload<{
  include: {
    approvalPromptOutboundMessage: true;
    story: {
      include: {
        activeInConversation: true;
        categories: { include: { category: true } };
        media: true;
      };
    };
  };
}>;

@Injectable()
export class Round7ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: WordPressDraftClient,
    private readonly config: ConfigService<ApplicationConfiguration, true>,
    @Optional() private readonly authorityLocked?: () => void,
  ) {}

  async process(
    eventId: string,
    control: ApprovalControl,
  ): Promise<ApprovalHandoff> {
    const event = await this.prisma.inboundEvent.findUnique({
      where: { id: eventId },
    });
    if (!event || event.processingStatus !== InboundProcessingStatus.PROCESSING)
      throw new Round7ApprovalError("APPROVAL_STATE_MISMATCH");
    if (
      event.receivedAt.getTime() <
      this.config.get("round7.controlCutoverAt", { infer: true }).getTime()
    )
      throw new Round7ApprovalError("CONTROL_NOT_ENABLED");
    const reporter = await this.prisma.reporter.findUnique({
      where: { phoneNumber: event.senderPhone },
    });
    if (
      !reporter ||
      reporter.status !== ReporterStatus.ACTIVE ||
      (event.reporterId !== null && event.reporterId !== reporter.id)
    )
      throw new Round7ApprovalError("APPROVAL_IDENTITY_CONFLICT");
    const candidate = await this.resolveCandidate(reporter.id, control);
    await this.phaseZero(candidate);
    return this.prisma.$transaction((tx) =>
      this.approve(tx, eventId, reporter.id, candidate),
    );
  }

  async recover(eventId: string): Promise<ApprovalHandoff | null> {
    const event = await this.prisma.inboundEvent.findUnique({
      where: { id: eventId },
      select: { processingStatus: true, reporterId: true },
    });
    if (event?.processingStatus !== InboundProcessingStatus.PROCESSING)
      return null;
    const approval = await this.prisma.approval.findUnique({
      where: { inboundEventId: eventId },
      include: {
        publishAttempt: true,
        story: { include: { activeInConversation: true } },
        draftPreparation: true,
      },
    });
    if (!approval) return null;
    const attempt = approval.publishAttempt;
    const postId = approval.story.wordpressPostId;
    if (
      !attempt ||
      approval.inboundEventId !== eventId ||
      event.reporterId !== approval.reporterId ||
      approval.decision !== ApprovalDecision.APPROVED ||
      approval.story.id !== approval.storyId ||
      approval.story.reporterId !== approval.reporterId ||
      approval.story.version !== approval.storyVersion ||
      !approval.story.activeInConversation ||
      approval.story.activeInConversation.currentStoryId !== approval.storyId ||
      approval.story.activeInConversation.reporterId !== approval.reporterId ||
      approval.draftPreparation.id !== approval.draftPreparationId ||
      approval.draftPreparation.storyId !== approval.storyId ||
      approval.draftPreparation.storyVersion !== approval.storyVersion ||
      approval.draftPreparation.status !==
        DraftPreparationStatus.READY_FOR_APPROVAL ||
      !SHA.test(approval.wordpressAppliedVersion) ||
      approval.draftPreparation.wordpressAppliedVersion !==
        approval.wordpressAppliedVersion ||
      postId === null ||
      postId <= 0n ||
      approval.draftPreparation.wordpressPostId !== postId ||
      attempt.operation !== PublishOperation.PUBLISH ||
      attempt.approvalId !== approval.id ||
      attempt.storyId !== approval.storyId ||
      attempt.wordpressPostId !== postId ||
      attempt.idempotencyKey !==
        `draft-publish:${approval.draftPreparationId}:${approval.storyVersion}`
    )
      throw new Round7ApprovalError("APPROVAL_INVARIANT_CORRUPTION");
    const pendingPosture =
      approval.story.status === StoryStatus.APPROVED &&
      approval.story.activeInConversation.state ===
        ConversationState.AWAITING_APPROVAL;
    const publishingPosture =
      approval.story.status === StoryStatus.PUBLISHING &&
      approval.story.activeInConversation.state ===
        ConversationState.PUBLISHING;
    if (attempt.status === PublishAttemptStatus.PENDING && !pendingPosture)
      throw new Round7ApprovalError("APPROVAL_INVARIANT_CORRUPTION");
    if (
      attempt.status === PublishAttemptStatus.IN_PROGRESS &&
      !publishingPosture
    )
      throw new Round7ApprovalError("APPROVAL_INVARIANT_CORRUPTION");
    if (attempt.status === PublishAttemptStatus.RECONCILIATION_REQUIRED) {
      if (!publishingPosture)
        throw new Round7ApprovalError("APPROVAL_INVARIANT_CORRUPTION");
      return null;
    }
    if (
      !new Set<PublishAttemptStatus>([
        PublishAttemptStatus.PENDING,
        PublishAttemptStatus.IN_PROGRESS,
      ]).has(attempt.status)
    )
      return null;
    return {
      outcome: "APPROVAL_PENDING",
      approvalId: approval.id,
      publishAttemptId: attempt.id,
      storyId: approval.storyId,
    };
  }

  private async resolveCandidate(
    reporterId: string,
    control: ApprovalControl,
  ): Promise<NonNullable<Candidate>> {
    if (control.kind === "INTERACTIVE") {
      const prompt = await this.prisma.outboundMessage.findUnique({
        where: { id: control.promptId },
        select: { draftPreparationApprovalPrompt: { select: { id: true } } },
      });
      if (!prompt?.draftPreparationApprovalPrompt)
        throw new Round7ApprovalError("APPROVAL_IDENTITY_CONFLICT");
      const candidate = await this.candidateByPreparation(
        prompt.draftPreparationApprovalPrompt.id,
      );
      if (!candidate || candidate.story.reporterId !== reporterId)
        throw new Round7ApprovalError("APPROVAL_IDENTITY_CONFLICT");
      if (
        !ALLOWED_PROMPT_STATUS.has(
          candidate.approvalPromptOutboundMessage!.status,
        )
      )
        throw new Round7ApprovalError("APPROVAL_PROMPT_NOT_SENT");
      this.assertCandidate(candidate);
      return candidate;
    }
    const rows = await this.prisma.draftPreparation.findMany({
      where: {
        status: DraftPreparationStatus.READY_FOR_APPROVAL,
        story: { reporterId, status: StoryStatus.AWAITING_APPROVAL },
        approvalPromptOutboundMessage: {
          is: {
            reporterId,
            type: OutboundMessageType.INTERACTIVE,
            status: {
              in: [OutboundMessageStatus.SENT, OutboundMessageStatus.DELIVERED],
            },
          },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const candidates: NonNullable<Candidate>[] = [];
    for (const row of rows) {
      const candidate = await this.candidateByPreparation(row.id);
      if (candidate) {
        try {
          this.assertCandidate(candidate);
          candidates.push(candidate);
        } catch {
          /* invalid prompts never become fallback authority */
        }
      }
    }
    if (candidates.length !== 1)
      throw new Round7ApprovalError("APPROVAL_AMBIGUOUS");
    return candidates[0]!;
  }

  private candidateByPreparation(id: string): Promise<Candidate | null> {
    return this.prisma.draftPreparation.findUnique({
      where: { id },
      include: {
        approvalPromptOutboundMessage: true,
        story: {
          include: {
            activeInConversation: true,
            categories: {
              include: { category: true },
              orderBy: { categoryId: "asc" },
            },
            media: { orderBy: [{ position: "asc" }, { id: "asc" }] },
          },
        },
      },
    });
  }

  private assertCandidate(c: NonNullable<Candidate>): void {
    const s = c.story,
      p = c.approvalPromptOutboundMessage,
      payload = p?.payload as Record<string, unknown> | undefined;
    if (
      c.status !== DraftPreparationStatus.READY_FOR_APPROVAL ||
      c.supersededAt !== null ||
      c.storyVersion !== s.version ||
      s.status !== StoryStatus.AWAITING_APPROVAL ||
      !s.wordpressPostId ||
      c.wordpressPostId !== s.wordpressPostId ||
      !c.wordpressAppliedVersion ||
      !SHA.test(c.wordpressAppliedVersion) ||
      !p ||
      c.approvalPromptOutboundMessageId !== p.id ||
      p.reporterId !== s.reporterId ||
      p.storyId !== s.id ||
      p.type !== OutboundMessageType.INTERACTIVE ||
      p.correlationKey !== c.approvalPromptCorrelationKey ||
      !ALLOWED_PROMPT_STATUS.has(p.status) ||
      s.activeInConversation?.reporterId !== s.reporterId ||
      s.activeInConversation.currentStoryId !== s.id ||
      s.activeInConversation.state !== ConversationState.AWAITING_APPROVAL ||
      JSON.stringify(Object.keys(payload ?? {}).sort()) !==
        JSON.stringify([
          "draftPreparationId",
          "kind",
          "storyId",
          "storyVersion",
          "wordpressAppliedVersion",
        ]) ||
      payload?.kind !== "APPROVAL_PROMPT_V1" ||
      payload.draftPreparationId !== c.id ||
      payload.storyId !== s.id ||
      payload.storyVersion !== s.version ||
      payload.wordpressAppliedVersion !== c.wordpressAppliedVersion
    )
      throw new Round7ApprovalError("APPROVAL_IDENTITY_CONFLICT");
  }

  private desired(c: NonNullable<Candidate>): CanonicalDraftState {
    const s = c.story;
    if (!s.headline || !s.body || !s.byline)
      throw new Round7ApprovalError("APPROVAL_STATE_MISMATCH");
    const categories = s.categories.map((x) =>
      Number(x.category.wordpressCategoryId),
    );
    if (
      !categories.length ||
      categories.some((x) => !Number.isSafeInteger(x) || x < 1) ||
      s.categories.some(
        (x) => x.category.status !== EditorialCategoryStatus.ACTIVE,
      ) ||
      s.media.some(
        (x) =>
          x.status !== MediaProcessingStatus.UPLOADED || !x.wordpressMediaId,
      )
    )
      throw new Round7ApprovalError("APPROVAL_STATE_MISMATCH");
    return {
      title: s.headline,
      content: s.body,
      excerpt: "",
      categories: [...new Set(categories)].sort((a, b) => a - b),
      editorial_byline: s.byline,
      featured_media_key: s.media[0]?.id ?? null,
    };
  }

  private async phaseZero(c: NonNullable<Candidate>): Promise<void> {
    const expected = this.desired(c);
    try {
      const actual = await this.drafts.getDraftState(c.story.wordpressDraftKey);
      if (
        actual.draft_key !== c.story.wordpressDraftKey ||
        actual.post_id !== Number(c.wordpressPostId) ||
        actual.status !== "draft" ||
        actual.applied_version !== c.wordpressAppliedVersion ||
        !sameState(actual, expected)
      )
        throw new Error("mismatch");
    } catch {
      throw new Round7ApprovalError("WORDPRESS_STATE_MISMATCH");
    }
  }

  private async approve(
    tx: Prisma.TransactionClient,
    eventId: string,
    reporterId: string,
    snapshot: NonNullable<Candidate>,
  ): Promise<ApprovalHandoff> {
    const s = snapshot.story,
      p = snapshot.approvalPromptOutboundMessage!;
    await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${eventId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Reporter" WHERE "id"=${reporterId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${s.activeInConversation!.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${s.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT ec."id" FROM "EditorialCategory" ec JOIN "StoryCategory" sc ON sc."categoryId"=ec."id" WHERE sc."storyId"=${s.id}::uuid ORDER BY ec."id" FOR UPDATE OF ec`;
    await tx.$queryRaw`SELECT "storyId","categoryId" FROM "StoryCategory" WHERE "storyId"=${s.id}::uuid ORDER BY "storyId","categoryId" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "storyId"=${s.id}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${snapshot.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${p.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Approval" WHERE "storyId"=${s.id}::uuid OR "inboundEventId"=${eventId}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "storyId"=${s.id}::uuid AND "operation"='PUBLISH'::"PublishOperation" ORDER BY "id" FOR UPDATE`;
    this.authorityLocked?.();
    const event = await tx.inboundEvent.findUnique({ where: { id: eventId } }),
      reporter = await tx.reporter.findUnique({ where: { id: reporterId } }),
      fresh = await tx.draftPreparation.findUnique({
        where: { id: snapshot.id },
        include: {
          approvalPromptOutboundMessage: true,
          story: {
            include: {
              activeInConversation: true,
              categories: {
                include: { category: true },
                orderBy: { categoryId: "asc" },
              },
              media: { orderBy: [{ position: "asc" }, { id: "asc" }] },
            },
          },
        },
      });
    if (
      !event ||
      event.processingStatus !== InboundProcessingStatus.PROCESSING ||
      (event.reporterId !== null && event.reporterId !== reporterId) ||
      event.senderPhone !== reporter?.phoneNumber ||
      event.receivedAt.getTime() <
        this.config.get("round7.controlCutoverAt", { infer: true }).getTime() ||
      reporter.status !== ReporterStatus.ACTIVE ||
      !fresh ||
      fresh.story.reporterId !== reporterId ||
      !sameSnapshot(snapshot, fresh)
    )
      throw new Round7ApprovalError(
        event?.reporterId !== null && event?.reporterId !== reporterId
          ? "APPROVAL_IDENTITY_CONFLICT"
          : "APPROVAL_STATE_MISMATCH",
      );
    this.assertCandidate(fresh);
    this.desired(fresh);
    const existing = await tx.approval.findFirst({
      where: {
        OR: [
          { storyId: s.id },
          { inboundEventId: eventId },
          { draftPreparationId: snapshot.id },
        ],
      },
      include: { publishAttempt: true },
    });
    if (existing)
      throw new Round7ApprovalError("APPROVAL_INVARIANT_CORRUPTION");
    await tx.inboundEvent.update({
      where: { id: eventId },
      data: { reporterId },
    });
    const approval = await tx.approval.create({
      data: {
        storyId: s.id,
        reporterId,
        inboundEventId: eventId,
        draftPreparationId: snapshot.id,
        storyVersion: s.version,
        wordpressAppliedVersion: snapshot.wordpressAppliedVersion!,
        decision: ApprovalDecision.APPROVED,
      },
    });
    const now = new Date();
    const changed = await tx.story.updateMany({
      where: {
        id: s.id,
        status: StoryStatus.AWAITING_APPROVAL,
        version: s.version,
      },
      data: { status: StoryStatus.APPROVED, approvedAt: now },
    });
    if (changed.count !== 1)
      throw new Round7ApprovalError("APPROVAL_STATE_MISMATCH");
    const max = await tx.publishAttempt.aggregate({
      where: { storyId: s.id, operation: PublishOperation.PUBLISH },
      _max: { attemptNumber: true },
    });
    const attempt = await tx.publishAttempt.create({
      data: {
        storyId: s.id,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
        attemptNumber: (max._max.attemptNumber ?? 0) + 1,
        idempotencyKey: `draft-publish:${snapshot.id}:${s.version}`,
        approvalId: approval.id,
        wordpressPostId: s.wordpressPostId,
      },
    });
    await tx.auditLog.create({
      data: {
        eventType: "story_approval_bound",
        actorType: AuditActorType.REPORTER,
        reporterId,
        storyId: s.id,
        inboundEventId: eventId,
        entityType: "Approval",
        entityId: approval.id,
        metadata: {
          storyId: s.id,
          approvalId: approval.id,
          preparationId: snapshot.id,
          publishAttemptId: attempt.id,
          storyVersion: s.version,
          wordpressAppliedVersion: snapshot.wordpressAppliedVersion,
          wordpressPostId: Number(s.wordpressPostId),
          storyStatusBefore: "AWAITING_APPROVAL",
          storyStatusAfter: "APPROVED",
        },
      },
    });
    return {
      outcome: "APPROVAL_PENDING",
      approvalId: approval.id,
      publishAttemptId: attempt.id,
      storyId: s.id,
    };
  }
}

function sameState(a: CanonicalDraftState, b: CanonicalDraftState): boolean {
  return (
    a.title === b.title &&
    a.content === b.content &&
    a.excerpt === b.excerpt &&
    a.editorial_byline === b.editorial_byline &&
    a.featured_media_key === b.featured_media_key &&
    a.categories.length === b.categories.length &&
    a.categories.every((v, i) => v === b.categories[i])
  );
}
function sameSnapshot(
  a: NonNullable<Candidate>,
  b: NonNullable<Candidate>,
): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.story.id === b.story.id &&
    a.story.reporterId === b.story.reporterId &&
    a.story.status === b.story.status &&
    a.story.version === b.story.version &&
    a.story.headline === b.story.headline &&
    a.story.body === b.story.body &&
    a.story.byline === b.story.byline &&
    a.story.wordpressDraftKey === b.story.wordpressDraftKey &&
    a.story.wordpressPostId === b.story.wordpressPostId &&
    a.wordpressAppliedVersion === b.wordpressAppliedVersion &&
    a.wordpressPostId === b.wordpressPostId &&
    a.approvalPromptOutboundMessageId === b.approvalPromptOutboundMessageId &&
    a.story.activeInConversation?.id === b.story.activeInConversation?.id &&
    a.story.activeInConversation?.version ===
      b.story.activeInConversation?.version &&
    a.story.categories
      .map(
        (x) =>
          `${x.categoryId}:${x.category.status}:${x.category.wordpressCategoryId.toString()}`,
      )
      .join() ===
      b.story.categories
        .map(
          (x) =>
            `${x.categoryId}:${x.category.status}:${x.category.wordpressCategoryId.toString()}`,
        )
        .join() &&
    a.story.media
      .map(
        (x) =>
          `${x.id}:${x.status}:${x.wordpressMediaId?.toString()}:${x.position}`,
      )
      .join() ===
      b.story.media
        .map(
          (x) =>
            `${x.id}:${x.status}:${x.wordpressMediaId?.toString()}:${x.position}`,
        )
        .join()
  );
}
