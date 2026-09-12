import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MediaStagingError } from "./media-staging.errors";
import {
  approvedMetaHost,
  isPublicAddress,
  validateMediaUrl,
} from "./meta-media-security";
import type {
  ApprovedImageMime,
  DownloadedMedia,
  MediaAuthority,
  MediaProviderClient,
  ProviderMediaMetadata,
} from "./media-staging.types";
import { APPROVED_IMAGE_MIME } from "./media-staging.types";

export type PinnedResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
};
export interface MetaTransport {
  request(
    url: URL,
    address: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<PinnedResponse>;
}
export interface MetaResolver {
  resolve(hostname: string): Promise<string[]>;
}

@Injectable()
export class SystemMetaResolver implements MetaResolver {
  async resolve(hostname: string): Promise<string[]> {
    return (await lookup(hostname, { all: true, verbatim: true })).map(
      ({ address }) => address,
    );
  }
}

@Injectable()
export class HttpsPinnedTransport implements MetaTransport {
  request(
    url: URL,
    address: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          headers,
          servername: url.hostname,
          lookup: (_host, _options, callback) =>
            callback(null, address, address.includes(":") ? 6 : 4),
        },
        (response) => {
          const normalized: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(response.headers))
            normalized[key] = Array.isArray(value) ? value.join(",") : value;
          resolve({
            status: response.statusCode ?? 0,
            headers: normalized,
            body: response,
          });
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error("MEDIA_PROVIDER_UNAVAILABLE")),
      );
      req.on("error", reject);
      req.end();
    });
  }
}

@Injectable()
export class MetaMediaClient implements MediaProviderClient {
  private readonly token: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  constructor(
    private readonly transport: HttpsPinnedTransport,
    private readonly resolver: SystemMetaResolver,
    config: ConfigService,
  ) {
    this.token = config.getOrThrow<string>("whatsapp.accessToken");
    this.maxBytes = config.getOrThrow<number>("mediaStaging.maxBytes");
    this.timeoutMs = config.getOrThrow<number>("mediaStaging.requestTimeoutMs");
  }

  async fetch(authority: MediaAuthority): Promise<DownloadedMedia> {
    const metadataUrl = new URL(
      `https://graph.facebook.com/v23.0/${encodeURIComponent(authority.providerMediaId)}`,
    );
    const metadataResponse = await this.secureRequest(metadataUrl, true, 0);
    if (metadataResponse.status < 200 || metadataResponse.status >= 300)
      throw new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false);
    const metadataBytes = await collectBounded(metadataResponse.body, 64 * 1024);
    let raw: unknown;
    try {
      raw = JSON.parse(metadataBytes.toString("utf8"));
    } catch {
      throw new MediaStagingError("MEDIA_PROVIDER_INVALID", true);
    }
    const metadata = parseMetadata(
      raw,
      authority.providerMediaId,
      this.maxBytes,
    );
    if (metadata.mimeType !== authority.mimeType)
      throw new MediaStagingError("MEDIA_MIME_MISMATCH", true);
    let mediaUrl: URL;
    try {
      mediaUrl = new URL(metadata.url);
    } catch {
      throw new MediaStagingError("MEDIA_URL_REJECTED", true);
    }
    const response = await this.secureRequest(mediaUrl, true, 0);
    if (response.status < 200 || response.status >= 300)
      throw new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false);
    const contentType = response.headers["content-type"]
      ?.split(";", 1)[0]
      ?.trim();
    if (contentType !== authority.mimeType || contentType !== metadata.mimeType)
      throw new MediaStagingError("MEDIA_MIME_MISMATCH", true);
    const declared = response.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/u.test(declared) ||
        Number(declared) < 1 ||
        Number(declared) > this.maxBytes)
    )
      throw new MediaStagingError(
        Number(declared) > this.maxBytes
          ? "MEDIA_TOO_LARGE"
          : "MEDIA_SIZE_INVALID",
        true,
      );
    const bytes = await collectBounded(response.body, this.maxBytes);
    if (bytes.length === 0)
      throw new MediaStagingError("MEDIA_SIZE_INVALID", true);
    if (declared !== undefined && Number(declared) !== bytes.length)
      throw new MediaStagingError("MEDIA_SIZE_MISMATCH", true);
    if (bytes.length !== metadata.fileSize)
      throw new MediaStagingError("MEDIA_SIZE_MISMATCH", true);
    validateMagic(bytes, authority.mimeType);
    const digest = createHash("sha256").update(bytes).digest();
    for (const providerHash of [
      authority.providerSha256,
      metadata.sha256,
    ].filter((value): value is string => value !== undefined)) {
      const expected = Buffer.from(providerHash, "base64");
      if (
        expected.length !== digest.length ||
        !timingSafeEqual(expected, digest)
      )
        throw new MediaStagingError("MEDIA_HASH_MISMATCH", true);
    }
    return {
      bytes,
      mimeType: authority.mimeType,
      size: bytes.length,
      sha256: digest.toString("hex"),
    };
  }

  private async secureRequest(
    url: URL,
    includeToken: boolean,
    redirects: number,
  ): Promise<PinnedResponse> {
    if (redirects > 3)
      throw new MediaStagingError("MEDIA_REDIRECT_REJECTED", true);
    let validated: URL;
    try {
      validated = validateMediaUrl(url.toString());
    } catch {
      throw new MediaStagingError("MEDIA_URL_REJECTED", true);
    }
    const addresses = await this.resolver.resolve(validated.hostname);
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isPublicAddress(address))
    )
      throw new MediaStagingError("MEDIA_URL_REJECTED", true);
    let response: PinnedResponse;
    try {
      response = await this.transport.request(
        validated,
        addresses[0]!,
        includeToken && approvedMetaHost(validated.hostname)
          ? { Authorization: `Bearer ${this.token}` }
          : {},
        this.timeoutMs,
      );
    } catch {
      throw new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location)
        throw new MediaStagingError("MEDIA_REDIRECT_REJECTED", true);
      let target: URL;
      try {
        target = new URL(location, validated);
      } catch {
        throw new MediaStagingError("MEDIA_REDIRECT_REJECTED", true);
      }
      return this.secureRequest(
        target,
        approvedMetaHost(target.hostname),
        redirects + 1,
      );
    }
    return response;
  }
}

