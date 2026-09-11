import type {
  ConversationState,
  InboundEventType,
  Prisma,
} from "@prisma/client";

export type StoredEventInput = {
  providerMessageId: string;
  senderPhone: string;
  eventType: InboundEventType;
  providerOccurredAt: Date | null;
  rawPayload: Prisma.JsonValue;
};

export type ParsedStoredEvent =
  | { kind: "TEXT"; text: string }
  | { kind: "INTERACTIVE"; replyId: string }
  | { kind: "IMAGE" }
  | { kind: "UNKNOWN" };

export type StoryProcessInput = {
  eventId: string;
  reporterId: string;
  conversationId: string;
  conversationState: ConversationState;
  conversationVersion: number;
  expectedStoryVersion: number | null;
  parsed: ParsedStoredEvent;
};

export type StoryProcessResult =
  { outcome: "PROCESSED" } | { outcome: "IGNORED"; reason: StoryIgnoredReason };

export type StoryIgnoredReason =
  | "STORY_START_REQUIRED"
  | "INVALID_HEADLINE"
  | "INVALID_BODY"
  | "INVALID_CATEGORY_COMMAND"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_AMBIGUOUS"
  | "TEXT_NOT_ACCEPTED_IN_STATE"
  | "UNSUPPORTED_INTERACTION"
  | "UNSUPPORTED_EVENT_TYPE"
  | "MEDIA_COLLECTION_NOT_ENABLED"
  | "CONTROL_NOT_ENABLED";
