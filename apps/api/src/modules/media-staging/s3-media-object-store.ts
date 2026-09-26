import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { MediaStagingError } from "./media-staging.errors";
import {
  APPROVED_IMAGE_MIME,
  type DownloadedMedia,
  type MediaObjectStore,
  type StoredObjectHead,
} from "./media-staging.types";

export type S3MediaObjectStoreOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  maxReadBytes: number;
};

export class S3MediaObjectStore implements MediaObjectStore {
  private readonly client: S3Client;
  constructor(
    private readonly options: S3MediaObjectStoreOptions,
    client?: S3Client,
  ) {
    if (!options.accessKeyId || !options.secretAccessKey)
      throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", true);
    this.client =
      client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          sessionToken: options.sessionToken,
        },
      });
  }
  private validateKey(key: string): void {
    if (
      !/^story-media\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/source$/u.test(
        key,
      )
    )
      throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
  }
  async putIfAbsent(
    key: string,
    media: DownloadedMedia,
  ): Promise<"CREATED" | "EXISTS"> {
    this.validateKey(key);
    const digest = createHash("sha256").update(media.bytes).digest("hex");
    if (
      media.size !== media.bytes.length ||
      digest !== media.sha256.toLowerCase() ||
      !APPROVED_IMAGE_MIME.includes(media.mimeType)
    )
      throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: media.bytes,
          ContentLength: media.size,
          ContentType: media.mimeType,
          Metadata: { sha256: digest },
          ServerSideEncryption: "AES256",
          IfNoneMatch: "*",
        }),
      );
      return "CREATED";
    } catch (error: unknown) {
      const status = sdkStatus(error);
      if (status === 412 || status === undefined) {
        const existing = await this.head(key).catch(() => null);
        if (existing) return "EXISTS";
      }
      throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
    }
  }
  async head(key: string): Promise<StoredObjectHead | null> {
    this.validateKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      const size = Number(result.ContentLength);
      const mimeType = result.ContentType;
      const sha256 = result.Metadata?.sha256?.toLowerCase();
      if (
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        !mimeType ||
        !APPROVED_IMAGE_MIME.includes(mimeType as never) ||
        !sha256 ||
        !/^[a-f0-9]{64}$/u.test(sha256)
      )
        throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
      return { size, mimeType, sha256 };
    } catch (error: unknown) {
      if (error instanceof MediaStagingError) throw error;
      if (sdkStatus(error) === 404) return null;
      throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
    }
  }
  async read(key: string): Promise<Buffer> {
    this.validateKey(key);
    const expected = await this.head(key);
    if (!expected)
      throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
    if (expected.size > this.options.maxReadBytes)
      throw new MediaStagingError("MEDIA_TOO_LARGE", true);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (Number(result.ContentLength) !== expected.size)
        throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > this.options.maxReadBytes || size > expected.size)
          throw new MediaStagingError("MEDIA_TOO_LARGE", true);
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== expected.size ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      )
        throw new MediaStagingError("MEDIA_OBJECT_CONFLICT", true);
      return bytes;
    } catch (error: unknown) {
      if (error instanceof MediaStagingError) throw error;
      throw new MediaStagingError("MEDIA_OBJECT_UNAVAILABLE", false);
    }
  }
}

function sdkStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const metadata: unknown = (error as Record<string, unknown>).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const status: unknown = (metadata as Record<string, unknown>).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}
