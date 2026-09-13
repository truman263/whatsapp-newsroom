import { createHmac } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Server } from "node:http";
import { createConnection } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/database/prisma.service";

const secret = "test-app-secret";
const verifyToken = "test-verify-token";

function signature(raw: string, key = secret): string {
  return `sha256=${createHmac("sha256", key).update(Buffer.from(raw)).digest("hex")}`;
}

function body(id = "wamid.e2e"): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123456789" },
              messages: [
                {
                  id,
                  from: "263771234567",
                  timestamp: "1760000000",
                  type: "text",
                  text: { body: "never log this" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsApp webhook (e2e)", () => {
  let app: INestApplication;
  const createMany = jest.fn();
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([{ nextValue: 0n }]),
    inboundSenderSequence: { update: jest.fn().mockResolvedValue({}) },
    inboundEvent: { createMany },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.WHATSAPP_APP_SECRET = secret;
    process.env.WHATSAPP_VERIFY_TOKEN = verifyToken;
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $transaction: (operation: (client: typeof tx) => unknown) =>
          operation(tx),
      })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
  });

  beforeEach(() => createMany.mockReset().mockResolvedValue({ count: 1 }));
  afterAll(async () => app.close());

  it("returns the exact verification challenge as plaintext", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const response = await request(app.getHttpServer())
      .get("/webhooks/whatsapp")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": verifyToken,
        "hub.challenge": "challenge-123",
      })
      .expect(200);
    expect(response.text).toBe("challenge-123");
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it.each([
    [
      {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "x",
      },
      403,
    ],
    [
      {
        "hub.mode": "other",
        "hub.verify_token": verifyToken,
        "hub.challenge": "x",
      },
      403,
    ],
    [{ "hub.mode": "subscribe", "hub.challenge": "x" }, 403],
    [{ "hub.mode": "subscribe", "hub.verify_token": verifyToken }, 400],
  ])("rejects invalid verification query %#", async (query, status) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const response = await request(app.getHttpServer())
      .get("/webhooks/whatsapp")
      .query(query)
      .expect(status);
    expect(response.text).not.toContain(verifyToken);
  });

  it("authenticates the exact bytes Nest receives before durable persistence", async () => {
    const raw = JSON.stringify(body(), null, 2) + "\n";
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .post("/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(raw))
      .send(raw)
      .expect(200, { received: true });
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing signature", undefined],
    ["malformed signature", "sha256=bad"],
    ["wrong signature", "sha256=" + "0".repeat(64)],
  ])(
    "returns one generic authentication failure for %s",
    async (_name, header) => {
      const raw = JSON.stringify(body());
      // Nest exposes the platform server dynamically; Supertest validates it at runtime.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      let call = request(app.getHttpServer())
        .post("/webhooks/whatsapp")
        .set("Content-Type", "application/json");
      if (header) call = call.set("X-Hub-Signature-256", header);
      const response = await call.send(raw).expect(401);
      expect((response.body as { message: unknown }).message).toBe(
        "Webhook authentication failed.",
      );
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it("rejects signatures made with the wrong secret or over different whitespace", async () => {
    const raw = JSON.stringify(body());
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .post("/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(raw, "wrong-secret"))
      .send(raw)
      .expect(401);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .post("/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(raw))
      .send(raw + " ")
      .expect(401);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("rejects the whole authenticated malformed batch before persistence", async () => {
    const malformed = body();
    const messages = (
      (
        (malformed.entry as Record<string, unknown>[])[0]?.changes as Record<
          string,
          unknown
        >[]
      )[0]?.value as Record<string, unknown>
    ).messages as Record<string, unknown>[];
    messages.push({
      id: "",
      from: "263771234567",
      timestamp: "1760000000",
      type: "text",
    });
    const raw = JSON.stringify(malformed);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .post("/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(raw))
      .send(raw)
      .expect(400);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("acknowledges status-only and foreign-phone payloads without persistence", async () => {
    for (const value of [
      {
        object: "whatsapp_business_account",
        entry: [
          { changes: [{ field: "messages", value: { statuses: [{}] } }] },
        ],
      },
      {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "foreign" },
                  messages: [
                    {
                      id: "x",
                      from: "263771234567",
                      timestamp: "1760000000",
                      type: "text",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ]) {
      const raw = JSON.stringify(value);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await request(app.getHttpServer())
        .post("/webhooks/whatsapp")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", signature(raw))
        .send(raw)
        .expect(200, { received: true });
    }
    expect(createMany).not.toHaveBeenCalled();
  });

  it("returns 503 when durable persistence fails", async () => {
    createMany.mockRejectedValueOnce(new Error("database down"));
    const raw = JSON.stringify(body());
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    await request(app.getHttpServer())
      .post("/webhooks/whatsapp")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signature(raw))
      .send(raw)
      .expect(503);
  });

  it("rejects duplicate physical signature headers", async () => {
    const raw = JSON.stringify(body());
    const server = app.getHttpServer() as Server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(address.port, "127.0.0.1");
      let output = "";
      socket.on("connect", () =>
        socket.write(
          `POST /webhooks/whatsapp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(raw)}\r\nX-Hub-Signature-256: ${signature(raw)}\r\nX-Hub-Signature-256: ${signature(raw)}\r\nConnection: close\r\n\r\n${raw}`,
        ),
      );
      socket.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      socket.on("end", () => resolve(output));
      socket.on("error", reject);
    });
    expect(response).toMatch(/^HTTP\/1\.1 401/);
    expect(createMany).not.toHaveBeenCalled();
  });
});
