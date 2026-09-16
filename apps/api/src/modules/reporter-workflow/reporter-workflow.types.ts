import type { ConversationState } from "@prisma/client";
import type { StoryIgnoredReason } from "../story-collection/story-collection.types";

export type ProvisionReporterInput = {
  phoneNumber: string;
  displayName: string;
  editorialByline?: string | null;
};

export type ReporterProvisionResult =
  | { outcome: "CREATED"; reporterId: string }
  | { outcome: "ALREADY_EXISTS"; reporterId: string }
  | { outcome: "REPORTER_CONFLICT"; reporterId: string };

export type ReporterStatusResult =
  | { outcome: "UPDATED"; reporterId: string }
  | { outcome: "ALREADY_IN_STATE"; reporterId: string }
  | { outcome: "NOT_FOUND" };

export type StoryMutation =
  | { kind: "ATTACH"; storyId: string }
  | { kind: "PRESERVE" }
  | { kind: "CLEAR" };

export type ConversationTransitionCommand = {
  conversationId: string;
  reporterId: string;
  expectedState: ConversationState;
  expectedVersion: number;
  targetState: ConversationState;
  storyMutation: StoryMutation;
  inboundEventId?: string;
};

export type TransitionResult =
  | { outcome: "TRANSITIONED"; version: number }
  | { outcome: "STALE" }
  | { outcome: "NOT_FOUND_OR_NOT_OWNED" };

export type EventClaimResult =
  | { outcome: "CLAIMED" }
  | { outcome: "ORDER_BLOCKED" }
  | { outcome: "NOT_CLAIMED" };

export type EventProcessingResult =
  | { outcome: "PROCESSED"; reporterId: string; conversationId: string }
  | { outcome: "APPROVAL_PENDING"; approvalId: string; publishAttemptId: string; storyId: string }
  | {
      outcome: "IGNORED";
      reason:
        | "REPORTER_UNKNOWN"
        | "REPORTER_INACTIVE"
        | StoryIgnoredReason
        | "COMPLETENESS_NOT_SATISFIED"
        | "CATEGORY_SELECTION_NO_LONGER_ACTIVE"
        | "STORY_FINALISATION_CONFLICT"
        | "STORY_REVISION_CONFLICT"
        | "APPROVAL_AMBIGUOUS"
        | "APPROVAL_IDENTITY_CONFLICT"
        | "APPROVAL_PROMPT_NOT_SENT"
        | "APPROVAL_STATE_MISMATCH";
    }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "RETRY_REQUIRED"; reason: string }
  | { outcome: "ORDER_BLOCKED" }
  | { outcome: "NOT_CLAIMED" };
