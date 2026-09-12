export const APPROVED_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ApprovedImageMime = (typeof APPROVED_IMAGE_MIME)[number];

export type MediaAuthority = {
  providerMediaId: string;
  mimeType: ApprovedImageMime;
  providerSha256?: string;
  caption?: string;
};

export type ProviderMediaMetadata = {
  id?: string;
  url: string;
  mimeType: string;
  fileSize: number;
  sha256?: string;
};

export type DownloadedMedia = {
  bytes: Buffer;
  mimeType: ApprovedImageMime;
  size: number;
  sha256: string;
};

export type StoredObjectHead = {
  size: number;
  sha256: string;
  mimeType: string;
};

export interface MediaProviderClient {
  fetch(authority: MediaAuthority): Promise<DownloadedMedia>;
}

export interface MediaObjectStore {
  putIfAbsent(
    key: string,
    media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS">;
  head(key: string): Promise<StoredObjectHead | null>;
  read(key: string): Promise<Buffer>;
}

export const MEDIA_PROVIDER_CLIENT = Symbol("MEDIA_PROVIDER_CLIENT");
export const MEDIA_OBJECT_STORE = Symbol("MEDIA_OBJECT_STORE");

export function mediaObjectKey(mediaId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      mediaId,
    )
  )
    throw new Error("INVALID_MEDIA_ID");
  return `story-media/v1/${mediaId}/source`;
}
