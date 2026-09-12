export type MediaStagingErrorCode =
  | "MEDIA_PROVIDER_INVALID"
  | "MEDIA_PROVIDER_UNAVAILABLE"
  | "MEDIA_URL_REJECTED"
  | "MEDIA_REDIRECT_REJECTED"
  | "MEDIA_MIME_MISMATCH"
  | "MEDIA_SIZE_INVALID"
  | "MEDIA_SIZE_MISMATCH"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_HASH_MISMATCH"
  | "MEDIA_CONTENT_INVALID"
  | "MEDIA_OBJECT_CONFLICT"
  | "MEDIA_OBJECT_UNAVAILABLE"
  | "MEDIA_COMPLETION_CONFLICT";

export class MediaStagingError extends Error {
  constructor(
    public readonly code: MediaStagingErrorCode,
    public readonly definitive: boolean,
  ) {
    super(code);
    this.name = "MediaStagingError";
  }
}
