import type { PublishedEvidence } from "../wordpress-publication/wordpress-publication.client";

export type PublishSagaResult =
  | { outcome: "PROCESSED"; publishAttemptId: string; storyId: string }
  | { outcome: "ALREADY_SUCCEEDED"; publishAttemptId: string; storyId: string }
  | { outcome: "PUBLISH_NOT_CLAIMED"; publishAttemptId: string }
  | {
      outcome: "PUBLISH_RECONCILIATION_REQUIRED";
      publishAttemptId: string;
      reason: string;
    }
  | { outcome: "PUBLISH_FAILED"; publishAttemptId: string; reason: string };

export type PublishAuthority = {
  attemptId: string;
  approvalId: string;
  eventId: string;
  reporterId: string;
  conversationId: string;
  storyId: string;
  preparationId: string;
  storyVersion: number;
  draftKey: string;
  postId: number;
  appliedVersion: string;
};

export type FinalisationEvidence = PublishedEvidence;