function parseMetadata(
  value: unknown,
  requestedId: string,
  maxBytes: number,
): ProviderMediaMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MediaStagingError("MEDIA_PROVIDER_INVALID", true);
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id !== requestedId)
    throw new MediaStagingError("MEDIA_PROVIDER_INVALID", true);
  if (
    typeof data.url !== "string" ||
    typeof data.mime_type !== "string" ||
    !APPROVED_IMAGE_MIME.includes(data.mime_type as ApprovedImageMime) ||
    typeof data.file_size !== "number" ||
    !Number.isSafeInteger(data.file_size) ||
    data.file_size < 1 ||
    data.file_size > maxBytes
  )
    throw new MediaStagingError("MEDIA_PROVIDER_INVALID", true);
  if (
    data.sha256 !== undefined &&
    (typeof data.sha256 !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/u.test(data.sha256) ||
      Buffer.from(data.sha256, "base64").length !== 32 ||
      Buffer.from(data.sha256, "base64").toString("base64") !== data.sha256)
  )
    throw new MediaStagingError("MEDIA_PROVIDER_INVALID", true);
  return {
    id: data.id,
    url: data.url,
    mimeType: data.mime_type,
    fileSize: data.file_size,
    ...(typeof data.sha256 === "string" ? { sha256: data.sha256 } : {}),
  };
}

export async function collectBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new MediaStagingError("MEDIA_TOO_LARGE", true);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof MediaStagingError) throw error;
    throw new MediaStagingError("MEDIA_PROVIDER_UNAVAILABLE", false);
  }
  return Buffer.concat(chunks, size);
}

function validateMagic(bytes: Buffer, mime: ApprovedImageMime): void {
  const valid =
    mime === "image/png"
      ? bytes.length >= 24 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? bytes.length >= 4 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes.at(-2) === 0xff &&
          bytes.at(-1) === 0xd9
        : mime === "image/gif"
          ? bytes.length >= 13 &&
            ["GIF87a", "GIF89a"].includes(
              bytes.subarray(0, 6).toString("ascii"),
            )
          : bytes.length >= 12 &&
            bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new MediaStagingError("MEDIA_CONTENT_INVALID", true);
}
