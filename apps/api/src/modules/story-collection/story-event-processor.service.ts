import { Injectable } from "@nestjs/common";
import {
  AuditActorType,
  ConversationState,
  EditorialCategoryStatus,
  Prisma,
  StoryMediaType,
  StoryStatus,
  type Story,
} from "@prisma/client";
import { ConversationStateMachineService } from "../reporter-workflow/conversation-state-machine.service";
import { STORY_COLLECTION_AUDIT } from "./story-collection.audit";
import { StoryCollectionError } from "./story-collection.errors";
import type {
  ParsedStoredEvent,
  StoryIgnoredReason,
  StoryProcessInput,
  StoryProcessResult,
} from "./story-collection.types";

const CATEGORY_COMMAND = "/categories ";
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

@Injectable()
export class StoryEventProcessor {
  constructor(
    private readonly conversations: ConversationStateMachineService,
  ) {}

  async process(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
  ): Promise<StoryProcessResult> {
    const command =
      input.parsed.kind === "TEXT"
        ? input.parsed.text.trim()
        : input.parsed.kind === "INTERACTIVE"
          ? input.parsed.replyId
          : null;
    if (command === "newsroom:v1:story:done" || command === "/done") {
      if (!input.round6DoneEnabled) return ignored("CONTROL_NOT_ENABLED");
      if (
        input.conversationState !== ConversationState.COLLECTING_MEDIA ||
        input.expectedStoryVersion === null
      )
        return ignored("TEXT_NOT_ACCEPTED_IN_STATE");
      const current = await tx.conversation.findFirst({
        where: { id: input.conversationId, reporterId: input.reporterId },
        select: { currentStoryId: true },
      });
      return current?.currentStoryId
        ? { outcome: "FINALISATION_INTENT", storyId: current.currentStoryId }
        : ignored("TEXT_NOT_ACCEPTED_IN_STATE");
    }
    await tx.$queryRaw`
      SELECT "id" FROM "Conversation"
      WHERE "id" = ${input.conversationId}::uuid AND "reporterId" = ${input.reporterId}::uuid
      FOR UPDATE
    `;
    const conversation = await tx.conversation.findFirstOrThrow({
      where: { id: input.conversationId, reporterId: input.reporterId },
    });
    if (
      conversation.state !== input.conversationState ||
      conversation.version !== input.conversationVersion
    )
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    if (input.parsed.kind === "UNKNOWN")
      return ignored("UNSUPPORTED_EVENT_TYPE");
    if (
      input.parsed.kind === "IMAGE" &&
      conversation.state !== ConversationState.COLLECTING_MEDIA
    )
      return ignored("IMAGE_NOT_ACCEPTED_IN_STATE");
    if (
      input.parsed.kind === "INTERACTIVE" &&
      command !== "newsroom:v1:story:start" &&
      command !== "newsroom:v1:story:cancel"
    )
      return ignored("UNSUPPORTED_INTERACTION");

    if (conversation.state === ConversationState.IDLE) {
      if (command !== "/story" && command !== "newsroom:v1:story:start")
        return ignored("STORY_START_REQUIRED");
      return this.start(
        tx,
        input,
        conversation.version,
        conversation.currentStoryId,
      );
    }

    if (command === "/cancel" || command === "newsroom:v1:story:cancel")
      return this.cancel(
        tx,
        input,
        conversation.state,
        conversation.version,
        conversation.currentStoryId,
      );

    if (conversation.state === ConversationState.AWAITING_HEADLINE) {
      if (input.parsed.kind !== "TEXT")
        return ignored("UNSUPPORTED_INTERACTION");
      return this.headline(
        tx,
        input,
        conversation.version,
        conversation.currentStoryId,
        input.parsed.text,
      );
    }
    if (conversation.state === ConversationState.AWAITING_BODY) {
      if (input.parsed.kind !== "TEXT")
        return ignored("UNSUPPORTED_INTERACTION");
      return this.body(
        tx,
        input,
        conversation.version,
        conversation.currentStoryId,
        input.parsed.text,
      );
    }
    if (conversation.state === ConversationState.COLLECTING_MEDIA) {
      if (input.parsed.kind === "IMAGE")
        return this.media(tx, input, conversation.currentStoryId, input.parsed);
      if (input.parsed.kind !== "TEXT")
        return ignored("UNSUPPORTED_INTERACTION");
      if (!input.parsed.text.startsWith(CATEGORY_COMMAND))
        return ignored("TEXT_NOT_ACCEPTED_IN_STATE");
      return this.categories(
        tx,
        input,
        conversation.currentStoryId,
        input.parsed.text,
      );
    }
    return ignored("TEXT_NOT_ACCEPTED_IN_STATE");
  }

