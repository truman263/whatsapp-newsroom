import type { ConversationState } from "@prisma/client";

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
  { outcome: "CLAIMED" } | { outcome: "NOT_CLAIMED" };

export type EventProcessingResult =
  | { outcome: "PROCESSED"; reporterId: string; conversationId: string }
  | { outcome: "IGNORED"; reason: "REPORTER_UNKNOWN" | "REPORTER_INACTIVE" }
  | { outcome: "NOT_CLAIMED" };
