import { ConfigService } from "@nestjs/config";
import { WhatsappOutboundClient } from "./whatsapp-outbound.client";
import type { MetaTransportRequest } from "./whatsapp-outbound.types";

describe("WhatsApp outbound client", () => {
  const config = new ConfigService({
    whatsapp: {
      accessToken: "test-token",
      phoneNumberId: "123456789",
      graphApiVersion: "v99.0",
      outboundRequestTimeoutMs: 5000,
    },
  });

  it("uses the fixed Meta destination and exact content-free interactive contract", async () => {
    let request: MetaTransportRequest | undefined;
    const transport = {
      send: jest.fn((value: MetaTransportRequest) => {
        request = value;
        return Promise.resolve({
          status: 200,
          body: { messages: [{ id: "wamid.test" }] },
        });
      }),
    };
    const client = new WhatsappOutboundClient(config as never, transport);
    await expect(
      client.sendApprovalPrompt({
        to: "+263771234567",
        previewUrl: "https://newsroom.test/preview#token=capability",
        controlId:
          "newsroom:v1:story:approve:11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBe("wamid.test");
    expect(request).toBeDefined();
    const sent = request!;
    expect(sent.url).toBe(
      "https://graph.facebook.com/v99.0/123456789/messages",
    );
    expect(sent.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(sent.body)).toMatchObject({
      messaging_product: "whatsapp",
      type: "interactive",
      interactive: { action: { buttons: [{ reply: { title: "Approve" } }] } },
    });
  });

  it.each([
    [{ status: 429, body: {} }, "WHATSAPP_SEND_OUTCOME_UNCERTAIN"],
    [{ status: 503, body: {} }, "WHATSAPP_SEND_OUTCOME_UNCERTAIN"],
    [{ status: 200, body: {} }, "WHATSAPP_SEND_OUTCOME_UNCERTAIN"],
    [{ status: 401, body: {} }, "WHATSAPP_AUTHENTICATION_FAILURE"],
    [{ status: 400, body: {} }, "WHATSAPP_REQUEST_REJECTED"],
  ])("classifies safe response outcomes", async (response, code) => {
    const client = new WhatsappOutboundClient(config as never, {
      send: jest.fn().mockResolvedValue(response),
    });
    await expect(
      client.sendApprovalPrompt({
        to: "+263771234567",
        previewUrl: "https://newsroom.test/preview#token=capability",
        controlId:
          "newsroom:v1:story:approve:11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toMatchObject({ code });
  });
});
