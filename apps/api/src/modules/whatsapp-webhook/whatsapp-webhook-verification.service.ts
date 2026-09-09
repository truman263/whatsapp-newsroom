import { createHash, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../../config/configuration";

@Injectable()
export class WhatsappWebhookVerificationService {
  constructor(
    private readonly config: ConfigService<ApplicationConfiguration, true>,
  ) {}

  tokenMatches(candidate: unknown): candidate is string {
    if (typeof candidate !== "string") return false;
    const supplied = createHash("sha256").update(candidate, "utf8").digest();
    const expected = createHash("sha256")
      .update(this.config.get("whatsapp.verifyToken", { infer: true }), "utf8")
      .digest();
    return timingSafeEqual(supplied, expected);
  }
}
