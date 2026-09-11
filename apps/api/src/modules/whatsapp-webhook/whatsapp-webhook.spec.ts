import { createHmac } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InboundEventType, Provider } from "@prisma/client";
import type { ApplicationConfiguration } from "../../config/configuration";
import type { PrismaService } from "../../database/prisma.service";
import { WhatsappWebhookIngestionService } from "./whatsapp-webhook-ingestion.service";
import {
  WhatsappWebhookNormalizer,
  WhatsappWebhookPayloadError,
} from "./whatsapp-webhook-normalizer";
import { WhatsappWebhookSignatureService } from "./whatsapp-webhook-signature.service";
import { WhatsappWebhookVerificationService } from "./whatsapp-webhook-verification.service";

const settings = {
  "whatsapp.appSecret": "unit-app-secret",
  "whatsapp.phoneNumberId": "newsroom-phone-id",
  "whatsapp.verifyToken": "unit-verify-token",
} as const;

function config(): ConfigService<ApplicationConfiguration, true> {
  return {
    get: jest.fn((key: keyof typeof settings) => settings[key]),
  } as unknown as ConfigService<ApplicationConfiguration, true>;
}

function message(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "wamid.1",
    from: "263771234567",
    timestamp: "1760000000",
    type: "text",
    text: { body: "private" },
    ...overrides,
  };
}

function payload(
  messages: unknown[] = [message()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: "newsroom-phone-id",
                display_phone_number: "hidden",
              },
              contacts: [
                { wa_id: "263771234567", profile: { name: "Private" } },
              ],
              messages,
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe("Whatsapp webhook security and normalisation", () => {
  it("uses timing-safe verification semantics without returning a token", () => {
    const service = new WhatsappWebhookVerificationService(config());
    expect(service.tokenMatches("unit-verify-token")).toBe(true);
    expect(service.tokenMatches("wrong")).toBe(false);
    expect(service.tokenMatches(undefined)).toBe(false);
  });

  it("accepts only one canonical signature over the exact raw bytes", () => {
    const raw = Buffer.from('{ "object": "whatsapp_business_account" }');
    const signature = `sha256=${createHmac("sha256", "unit-app-secret").update(raw).digest("hex")}`;
    const service = new WhatsappWebhookSignatureService(config());
    expect(service.verify(raw, ["X-Hub-Signature-256", signature])).toBe(true);
    expect(
      service.verify(Buffer.from(raw.toString().replace(" }", "}")), [
        "X-Hub-Signature-256",
        signature,
      ]),
    ).toBe(false);
    expect(service.verify(raw, [])).toBe(false);
    expect(service.verify(undefined, ["X-Hub-Signature-256", signature])).toBe(
      false,
    );
    expect(
      service.verify(raw, [
        "X-Hub-Signature-256",
        "sha256=ABC",
        "x-hub-signature-256",
        signature,
      ]),
    ).toBe(false);
    expect(
      service.verify(raw, ["X-Hub-Signature-256", "sha256=" + "0".repeat(64)]),
    ).toBe(false);
  });

  it.each([
    ["text", InboundEventType.TEXT],
    ["image", InboundEventType.IMAGE],
    ["interactive", InboundEventType.INTERACTIVE],
    ["audio", InboundEventType.UNKNOWN],
  ])(
    "maps %s to %s and preserves authenticated provenance",
    (type, expected) => {
      const batch = new WhatsappWebhookNormalizer(config()).normalize(
        payload([message({ type })]),
      );
      expect(batch.events).toHaveLength(1);
      expect(batch.events[0]).toMatchObject({
        providerMessageId: "wamid.1",
        senderPhone: "+263771234567",
        eventType: expected,
        providerOccurredAt: new Date(1_760_000_000_000),
        rawPayload: {
          object: "whatsapp_business_account",
          entry_id: "waba-1",
          change_field: "messages",
          // Jest asymmetric matchers are intentionally dynamic at this assertion boundary.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          contact: expect.any(Object),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          message: expect.any(Object),
        },
      });
    },
  );

  it.each([
    [message({ from: "0263771234567" })],
    [message({ id: "" })],
    [message({ id: "x".repeat(192) })],
    [message({ timestamp: "not-a-time" })],
    [message({ timestamp: "9999999999999" })],
    [message({ type: "" })],
  ])(
    "rejects an invalid supported message before producing candidates",
    (invalid) => {
      expect(() =>
        new WhatsappWebhookNormalizer(config()).normalize(
          payload([message(), invalid]),
        ),
      ).toThrow(WhatsappWebhookPayloadError);
    },
  );

  it("traverses multiple entries, changes, and messages", () => {
    const body = payload([
      message(),
      message({ id: "wamid.2", type: "image" }),
    ]);
    const firstEntry = (body.entry as Record<string, unknown>[])[0];
    body.entry = [
      firstEntry,
      {
        id: "waba-2",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "newsroom-phone-id" },
              messages: [message({ id: "wamid.3" })],
            },
          },
        ],
      },
    ];
    expect(
      new WhatsappWebhookNormalizer(config()).normalize(body).events,
    ).toHaveLength(3);
  });

  it("acknowledges status, unsupported, foreign-phone, and wrong-object payloads with zero candidates", () => {
    const normalizer = new WhatsappWebhookNormalizer(config());
    expect(
      normalizer.normalize({
        object: "whatsapp_business_account",
        entry: [
          { changes: [{ field: "messages", value: { statuses: [{}] } }] },
        ],
      }).events,
    ).toHaveLength(0);
    expect(
      normalizer.normalize({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "statuses", value: {} }] }],
      }).events,
    ).toHaveLength(0);
    expect(
      normalizer.normalize(
        payload([message()], { metadata: { phone_number_id: "foreign" } }),
      ).events,
    ).toHaveLength(0);
    expect(normalizer.normalize({ object: "other" }).events).toHaveLength(0);
  });
});

