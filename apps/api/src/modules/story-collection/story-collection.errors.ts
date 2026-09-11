export type StoryCollectionErrorCode =
  | "MALFORMED_STORED_EVENT"
  | "STORY_DOMAIN_CONFLICT"
  | "INVALID_BYLINE_SNAPSHOT";

export class StoryCollectionError extends Error {
  constructor(public readonly code: StoryCollectionErrorCode) {
    super(code);
    this.name = "StoryCollectionError";
  }
}
