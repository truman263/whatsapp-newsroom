import { Injectable } from "@nestjs/common";
import { InboundEventType } from "@prisma/client";
import { StoryCollectionError } from "./story-collection.errors";
import type {
  ParsedStoredEvent,
  StoredEventInput,
} from "./story-collection.types";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function malformed(): never {
  throw new StoryCollectionError("MALFORMED_STORED_EVENT");
}

const IMAGE_ID = /^[A-Za-z0-9._:-]{1,191}$/u;
const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const PROVIDER_SHA256 = /^[A-Za-z0-9+/]{43}=$/u;

@Injectable()
export class StoredWhatsappEventParser {
  parse(input: StoredEventInput): ParsedStoredEvent {
    const payload = object(input.rawPayload);
    const message = object(payload?.message);
    if (!payload || !message) return malformed();
    if (message.id !== input.providerMessageId) return malformed();
    if (
      typeof message.from !== "string" ||
      `+${message.from}` !== input.senderPhone
    )
      return malformed();
    if (
      typeof message.timestamp !== "string" ||
      !/^\d+$/u.test(message.timestamp)
    )
      return malformed();
    const occurredAt = new Date(Number(message.timestamp) * 1000);
    if (
      input.providerOccurredAt === null ||
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getTime() !== input.providerOccurredAt.getTime()
    )
      return malformed();
    const expectedType: Record<InboundEventType, string> = {
      TEXT: "text",
      IMAGE: "image",
      INTERACTIVE: "interactive",
      UNKNOWN: typeof message.type === "string" ? message.type : "",
    };
    if (
      typeof message.type !== "string" ||
      message.type !== expectedType[input.eventType]
    )
      return malformed();
    if (input.eventType === InboundEventType.TEXT) {
      const text = object(message.text);
      if (!text || typeof text.body !== "string") return malformed();
      return { kind: "TEXT", text: text.body };
    }
    if (input.eventType === InboundEventType.INTERACTIVE) {
      const interactive = object(message.interactive);
      if (
        !interactive ||
        (interactive.type !== "button_reply" &&
          interactive.type !== "list_reply")
      )
        return malformed();
      const selected = object(interactive[interactive.type]);
      const other =
        interactive.type === "button_reply"
          ? interactive.list_reply
          : interactive.button_reply;
      if (
        !selected ||
        other !== undefined ||
        typeof selected.id !== "string" ||
        selected.id.length < 1 ||
        selected.id.length > 191
      )
        return malformed();
      return { kind: "INTERACTIVE", replyId: selected.id };
    }
    if (input.eventType === InboundEventType.IMAGE) {
      const image = object(message.image);
      if (
        !image ||
        typeof image.id !== "string" ||
        !IMAGE_ID.test(image.id) ||
        typeof image.mime_type !== "string" ||
        !IMAGE_MIME.has(image.mime_type)
      )
        return malformed();
      if (image.sha256 !== undefined) {
        if (
          typeof image.sha256 !== "string" ||
          !PROVIDER_SHA256.test(image.sha256) ||
          Buffer.from(image.sha256, "base64").length !== 32 ||
          Buffer.from(image.sha256, "base64").toString("base64") !==
            image.sha256
        )
          return malformed();
      }
      if (image.caption !== undefined) {
        if (
          typeof image.caption !== "string" ||
          [...image.caption.replace(/\r\n?/gu, "\n")].length > 4096
        )
          return malformed();
      }
      return { kind: "IMAGE" };
    }
    return { kind: "UNKNOWN" };
  }
}
