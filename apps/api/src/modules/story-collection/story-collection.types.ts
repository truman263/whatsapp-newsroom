import type {
  ConversationState,
  InboundEventType,
  Prisma,
} from "@prisma/client";
import type { MediaAuthority } from "../media-staging/media-staging.types";

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
  | ({ kind: "IMAGE" } & MediaAuthority)
  | { kind: "UNKNOWN" };

export type StoryProcessInput = {
  eventId: string;
  reporterId: string;
  conversationId: string;
  conversationState: ConversationState;
  conversationVersion: number;
  expectedStoryVersion: number | null;
  parsed: ParsedStoredEvent;
  round6DoneEnabled?: boolean;
};

export type StoryProcessResult =
  | { outcome: "PROCESSED" }
  | { outcome: "FINALISATION_INTENT"; storyId: string }
  | { outcome: "REVISION_INTENT"; storyId: string }
  | {
      outcome: "MEDIA_INTENT";
      mediaId: string;
      storyId: string;
      authority: MediaAuthority;
    }
  | { outcome: "IGNORED"; reason: StoryIgnoredReason };

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
  | "IMAGE_NOT_ACCEPTED_IN_STATE"
  | "CONTROL_NOT_ENABLED";
