import type { CanonicalDraftState } from "../wordpress-draft/wordpress-draft-state";

export type FinalizeDraftInput = {
  inboundEventId: string;
  reporterId: string;
  conversationId: string;
  storyId: string;
  expectedStoryVersion: number;
};
export type FinalizeDraftResult = {
  preparationId: string;
  storyId: string;
  storyVersion: number;
  previewExpiresAt: Date;
};
export type PreparationOutcome = {
  preparationId: string;
  outcome:
    "PREPARED" | "BLOCKED" | "RECONCILIATION_REQUIRED" | "FAILED" | "TERMINAL";
  errorCode?: string;
};
export type PreparedAuthority = {
  preparationId: string;
  storyId: string;
  storyVersion: number;
  wordpressPostId: number;
  wordpressAppliedVersion: string;
  previewExpiresAt: Date;
  state: CanonicalDraftState;
};
