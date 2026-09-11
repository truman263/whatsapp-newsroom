import { ConversationState } from "@prisma/client";
import { ReporterWorkflowError } from "./reporter-workflow.errors";
import type { StoryMutation } from "./reporter-workflow.types";

const EDGES: Readonly<Record<ConversationState, readonly ConversationState[]>> =
  {
    IDLE: [ConversationState.AWAITING_HEADLINE],
    AWAITING_HEADLINE: [
      ConversationState.AWAITING_BODY,
      ConversationState.IDLE,
    ],
    AWAITING_BODY: [ConversationState.COLLECTING_MEDIA, ConversationState.IDLE],
    COLLECTING_MEDIA: [
      ConversationState.AWAITING_APPROVAL,
      ConversationState.IDLE,
    ],
    AWAITING_APPROVAL: [
      ConversationState.COLLECTING_MEDIA,
      ConversationState.PUBLISHING,
      ConversationState.IDLE,
    ],
    PUBLISHING: [ConversationState.IDLE],
  };

export function validateTransition(
  from: ConversationState,
  to: ConversationState,
  mutation: StoryMutation,
): void {
  if (!EDGES[from].includes(to))
    throw new ReporterWorkflowError("INVALID_TRANSITION");
  if (
    from === ConversationState.IDLE &&
    to === ConversationState.AWAITING_HEADLINE
  ) {
    if (mutation.kind !== "ATTACH")
      throw new ReporterWorkflowError("INVALID_STORY_MUTATION");
    return;
  }
  if (to === ConversationState.IDLE) {
    if (mutation.kind !== "CLEAR")
      throw new ReporterWorkflowError("INVALID_STORY_MUTATION");
    return;
  }
  if (mutation.kind !== "PRESERVE")
    throw new ReporterWorkflowError("INVALID_STORY_MUTATION");
}
