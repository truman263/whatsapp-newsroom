export type PreviewErrorCode =
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_VERSION_STALE"
  | "MEDIA_BYTES_UNAVAILABLE"
  | "MEDIA_BYTES_INTEGRITY_FAILURE";

export class PreviewError extends Error {
  constructor(public readonly code: PreviewErrorCode) {
    super(code);
    this.name = "PreviewError";
  }
}
