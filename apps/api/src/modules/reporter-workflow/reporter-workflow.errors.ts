export type ReporterWorkflowErrorCode =
  | "INVALID_PHONE_NUMBER"
  | "INVALID_DISPLAY_NAME"
  | "INVALID_EDITORIAL_BYLINE"
  | "INVALID_TRANSITION"
  | "INVALID_STORY_MUTATION"
  | "INVALID_EXPECTED_VERSION"
  | "STORY_NOT_FOUND_OR_NOT_OWNED"
  | "INBOUND_EVENT_ASSOCIATION_CONFLICT"
  | "INBOUND_EVENT_STATE_CONFLICT";

export class ReporterWorkflowError extends Error {
  constructor(public readonly code: ReporterWorkflowErrorCode) {
    super(code);
    this.name = "ReporterWorkflowError";
  }
}
