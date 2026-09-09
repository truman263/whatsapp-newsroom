import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../../config/configuration";

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

@Injectable()
export class WhatsappWebhookSignatureService {
  constructor(
    private readonly config: ConfigService<ApplicationConfiguration, true>,
  ) {}

  verify(rawBody: Buffer | undefined, rawHeaders: readonly string[]): boolean {
    if (!Buffer.isBuffer(rawBody)) return false;

    const values: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === "x-hub-signature-256") {
        values.push(rawHeaders[index + 1] ?? "");
      }
    }
    if (values.length !== 1) return false;

    const match = SIGNATURE_PATTERN.exec(values[0] ?? "");
    if (!match) return false;

    const supplied = Buffer.from(match[1] ?? "", "hex");
    const expected = createHmac(
      "sha256",
      this.config.get("whatsapp.appSecret", { infer: true }),
    )
      .update(rawBody)
      .digest();
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  }
}
