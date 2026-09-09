import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InboundEventType, type Prisma } from "@prisma/client";
import type { ApplicationConfiguration } from "../../config/configuration";
import type {
  NormalizedInboundEvent,
  NormalizedWebhookBatch,
} from "./whatsapp-webhook.types";

const INTERNATIONAL_DIGITS = /^[1-9][0-9]{6,14}$/;
const MAX_PROVIDER_MESSAGE_ID = 191;
const MAX_DATE_SECONDS = 8_640_000_000_000;

export class WhatsappWebhookPayloadError extends Error {
  constructor() {
    super("Malformed WhatsApp webhook payload.");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function occurredAt(value: unknown): Date {
  let seconds: number;
  if (typeof value === "string" && /^[0-9]{1,13}$/.test(value)) {
    seconds = Number(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    seconds = value;
  } else {
    throw new WhatsappWebhookPayloadError();
  }
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_DATE_SECONDS
  ) {
    throw new WhatsappWebhookPayloadError();
  }
  const result = new Date(seconds * 1000);
  if (Number.isNaN(result.getTime())) throw new WhatsappWebhookPayloadError();
  return result;
}

function eventType(value: string): InboundEventType {
  if (value === "text") return InboundEventType.TEXT;
  if (value === "image") return InboundEventType.IMAGE;
  if (value === "interactive") return InboundEventType.INTERACTIVE;
  return InboundEventType.UNKNOWN;
}

@Injectable()
export class WhatsappWebhookNormalizer {
  constructor(
    private readonly config: ConfigService<ApplicationConfiguration, true>,
  ) {}

  normalize(payload: unknown): NormalizedWebhookBatch {
    const root = record(payload);
    if (!root || root.object !== "whatsapp_business_account") {
      return { events: [], foreignPhoneChanges: 0, unsupportedChanges: 1 };
    }
    if (!Array.isArray(root.entry)) {
      return { events: [], foreignPhoneChanges: 0, unsupportedChanges: 1 };
    }

    const events: NormalizedInboundEvent[] = [];
    let foreignPhoneChanges = 0;
    let unsupportedChanges = 0;
    const configuredPhoneId = this.config.get("whatsapp.phoneNumberId", {
      infer: true,
    });

    for (const entryValue of root.entry) {
      const entry = record(entryValue);
      if (!entry || !Array.isArray(entry.changes)) {
        unsupportedChanges += 1;
        continue;
      }
      for (const changeValue of entry.changes) {
        const change = record(changeValue);
        if (!change || change.field !== "messages") {
          unsupportedChanges += 1;
          continue;
        }
        const value = record(change.value);
        if (!value) throw new WhatsappWebhookPayloadError();
        if (!Object.prototype.hasOwnProperty.call(value, "messages")) {
          unsupportedChanges += 1;
          continue;
        }
        if (!Array.isArray(value.messages))
          throw new WhatsappWebhookPayloadError();

        const metadata = record(value.metadata);
        if (!metadata || typeof metadata.phone_number_id !== "string") {
          throw new WhatsappWebhookPayloadError();
        }
        if (metadata.phone_number_id !== configuredPhoneId) {
          foreignPhoneChanges += 1;
          continue;
        }

        const contacts: unknown[] = Array.isArray(value.contacts) ? value.contacts : [];
        for (const messageValue of value.messages) {
          const message = record(messageValue);
          if (!message) throw new WhatsappWebhookPayloadError();
          const id = message.id;
          const sender = message.from;
          const type = message.type;
          if (
            typeof id !== "string" ||
            id.trim() === "" ||
            id.length > MAX_PROVIDER_MESSAGE_ID ||
            typeof sender !== "string" ||
            !INTERNATIONAL_DIGITS.test(sender) ||
            typeof type !== "string" ||
            type.trim() === ""
          ) {
            throw new WhatsappWebhookPayloadError();
          }
          const matchingContact = contacts.map(record).find((candidate) => candidate?.wa_id === sender);
          const fragment: Record<string, Prisma.InputJsonValue> = {
            object: root.object,
            change_field: change.field,
            metadata: metadata as Prisma.InputJsonObject,
            message: message as Prisma.InputJsonObject,
          };
          if (typeof entry.id === "string") {
            fragment.entry_id = entry.id;
          }
          if (matchingContact) {
            fragment.contact = matchingContact as Prisma.InputJsonObject;
          }
          events.push({
            providerMessageId: id,
            senderPhone: `+${sender}`,
            eventType: eventType(type),
            providerOccurredAt: occurredAt(message.timestamp),
            rawPayload: fragment,
          });
        }
      }
    }
    return { events, foreignPhoneChanges, unsupportedChanges };
  }
}
