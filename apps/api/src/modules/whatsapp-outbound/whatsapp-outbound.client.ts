import https from "node:https";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../../config/configuration";
import { WhatsappOutboundError } from "./whatsapp-outbound.errors";
import {
  META_OUTBOUND_TRANSPORT,
  type MetaOutboundTransport,
  type MetaTransportRequest,
  type MetaTransportResponse,
} from "./whatsapp-outbound.types";

const MAX_RESPONSE = 256 * 1024;

@Injectable()
export class HttpsMetaOutboundTransport implements MetaOutboundTransport {
  send(request: MetaTransportRequest): Promise<MetaTransportResponse> {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://graph.facebook.com"
    )
      return Promise.reject(new Error("INVALID_META_ORIGIN"));
    return new Promise((resolve, reject) => {
      const outgoing = https.request(
        url,
        {
          method: "POST",
          headers: {
            ...request.headers,
            "Content-Length": String(Buffer.byteLength(request.body)),
          },
          timeout: request.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE)
              response.destroy(new Error("RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              const raw = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode ?? 0,
                body: raw ? JSON.parse(raw) : null,
              });
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error("INVALID_META_RESPONSE"),
              );
            }
          });
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error("TIMEOUT")));
      outgoing.on("error", (error) =>
        reject(
          error instanceof Error ? error : new Error("META_TRANSPORT_FAILURE"),
        ),
      );
      outgoing.end(request.body);
    });
  }
}

@Injectable()
export class WhatsappOutboundClient {
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly version: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService<ApplicationConfiguration, true>,
    @Inject(META_OUTBOUND_TRANSPORT)
    private readonly transport: MetaOutboundTransport,
  ) {
    this.token = config.get("whatsapp.accessToken", { infer: true });
    this.phoneNumberId = config.get("whatsapp.phoneNumberId", { infer: true });
    this.version = config.get("whatsapp.graphApiVersion", { infer: true });
    this.timeoutMs = config.get("whatsapp.outboundRequestTimeoutMs", {
      infer: true,
    });
    if (!/^[0-9]{1,32}$/.test(this.phoneNumberId))
      throw new Error("Invalid WhatsApp phone number ID.");
  }

  async sendApprovalPrompt(input: {
    to: string;
    previewUrl: string;
    controlId: string;
  }): Promise<string> {
    if (
      !/^\+[1-9][0-9]{6,14}$/.test(input.to) ||
      !/^newsroom:v1:story:approve:[0-9a-f-]{36}$/.test(input.controlId)
    )
      throw new WhatsappOutboundError("WHATSAPP_PROMPT_CONTRACT_FAILURE");
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `Your story draft is ready for review.\nPreview: ${input.previewUrl}`,
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: input.controlId, title: "Approve" } },
          ],
        },
      },
    });
    let response: MetaTransportResponse;
    try {
      response = await this.transport.send({
        url: `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new WhatsappOutboundError("WHATSAPP_SEND_OUTCOME_UNCERTAIN", true);
    }
    if (response.status === 401 || response.status === 403)
      throw new WhatsappOutboundError("WHATSAPP_AUTHENTICATION_FAILURE");
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    )
      throw new WhatsappOutboundError("WHATSAPP_REQUEST_REJECTED");
    if (response.status < 200 || response.status >= 300)
      throw new WhatsappOutboundError("WHATSAPP_SEND_OUTCOME_UNCERTAIN", true);
    const id = providerId(response.body);
    if (!id)
      throw new WhatsappOutboundError("WHATSAPP_SEND_OUTCOME_UNCERTAIN", true);
    return id;
  }
}

function providerId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const messages = (body as Record<string, unknown>).messages;
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    !messages[0] ||
    typeof messages[0] !== "object"
  )
    return null;
  const id = (messages[0] as Record<string, unknown>).id;
  return typeof id === "string" &&
    id.trim() === id &&
    id.length > 0 &&
    id.length <= 191
    ? id
    : null;
}
