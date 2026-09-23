import { Injectable } from "@nestjs/common";
import {
  ApprovalDecision,
  AuditActorType,
  ConversationState,
  DraftPreparationStatus,
  InboundProcessingStatus,
  MediaProcessingStatus,
  Prisma,
  PublishAttemptStatus,
  PublishOperation,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { ConversationStateMachineService } from "../reporter-workflow/conversation-state-machine.service";
import { draftStateFingerprint } from "../wordpress-draft/wordpress-draft-state";
import {
  WordPressPublicationClient,
  WordPressPublicationError,
  type LedgerEvidence,
  type PublishedEvidence,
} from "../wordpress-publication/wordpress-publication.client";
import { ROUND7_PUBLISH_AUDIT } from "./round7-publish.audit";
import { Round7PublishError } from "./round7-publish.errors";
import type {
  PublishAuthority,
  PublishSagaResult,
} from "./round7-publish.types";

const SHA = /^[0-9a-f]{64}$/u;
const TX_OPTIONS = { maxWait: 10_000, timeout: 10_000 } as const;

type Tx = Prisma.TransactionClient;
type AuthorityRow = NonNullable<Awaited<ReturnType<typeof readAuthority>>>;

@Injectable()
export class Round7PublishSagaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wordpress: WordPressPublicationClient,
    private readonly conversations: ConversationStateMachineService,
  ) {}

  async run(publishAttemptId: string): Promise<PublishSagaResult> {
    const current = await this.prisma.publishAttempt.findUnique({
      where: { id: publishAttemptId },
      select: { status: true, storyId: true },
    });
    if (!current) return { outcome: "PUBLISH_NOT_CLAIMED", publishAttemptId };
    if (current.status === PublishAttemptStatus.SUCCEEDED)
      return {
        outcome: "ALREADY_SUCCEEDED",
        publishAttemptId,
        storyId: current.storyId,
      };
    if (current.status === PublishAttemptStatus.RECONCILIATION_REQUIRED)
      return {
        outcome: "PUBLISH_RECONCILIATION_REQUIRED",
        publishAttemptId,
        reason: "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
      };
    if (current.status === PublishAttemptStatus.FAILED)
      return {
        outcome: "PUBLISH_FAILED",
        publishAttemptId,
        reason: "PUBLISH_LOCAL_INVARIANT_CORRUPTION",
      };

    let authority: PublishAuthority | null;
    if (current.status === PublishAttemptStatus.PENDING) {
      try {
        authority = await this.prisma.$transaction(
          (tx) => this.claim(tx, publishAttemptId),
          TX_OPTIONS,
        );
      } catch (error) {
        return this.handleLocalFailure(publishAttemptId, error);
      }
      if (!authority)
        return { outcome: "PUBLISH_NOT_CLAIMED", publishAttemptId };
    } else if (current.status === PublishAttemptStatus.IN_PROGRESS) {
      try {
        authority = await this.prisma.$transaction(
          (tx) =>
            this.readLockedAuthority(
              tx,
              publishAttemptId,
              PublishAttemptStatus.IN_PROGRESS,
            ),
          TX_OPTIONS,
        );
      } catch (error) {
        return this.handleLocalFailure(publishAttemptId, error);
      }
    } else {
      return { outcome: "PUBLISH_NOT_CLAIMED", publishAttemptId };
    }

    return this.publish(authority);
  }

  async reconcileSupervised(
    publishAttemptId: string,
  ): Promise<PublishSagaResult> {
    const row = await this.prisma.publishAttempt.findUnique({
      where: { id: publishAttemptId },
      select: { status: true, storyId: true },
    });
    if (row?.status === PublishAttemptStatus.SUCCEEDED)
      return {
        outcome: "ALREADY_SUCCEEDED",
        publishAttemptId,
        storyId: row.storyId,
      };
    if (row?.status !== PublishAttemptStatus.RECONCILIATION_REQUIRED)
      return { outcome: "PUBLISH_NOT_CLAIMED", publishAttemptId };
    let authority: PublishAuthority;
    try {
      authority = await this.prisma.$transaction(
        (tx) =>
          this.readLockedAuthority(
            tx,
            publishAttemptId,
            PublishAttemptStatus.RECONCILIATION_REQUIRED,
          ),
        TX_OPTIONS,
      );
    } catch (error) {
      return this.handleLocalFailure(publishAttemptId, error);
    }
    try {
      const ledger = await this.wordpress.get(authority.attemptId);
      if (ledger.outcome !== "PUBLISHED" || !matchesLedger(ledger, authority))
        return {
          outcome: "PUBLISH_RECONCILIATION_REQUIRED",
          publishAttemptId,
          reason: "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
        };
      return this.finalise(authority, toPublished(ledger), true);
    } catch {
      return {
        outcome: "PUBLISH_RECONCILIATION_REQUIRED",
        publishAttemptId,
        reason: "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
      };
    }
  }

  private async claim(
    tx: Tx,
    attemptId: string,
  ): Promise<PublishAuthority | null> {
    const authority = await this.readLockedAuthority(
      tx,
      attemptId,
      PublishAttemptStatus.PENDING,
      true,
    );
    if (!authority) return null;
    const row = await tx.publishAttempt.updateMany({
      where: {
        id: attemptId,
        operation: PublishOperation.PUBLISH,
        status: PublishAttemptStatus.PENDING,
      },
      data: {
        status: PublishAttemptStatus.IN_PROGRESS,
        startedAt: new Date(),
        completedAt: null,
        httpStatus: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (row.count !== 1) return null;
    const story = await tx.story.updateMany({
      where: {
        id: authority.storyId,
        status: StoryStatus.APPROVED,
        version: authority.storyVersion,
      },
      data: { status: StoryStatus.PUBLISHING },
    });
    if (story.count !== 1) throw invariant();
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: authority.conversationId },
      select: { version: true },
    });
    const transitioned = await this.conversations.transitionInTransaction(tx, {
      conversationId: authority.conversationId,
      reporterId: authority.reporterId,
      expectedState: ConversationState.AWAITING_APPROVAL,
      expectedVersion: conversation.version,
      targetState: ConversationState.PUBLISHING,
      storyMutation: { kind: "PRESERVE" },
      inboundEventId: authority.eventId,
    });
    if (transitioned.outcome !== "TRANSITIONED") throw invariant();
    await tx.auditLog.create({
      data: auditData(ROUND7_PUBLISH_AUDIT.STARTED, authority, {
        attemptStatusBefore: "PENDING",
        attemptStatusAfter: "IN_PROGRESS",
        storyStatusBefore: "APPROVED",
        storyStatusAfter: "PUBLISHING",
      }),
    });
    return authority;
  }

  private async publish(
    authority: PublishAuthority,
  ): Promise<PublishSagaResult> {
    let ledger;
    try {
      ledger = await this.wordpress.get(authority.attemptId);
    } catch (error) {
      return this.reconciliation(authority, remoteCode(error), statusOf(error));
    }
    if (ledger.outcome === "PUBLISHED") {
      if (!matchesLedger(ledger, authority))
        return this.reconciliation(
          authority,
          "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
        );
      return this.finalise(authority, toPublished(ledger));
    }
    if (ledger.outcome === "RESERVED")
      return this.reconciliation(
        authority,
        "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED",
      );

    try {
      const evidence = await this.wordpress.publish({
        publishKey: authority.attemptId,
        draftKey: authority.draftKey,
        postId: authority.postId,
        expectedAppliedVersion: authority.appliedVersion,
      });
      return this.finalise(authority, evidence);
    } catch (error) {
      const code = remoteCode(error);
      const httpStatus = statusOf(error);
      try {
        const reconciled = await this.wordpress.get(authority.attemptId);
        if (
          reconciled.outcome === "PUBLISHED" &&
          matchesLedger(reconciled, authority)
        )
          return this.finalise(authority, toPublished(reconciled));
      } catch {
        // Uncertainty remains and is persisted below without raw error text.
      }
      return this.reconciliation(authority, code, httpStatus);
    }
  }

  private async finalise(
    authority: PublishAuthority,
    evidence: PublishedEvidence,
    supervised = false,
  ): Promise<PublishSagaResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const fresh = await this.readLockedAuthority(
          tx,
          authority.attemptId,
          supervised
            ? PublishAttemptStatus.RECONCILIATION_REQUIRED
            : PublishAttemptStatus.IN_PROGRESS,
        );
        if (
          !sameAuthority(authority, fresh) ||
          !matchesPublished(evidence, fresh)
        )
          throw invariant();
        const now = new Date();
        const story = await tx.story.updateMany({
          where: {
            id: fresh.storyId,
            status: StoryStatus.PUBLISHING,
            version: fresh.storyVersion,
          },
          data: { status: StoryStatus.PUBLISHED, publishedAt: now },
        });
        if (story.count !== 1) throw invariant();
        const attempt = await tx.publishAttempt.updateMany({
          where: {
            id: fresh.attemptId,
            status: supervised
              ? PublishAttemptStatus.RECONCILIATION_REQUIRED
              : PublishAttemptStatus.IN_PROGRESS,
          },
          data: {
            status: PublishAttemptStatus.SUCCEEDED,
            completedAt: now,
            httpStatus: 200,
            errorCode: null,
            errorMessage: null,
          },
        });
        if (attempt.count !== 1) throw invariant();
        const conversation = await tx.conversation.findUniqueOrThrow({
          where: { id: fresh.conversationId },
          select: { version: true },
        });
        const transitioned = await this.conversations.transitionInTransaction(
          tx,
          {
            conversationId: fresh.conversationId,
            reporterId: fresh.reporterId,
            expectedState: ConversationState.PUBLISHING,
            expectedVersion: conversation.version,
            targetState: ConversationState.IDLE,
            storyMutation: { kind: "CLEAR" },
            inboundEventId: fresh.eventId,
          },
        );
        if (transitioned.outcome !== "TRANSITIONED") throw invariant();
        const event = await tx.inboundEvent.updateMany({
          where: {
            id: fresh.eventId,
            processingStatus: InboundProcessingStatus.PROCESSING,
          },
          data: {
            processingStatus: InboundProcessingStatus.PROCESSED,
            processedAt: now,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        if (event.count !== 1) throw invariant();
        await tx.auditLog.create({
          data: auditData(ROUND7_PUBLISH_AUDIT.SUCCEEDED, fresh, {
            attemptStatusBefore: supervised
              ? "RECONCILIATION_REQUIRED"
              : "IN_PROGRESS",
            attemptStatusAfter: "SUCCEEDED",
            storyStatusBefore: "PUBLISHING",
            storyStatusAfter: "PUBLISHED",
          }),
        });
        return {
          outcome: "PROCESSED",
          publishAttemptId: fresh.attemptId,
          storyId: fresh.storyId,
        };
      }, TX_OPTIONS);
    } catch (error) {
      const terminal = await this.alreadySucceeded(authority.attemptId);
      if (terminal) return terminal;
      return this.handleLocalFailure(authority.attemptId, error);
    }
  }

  private async alreadySucceeded(
    attemptId: string,
  ): Promise<PublishSagaResult | null> {
    const row = await this.prisma.publishAttempt.findUnique({
      where: { id: attemptId },
      include: {
        approval: {
          include: {
            inboundEvent: { select: { processingStatus: true } },
            story: { include: { activeInConversation: true } },
          },
        },
      },
    });
    if (
      row?.status !== PublishAttemptStatus.SUCCEEDED ||
      row.operation !== PublishOperation.PUBLISH ||
      !row.approval ||
      row.approval.story.status !== StoryStatus.PUBLISHED ||
      row.approval.story.version !== row.approval.storyVersion ||
      row.approval.story.activeInConversation !== null ||
      row.approval.inboundEvent.processingStatus !==
        InboundProcessingStatus.PROCESSED
    )
      return null;
    return {
      outcome: "ALREADY_SUCCEEDED",
      publishAttemptId: row.id,
      storyId: row.storyId,
    };
  }

  private async reconciliation(
    authority: PublishAuthority,
    code: string,
    httpStatus: number | null = null,
  ): Promise<PublishSagaResult> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const fresh = await this.readLockedAuthority(
          tx,
          authority.attemptId,
          PublishAttemptStatus.IN_PROGRESS,
        );
        if (!sameAuthority(authority, fresh)) throw invariant();
        const changed = await tx.publishAttempt.updateMany({
          where: {
            id: fresh.attemptId,
            status: PublishAttemptStatus.IN_PROGRESS,
          },
          data: {
            status: PublishAttemptStatus.RECONCILIATION_REQUIRED,
            errorCode: code,
            errorMessage: null,
            httpStatus,
            completedAt: null,
          },
        });
        if (changed.count !== 1) throw invariant();
        await tx.auditLog.create({
          data: auditData(
            code === "WORDPRESS_PUBLISH_BLOCKED" ||
              code === "PUBLISH_CAS_CONFLICT"
              ? ROUND7_PUBLISH_AUDIT.BLOCKED
              : ROUND7_PUBLISH_AUDIT.RECONCILIATION_REQUIRED,
            fresh,
            {
              attemptStatusBefore: "IN_PROGRESS",
              attemptStatusAfter: "RECONCILIATION_REQUIRED",
              errorCode: code,
              httpStatus,
            },
          ),
        });
      }, TX_OPTIONS);
      return {
        outcome: "PUBLISH_RECONCILIATION_REQUIRED",
        publishAttemptId: authority.attemptId,
        reason: code,
      };
    } catch (error) {
      return this.handleLocalFailure(authority.attemptId, error);
    }
  }

  private async handleLocalFailure(
    attemptId: string,
    error: unknown,
  ): Promise<PublishSagaResult> {
    if (!(error instanceof Round7PublishError)) throw error;
    const terminal = await this.alreadySucceeded(attemptId);
    if (terminal) return terminal;
    await this.prisma.publishAttempt.updateMany({
      where: {
        id: attemptId,
        operation: PublishOperation.PUBLISH,
        status: {
          in: [PublishAttemptStatus.PENDING, PublishAttemptStatus.IN_PROGRESS],
        },
      },
      data: {
        status: PublishAttemptStatus.FAILED,
        errorCode: error.code,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
    return {
      outcome: "PUBLISH_FAILED",
      publishAttemptId: attemptId,
      reason: error.code,
    };
  }

  private readLockedAuthority(
    tx: Tx,
    attemptId: string,
    expectedStatus: PublishAttemptStatus,
  ): Promise<PublishAuthority>;
  private readLockedAuthority(
    tx: Tx,
    attemptId: string,
    expectedStatus: PublishAttemptStatus,
    returnNullOnLostClaim: true,
  ): Promise<PublishAuthority | null>;
  private async readLockedAuthority(
    tx: Tx,
    attemptId: string,
    expectedStatus: PublishAttemptStatus,
    returnNullOnLostClaim = false,
  ): Promise<PublishAuthority | null> {
    const hint = await readAuthority(tx, attemptId);
    if (!hint) throw invariant();
    const approval = hint.approval;
    if (!approval) throw invariant();
    const story = approval.story;
    const preparation = approval.draftPreparation;
    const conversation = story.activeInConversation;
    const promptId = preparation.approvalPromptOutboundMessageId;
    if (!conversation || !promptId) throw invariant();

    await tx.$queryRaw`SELECT "id" FROM "InboundEvent" WHERE "id"=${approval.inboundEventId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Reporter" WHERE "id"=${approval.reporterId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id"=${conversation.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id"=${story.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT ec."id" FROM "EditorialCategory" ec JOIN "StoryCategory" sc ON sc."categoryId"=ec."id" WHERE sc."storyId"=${story.id}::uuid ORDER BY ec."id" FOR UPDATE OF ec`;
    await tx.$queryRaw`SELECT "storyId","categoryId" FROM "StoryCategory" WHERE "storyId"=${story.id}::uuid ORDER BY "storyId","categoryId" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "StoryMedia" WHERE "storyId"=${story.id}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "DraftPreparation" WHERE "id"=${preparation.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "OutboundMessage" WHERE "id"=${promptId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Approval" WHERE "storyId"=${story.id}::uuid ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "PublishAttempt" WHERE "storyId"=${story.id}::uuid AND "operation"='PUBLISH'::"PublishOperation" ORDER BY "id" FOR UPDATE`;

    const fresh = await readAuthority(tx, attemptId);
    if (!fresh) throw invariant();
    if (returnNullOnLostClaim && fresh.status !== expectedStatus) return null;
    return validateAuthority(fresh, expectedStatus);
  }
}

// The generated Prisma payload type is intentionally inferred from this single query.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function readAuthority(client: Tx | PrismaService, attemptId: string) {
  return client.publishAttempt.findUnique({
    where: { id: attemptId },
    include: {
      approval: {
        include: {
          inboundEvent: true,
          reporter: true,
          draftPreparation: {
            include: { approvalPromptOutboundMessage: true },
          },
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
      },
    },
  });
}

function validateAuthority(
  row: AuthorityRow,
  expectedStatus: PublishAttemptStatus,
): PublishAuthority {
  const approval = row.approval;
  if (!approval) throw invariant();
  const story = approval.story;
  const preparation = approval.draftPreparation;
  const event = approval.inboundEvent;
  const reporter = approval.reporter;
  const conversation = story.activeInConversation;
  const postId = story.wordpressPostId;
  const numericPostId = postId === null ? 0 : Number(postId);
  const categories = story.categories.map((item) =>
    Number(item.category.wordpressCategoryId),
  );
  const fingerprint =
    story.headline && story.body && story.byline && categories.length
      ? draftStateFingerprint({
          title: story.headline,
          content: story.body,
          excerpt: "",
          categories: [...new Set(categories)].sort((a, b) => a - b),
          editorial_byline: story.byline,
          featured_media_key: story.media[0]?.id ?? null,
        })
      : null;
  const expectedStoryStatus =
    expectedStatus === PublishAttemptStatus.PENDING
      ? StoryStatus.APPROVED
      : StoryStatus.PUBLISHING;
  const expectedConversationState =
    expectedStatus === PublishAttemptStatus.PENDING
      ? ConversationState.AWAITING_APPROVAL
      : ConversationState.PUBLISHING;
  if (
    row.operation !== PublishOperation.PUBLISH ||
    row.status !== expectedStatus ||
    (expectedStatus === PublishAttemptStatus.PENDING &&
      (row.startedAt !== null || row.completedAt !== null)) ||
    (expectedStatus !== PublishAttemptStatus.PENDING &&
      (row.startedAt === null || row.completedAt !== null)) ||
    row.approvalId !== approval.id ||
    row.storyId !== story.id ||
    row.wordpressPostId !== postId ||
    row.idempotencyKey !==
      `draft-publish:${preparation.id}:${approval.storyVersion}` ||
    approval.decision !== ApprovalDecision.APPROVED ||
    approval.storyId !== story.id ||
    approval.reporterId !== reporter.id ||
    approval.inboundEventId !== event.id ||
    approval.draftPreparationId !== preparation.id ||
    approval.storyVersion !== story.version ||
    approval.wordpressAppliedVersion !== preparation.wordpressAppliedVersion ||
    !SHA.test(approval.wordpressAppliedVersion) ||
    event.processingStatus !== InboundProcessingStatus.PROCESSING ||
    event.reporterId !== reporter.id ||
    event.senderPhone !== reporter.phoneNumber ||
    story.reporterId !== reporter.id ||
    story.status !== expectedStoryStatus ||
    story.approvedAt === null ||
    story.publishedAt !== null ||
    !conversation ||
    conversation.reporterId !== reporter.id ||
    conversation.currentStoryId !== story.id ||
    conversation.state !== expectedConversationState ||
    preparation.storyId !== story.id ||
    preparation.storyVersion !== approval.storyVersion ||
    preparation.status !== DraftPreparationStatus.READY_FOR_APPROVAL ||
    preparation.supersededAt !== null ||
    preparation.wordpressPostId !== postId ||
    !preparation.approvalPromptOutboundMessage ||
    preparation.approvalPromptOutboundMessage.storyId !== story.id ||
    preparation.approvalPromptOutboundMessage.reporterId !== reporter.id ||
    postId === null ||
    postId <= 0n ||
    !Number.isSafeInteger(numericPostId) ||
    categories.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    story.media.some(
      (media) =>
        media.status !== MediaProcessingStatus.UPLOADED ||
        media.wordpressMediaId === null ||
        media.wordpressMediaId <= 0n,
    ) ||
    fingerprint !== approval.wordpressAppliedVersion
  )
    throw invariant();
  return {
    attemptId: row.id,
    approvalId: approval.id,
    eventId: event.id,
    reporterId: reporter.id,
    conversationId: conversation.id,
    storyId: story.id,
    preparationId: preparation.id,
    storyVersion: approval.storyVersion,
    draftKey: story.wordpressDraftKey,
    postId: numericPostId,
    appliedVersion: approval.wordpressAppliedVersion,
  };
}

function invariant(): Round7PublishError {
  return new Round7PublishError("PUBLISH_LOCAL_INVARIANT_CORRUPTION");
}

function matchesLedger(
  row: LedgerEvidence,
  authority: PublishAuthority,
): boolean {
  return (
    row.outcome === "PUBLISHED" &&
    row.publishKey === authority.attemptId &&
    row.draftKey === authority.draftKey &&
    row.postId === authority.postId &&
    row.expectedAppliedVersion === authority.appliedVersion &&
    typeof row.publishedAt === "string" &&
    row.publishedAt.length > 0
  );
}

function toPublished(row: LedgerEvidence): PublishedEvidence {
  return {
    outcome: "PUBLISHED",
    publishKey: row.publishKey,
    postId: row.postId,
    status: "publish",
    appliedVersionBefore: row.expectedAppliedVersion,
    publishedAt: row.publishedAt!,
  };
}

function matchesPublished(
  row: PublishedEvidence,
  authority: PublishAuthority,
): boolean {
  return (
    row.outcome === "PUBLISHED" &&
    row.publishKey === authority.attemptId &&
    row.postId === authority.postId &&
    row.status === "publish" &&
    row.appliedVersionBefore === authority.appliedVersion &&
    row.publishedAt.length > 0
  );
}

function sameAuthority(a: PublishAuthority, b: PublishAuthority): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function remoteCode(error: unknown): string {
  if (!(error instanceof WordPressPublicationError))
    return "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED";
  if (error.code === "STALE_VERSION") return "PUBLISH_CAS_CONFLICT";
  if (error.code === "STATE_MISMATCH") return "WORDPRESS_PUBLISH_BLOCKED";
  return "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED";
}

function statusOf(error: unknown): number | null {
  return error instanceof WordPressPublicationError &&
    Number.isInteger(error.status)
    ? error.status!
    : null;
}

function auditData(
  eventType: string,
  authority: PublishAuthority,
  metadata: Record<string, unknown>,
): Prisma.AuditLogCreateArgs["data"] {
  return {
    eventType,
    actorType: AuditActorType.SYSTEM,
    reporterId: authority.reporterId,
    storyId: authority.storyId,
    inboundEventId: authority.eventId,
    entityType: "PublishAttempt",
    entityId: authority.attemptId,
    metadata: {
      storyId: authority.storyId,
      approvalId: authority.approvalId,
      publishAttemptId: authority.attemptId,
      draftPreparationId: authority.preparationId,
      storyVersion: authority.storyVersion,
      wordpressAppliedVersion: authority.appliedVersion,
      wordpressPostId: authority.postId,
      ...metadata,
    },
  };
}