  private async media(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    storyId: string | null,
    authority: Extract<ParsedStoredEvent, { kind: "IMAGE" }>,
  ): Promise<StoryProcessResult> {
    const duplicate = await tx.storyMedia.findUnique({
      where: { providerMediaId: authority.providerMediaId },
      select: { id: true },
    });
    if (duplicate) throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    const story = await this.currentStory(
      tx,
      input.reporterId,
      storyId,
      input.expectedStoryVersion,
    );
    const last = await tx.storyMedia.findFirst({
      where: { storyId: story.id },
      orderBy: [{ position: "desc" }, { id: "asc" }],
      select: { position: true },
    });
    await this.storyCas(tx, story, {});
    const media = await tx.storyMedia.create({
      data: {
        storyId: story.id,
        providerMediaId: authority.providerMediaId,
        mediaType: StoryMediaType.IMAGE,
        mimeType: authority.mimeType,
        position: (last?.position ?? -1) + 1,
        caption: authority.caption ?? null,
        altText: null,
      },
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_MEDIA_ASSOCIATED,
      {
        ...versionMetadata(story.version),
        storyMediaId: media.id,
        position: media.position,
        mimeType: authority.mimeType,
      },
      "StoryMedia",
      media.id,
    );
    return {
      outcome: "MEDIA_INTENT",
      mediaId: media.id,
      storyId: story.id,
      authority,
    };
  }

  private async start(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    conversationVersion: number,
    currentStoryId: string | null,
  ): Promise<StoryProcessResult> {
    if (currentStoryId !== null)
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    const reporter = await tx.reporter.findUniqueOrThrow({
      where: { id: input.reporterId },
    });
    const selected = reporter.editorialByline ?? reporter.displayName;
    const byline = selected.trim();
    if (!byline) throw new StoryCollectionError("INVALID_BYLINE_SNAPSHOT");
    const story = await tx.story.create({
      data: { reporterId: input.reporterId, byline },
    });
    await this.transition(tx, {
      conversationId: input.conversationId,
      reporterId: input.reporterId,
      expectedState: ConversationState.IDLE,
      expectedVersion: conversationVersion,
      targetState: ConversationState.AWAITING_HEADLINE,
      storyMutation: { kind: "ATTACH", storyId: story.id },
      inboundEventId: input.eventId,
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_CREATED,
      {
        versionBefore: 0,
        versionAfter: 0,
      },
    );
    return { outcome: "PROCESSED" };
  }

  private async headline(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    conversationVersion: number,
    storyId: string | null,
    value: string,
  ): Promise<StoryProcessResult> {
    const headline = normalizeHeadline(value);
    if (headline === null) return ignored("INVALID_HEADLINE");
    const story = await this.currentStory(
      tx,
      input.reporterId,
      storyId,
      input.expectedStoryVersion,
    );
    await this.storyCas(tx, story, { headline });
    await this.transition(tx, {
      conversationId: input.conversationId,
      reporterId: input.reporterId,
      expectedState: ConversationState.AWAITING_HEADLINE,
      expectedVersion: conversationVersion,
      targetState: ConversationState.AWAITING_BODY,
      storyMutation: { kind: "PRESERVE" },
      inboundEventId: input.eventId,
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_HEADLINE_SET,
      versionMetadata(story.version),
    );
    return { outcome: "PROCESSED" };
  }

  private async body(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    conversationVersion: number,
    storyId: string | null,
    value: string,
  ): Promise<StoryProcessResult> {
    const body = normalizeBody(value);
    if (body === null) return ignored("INVALID_BODY");
    const story = await this.currentStory(
      tx,
      input.reporterId,
      storyId,
      input.expectedStoryVersion,
    );
    await this.storyCas(tx, story, { body });
    await this.transition(tx, {
      conversationId: input.conversationId,
      reporterId: input.reporterId,
      expectedState: ConversationState.AWAITING_BODY,
      expectedVersion: conversationVersion,
      targetState: ConversationState.COLLECTING_MEDIA,
      storyMutation: { kind: "PRESERVE" },
      inboundEventId: input.eventId,
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_BODY_SET,
      versionMetadata(story.version),
    );
    return { outcome: "PROCESSED" };
  }

  private async categories(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    storyId: string | null,
    command: string,
  ): Promise<StoryProcessResult> {
    const rawTokens = command.slice(CATEGORY_COMMAND.length).split(",");
    const slugs = rawTokens.map((token) =>
      token
        .trim()
        .normalize("NFC")
        .replace(/[A-Z]/gu, (letter) => letter.toLowerCase()),
    );
    if (
      slugs.some(
        (slug) => !slug || slug.length > 200 || !CATEGORY_PATTERN.test(slug),
      )
    )
      return ignored("INVALID_CATEGORY_COMMAND");
    const uniqueSlugs = [...new Set(slugs)].sort();
    const story = await this.currentStory(
      tx,
      input.reporterId,
      storyId,
      input.expectedStoryVersion,
    );
    const resolved = await tx.editorialCategory.findMany({
      where: {
        slug: { in: uniqueSlugs },
        status: EditorialCategoryStatus.ACTIVE,
      },
      orderBy: { id: "asc" },
      select: { id: true, slug: true, wordpressCategoryId: true },
    });
    for (const slug of uniqueSlugs) {
      const matches = resolved.filter((category) => category.slug === slug);
      if (matches.length === 0) return ignored("CATEGORY_NOT_FOUND");
      if (matches.length > 1) return ignored("CATEGORY_AMBIGUOUS");
    }
    const requested = resolved.map(({ id }) => id).sort();
    const current = (
      await tx.storyCategory.findMany({
        where: { storyId: story.id },
        select: { categoryId: true },
        orderBy: { categoryId: "asc" },
      })
    ).map(({ categoryId }) => categoryId);
    if (
      requested.length === current.length &&
      requested.every((id, index) => id === current[index])
    )
      return { outcome: "PROCESSED" };
    await this.storyCas(tx, story, {});
    await tx.storyCategory.deleteMany({
      where: { storyId: story.id, categoryId: { notIn: requested } },
    });
    const existing = new Set(current);
    await tx.storyCategory.createMany({
      data: requested
        .filter((id) => !existing.has(id))
        .map((categoryId) => ({ storyId: story.id, categoryId })),
      skipDuplicates: true,
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_CATEGORIES_SET,
      {
        ...versionMetadata(story.version),
        count: requested.length,
        categoryIds: requested,
        wordpressCategoryIds: resolved
          .map(({ wordpressCategoryId }) => wordpressCategoryId.toString())
          .sort(),
      },
    );
    return { outcome: "PROCESSED" };
  }

  private async cancel(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    state: ConversationState,
    conversationVersion: number,
    storyId: string | null,
  ): Promise<StoryProcessResult> {
    if (
      state !== ConversationState.AWAITING_HEADLINE &&
      state !== ConversationState.AWAITING_BODY &&
      state !== ConversationState.COLLECTING_MEDIA
    )
      return ignored("TEXT_NOT_ACCEPTED_IN_STATE");
    const story = await this.currentStory(
      tx,
      input.reporterId,
      storyId,
      input.expectedStoryVersion,
    );
    const now = new Date();
    await this.storyCas(tx, story, {
      status: StoryStatus.CANCELLED,
      cancelledAt: now,
    });
    await this.transition(tx, {
      conversationId: input.conversationId,
      reporterId: input.reporterId,
      expectedState: state,
      expectedVersion: conversationVersion,
      targetState: ConversationState.IDLE,
      storyMutation: { kind: "CLEAR" },
      inboundEventId: input.eventId,
    });
    await this.audit(
      tx,
      input,
      story.id,
      STORY_COLLECTION_AUDIT.STORY_CANCELLED,
      versionMetadata(story.version),
    );
    return { outcome: "PROCESSED" };
  }

  private async currentStory(
    tx: Prisma.TransactionClient,
    reporterId: string,
    storyId: string | null,
    expectedVersion: number | null,
  ): Promise<Story> {
    if (!storyId || expectedVersion === null)
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    await tx.$queryRaw`SELECT "id" FROM "Story" WHERE "id" = ${storyId}::uuid FOR UPDATE`;
    const story = await tx.story.findFirst({
      where: { id: storyId, reporterId, status: StoryStatus.COLLECTING },
    });
    if (!story) throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    if (story.version !== expectedVersion)
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
    return story;
  }

  private async storyCas(
    tx: Prisma.TransactionClient,
    story: Story,
    data: Prisma.StoryUpdateManyMutationInput,
  ): Promise<void> {
    const result = await tx.story.updateMany({
      where: {
        id: story.id,
        reporterId: story.reporterId,
        version: story.version,
        status: StoryStatus.COLLECTING,
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1)
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
  }

  private async transition(
    tx: Prisma.TransactionClient,
    command: Parameters<
      ConversationStateMachineService["transitionInTransaction"]
    >[1],
  ): Promise<void> {
    const result = await this.conversations.transitionInTransaction(
      tx,
      command,
    );
    if (result.outcome !== "TRANSITIONED")
      throw new StoryCollectionError("STORY_DOMAIN_CONFLICT");
  }

  private async audit(
    tx: Prisma.TransactionClient,
    input: StoryProcessInput,
    storyId: string,
    eventType: string,
    metadata: Prisma.InputJsonObject,
    entityType = "Story",
    entityId = storyId,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        eventType,
        actorType: AuditActorType.REPORTER,
        reporterId: input.reporterId,
        storyId,
        inboundEventId: input.eventId,
        entityType,
        entityId,
        metadata,
      },
    });
  }
}

function ignored(reason: StoryIgnoredReason): StoryProcessResult {
  return { outcome: "IGNORED", reason };
}

function versionMetadata(version: number): Prisma.InputJsonObject {
  return { versionBefore: version, versionAfter: version + 1 };
}

export function normalizeHeadline(value: string): string | null {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized &&
    !normalized.includes("\n") &&
    [...normalized].length <= 500
    ? normalized
    : null;
}

export function normalizeBody(value: string): string | null {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= 100_000
    ? normalized
    : null;
}
