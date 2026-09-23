export type PublishSagaErrorCode =
  | "PUBLISH_ATTEMPT_CONFLICT"
  | "PUBLISH_LOCAL_INVARIANT_CORRUPTION"
  | "WORDPRESS_PUBLISH_BLOCKED"
  | "WORDPRESS_PUBLISH_RECONCILIATION_REQUIRED"
  | "PUBLISH_CAS_CONFLICT";

export class Round7PublishError extends Error {
  constructor(readonly code: PublishSagaErrorCode) {
    super(code);
  }
}