describe("WhatsappWebhookIngestionService", () => {
  it("persists WHATSAPP candidates with database-backed duplicate handling and approved defaults", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ nextValue: 0n }]),
      inboundSenderSequence: { update: jest.fn().mockResolvedValue({}) },
      inboundEvent: { createMany },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    } as unknown as PrismaService;
    const event = new WhatsappWebhookNormalizer(config()).normalize(payload())
      .events[0]!;
    await expect(
      new WhatsappWebhookIngestionService(prisma).persist({
        events: [event, event],
        foreignPhoneChanges: 0,
        unsupportedChanges: 0,
      }),
    ).resolves.toEqual({ inserted: 1 });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          provider: Provider.WHATSAPP,
          reporterId: null,
        }),
        expect.any(Object),
      ],
      skipDuplicates: true,
    });
    // Jest records mock arguments dynamically; the production Prisma call is statically typed.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const stored = createMany.mock.calls[0]?.[0].data[0] as Record<
      string,
      unknown
    >;
    expect(stored).not.toHaveProperty("processingStatus");
    expect(stored.senderIngestSequence).toBe(0n);
    expect(JSON.stringify(stored.rawPayload)).not.toMatch(
      /app-secret|verify-token|signature/i,
    );
  });

  it("does not call the database for an empty batch", async () => {
    const createMany = jest.fn();
    const prisma = { inboundEvent: { createMany } } as unknown as PrismaService;
    await expect(
      new WhatsappWebhookIngestionService(prisma).persist({
        events: [],
        foreignPhoneChanges: 0,
        unsupportedChanges: 1,
      }),
    ).resolves.toEqual({ inserted: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("maps database failures to a retriable generic 503 exception", async () => {
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValue(new Error("secret database detail")),
    } as unknown as PrismaService;
    const event = new WhatsappWebhookNormalizer(config()).normalize(payload())
      .events[0]!;
    await expect(
      new WhatsappWebhookIngestionService(prisma).persist({
        events: [event],
        foreignPhoneChanges: 0,
        unsupportedChanges: 0,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
