import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../../config/configuration";
import { DraftPreparationService } from "../draft-preparation/draft-preparation.service";
import { PreviewError } from "./newsroom-preview.errors";
import type { PreviewClaims } from "./newsroom-preview.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN = 2048;

@Injectable()
export class PreviewTokenService {
  private readonly secret: Buffer;

  constructor(
    config: ConfigService<ApplicationConfiguration, true>,
    private readonly preparations: DraftPreparationService,
  ) {
    this.secret = Buffer.from(
      String(config.get("preview.hmacSecret", { infer: true })),
      "base64url",
    );
  }

  async issue(preparationId: string): Promise<string> {
    const authority =
      await this.preparations.verifyPreparedAuthority(preparationId);
    const claims: PreviewClaims = {
      v: 1,
      preparation_id: authority.preparationId,
      story_id: authority.storyId,
      story_version: authority.storyVersion,
      wordpress_applied_version: authority.wordpressAppliedVersion,
      exp: Math.floor(authority.previewExpiresAt.getTime() / 1000),
    };
    if (Math.floor(Date.now() / 1000) >= claims.exp)
      throw new PreviewError("PREVIEW_EXPIRED");
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  verify(token: string, now = new Date()): PreviewClaims {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_TOKEN ||
      token.trim() !== token ||
      token.includes("=")
    )
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every((part) => B64.test(part)))
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    const payload = parts[0]!;
    const signature = parts[1]!;
    const expected = Buffer.from(this.sign(payload), "ascii");
    const actual = Buffer.from(signature, "ascii");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    let value: unknown;
    try {
      const decoded = Buffer.from(payload, "base64url");
      if (decoded.toString("base64url") !== payload) throw new Error();
      const json = decoded.toString("utf8");
      value = JSON.parse(json);
      if (JSON.stringify(value) !== json) throw new Error();
    } catch {
      throw new PreviewError("PREVIEW_UNAVAILABLE");
    }
    if (!validClaims(value)) throw new PreviewError("PREVIEW_UNAVAILABLE");
    if (Math.floor(now.getTime() / 1000) >= value.exp)
      throw new PreviewError("PREVIEW_EXPIRED");
    return value;
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.secret)
      .update(`newsroom-preview-v1\n${encoded}`, "utf8")
      .digest("base64url");
  }
}

function validClaims(value: unknown): value is PreviewClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row)) !==
    JSON.stringify([
      "v",
      "preparation_id",
      "story_id",
      "story_version",
      "wordpress_applied_version",
      "exp",
    ])
  )
    return false;
  return (
    row.v === 1 &&
    typeof row.preparation_id === "string" &&
    UUID.test(row.preparation_id) &&
    typeof row.story_id === "string" &&
    UUID.test(row.story_id) &&
    Number.isSafeInteger(row.story_version) &&
    (row.story_version as number) >= 0 &&
    typeof row.wordpress_applied_version === "string" &&
    HEX.test(row.wordpress_applied_version) &&
    Number.isSafeInteger(row.exp) &&
    (row.exp as number) > 0
  );
}
