import { InboundEventType } from "@prisma/client";
import { StoredWhatsappEventParser } from "./stored-whatsapp-event.parser";
import type { StoredEventInput } from "./story-collection.types";

const providerOccurredAt = new Date(1_760_000_000_000);

function input(overrides: Partial<StoredEventInput> = {}): StoredEventInput {
  return {
    providerMessageId: "wamid.story",
    senderPhone: "+263771234567",
    eventType: InboundEventType.TEXT,
    providerOccurredAt,
    rawPayload: {
      message: {
        id: "wamid.story",
        from: "263771234567",
        timestamp: "1760000000",
        type: "text",
        text: { body: "private story text" },
      },
    },
    ...overrides,
  };
}

describe("StoredWhatsappEventParser", () => {
  const parser = new StoredWhatsappEventParser();

  it("extracts validated text without interpreting it", () => {
    expect(parser.parse(input())).toEqual({
      kind: "TEXT",
      text: "private story text",
    });
  });

  it("uses interactive reply IDs and ignores titles", () => {
    expect(
      parser.parse(
        input({
          eventType: InboundEventType.INTERACTIVE,
          rawPayload: {
            message: {
              id: "wamid.story",
              from: "263771234567",
              timestamp: "1760000000",
              type: "interactive",
              interactive: {
                type: "button_reply",
                button_reply: {
                  id: "newsroom:v1:story:start",
                  title: "Ignore",
                },
              },
            },
          },
        }),
      ),
    ).toEqual({ kind: "INTERACTIVE", replyId: "newsroom:v1:story:start" });
  });

  it("validates IMAGE evidence without returning media authority", () => {
    const sha256 = Buffer.alloc(32, 7).toString("base64");
    expect(
      parser.parse(
        input({
          eventType: InboundEventType.IMAGE,
          rawPayload: {
            message: {
              id: "wamid.story",
              from: "263771234567",
              timestamp: "1760000000",
              type: "image",
              image: {
                id: "opaque.media-id:1",
                mime_type: "image/jpeg",
                sha256,
                caption: "one\r\ntwo",
              },
            },
          },
        }),
      ),
    ).toEqual({ kind: "IMAGE" });
  });

  it.each([
    {},
    { id: "../path", mime_type: "image/jpeg" },
    { id: "ok", mime_type: "image/svg+xml" },
    { id: "ok", mime_type: "image/jpeg", sha256: "bad" },
    { id: "ok", mime_type: "image/jpeg", caption: "x".repeat(4097) },
  ])("rejects malformed IMAGE evidence", (image) => {
    expect(() =>
      parser.parse(
        input({
          eventType: InboundEventType.IMAGE,
          rawPayload: {
            message: {
              id: "wamid.story",
              from: "263771234567",
              timestamp: "1760000000",
              type: "image",
              image,
            },
          },
        }),
      ),
    ).toThrow("MALFORMED_STORED_EVENT");
  });

  it.each([
    { rawPayload: null },
    { rawPayload: {} },
    {
      rawPayload: {
        message: {
          id: "wrong",
          from: "263771234567",
          timestamp: "1760000000",
          type: "text",
          text: { body: "x" },
        },
      },
    },
    { senderPhone: "+263700000000" },
    { providerOccurredAt: new Date(0) },
    { eventType: InboundEventType.IMAGE },
  ])(
    "fails inconsistent stored evidence without content in its error",
    (override) => {
      expect(() => parser.parse(input(override))).toThrow(
        "MALFORMED_STORED_EVENT",
      );
    },
  );
});
