import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HttpsPinnedTransport } from "./meta-media.client";

type ResponseCallback = (response: unknown) => void;

class MockClientRequest extends EventEmitter {
  timeoutHandler?: () => void;
  constructor(
    private readonly sentUrl: URL,
    private readonly sentOptions: Record<string, unknown>,
    private readonly responseCallback?: ResponseCallback,
  ) {
    super();
  }
  setTimeout(_timeoutMs: number, handler?: () => void): this {
    this.timeoutHandler = handler;
    return this;
  }
  destroy(error?: Error): this {
    this.emit("error", error ?? new Error("destroyed"));
    return this;
  }
  end(): void {}
  respond(): void {
    if (this.responseCallback) {
      this.responseCallback({
        statusCode: 200,
        headers: {},
        body: new PassThrough(),
      });
    }
  }
}

const mockRequests: Array<{
  url: URL;
  options: Record<string, unknown>;
  outgoing: MockClientRequest;
}> = [];

jest.mock("node:https", () => ({
  request: (
    url: unknown,
    options: Record<string, unknown>,
    callback?: (response: unknown) => void,
  ): MockClientRequest => {
    const outgoing = new MockClientRequest(url as URL, options, callback);
    mockRequests.push({ url: url as URL, options, outgoing });
    return outgoing;
  },
}));

type LookupFunction = (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address: string, family: number) => void,
) => void;

function capturedLookup(recorded: {
  options: Record<string, unknown>;
}): LookupFunction {
  return recorded.options.lookup as LookupFunction;
}

describe("HttpsPinnedTransport pinned-socket proof", () => {
  beforeEach(() => {
    mockRequests.length = 0;
  });

  it("connects only through the validated pinned address and never re-resolves the hostname", async () => {
    const transport = new HttpsPinnedTransport();
    const url = new URL("https://graph.facebook.com/v23.0/probe");
    const pinned = "203.0.113.9";
    const promise = transport.request(
      url,
      pinned,
      { Authorization: "Bearer test-token" },
      4321,
    );

    expect(mockRequests).toHaveLength(1);
    const recorded = mockRequests[0]!;
    expect(recorded.url.toString()).toBe(url.toString());
    expect(recorded.options.servername).toBe("graph.facebook.com");
    expect(recorded.options.headers).toEqual({
      Authorization: "Bearer test-token",
    });

    const lookup = capturedLookup(recorded);
    const first = await new Promise<{ address: string; family: number }>(
      (settle, fail) => {
        lookup("graph.facebook.com", {}, (error, address, family) => {
          if (error) fail(error);
          else settle({ address, family });
        });
      },
    );
    expect(first).toEqual({ address: pinned, family: 4 });

    const rehosted = await new Promise<{ address: string }>((settle, fail) => {
      lookup("evil.example", {}, (error, address) => {
        if (error) fail(error);
        else settle({ address });
      });
    });
    expect(rehosted.address).toBe(pinned);

    recorded.outgoing.respond();
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("preserves the approved hostname for TLS SNI independent of the pinned address", async () => {
    const transport = new HttpsPinnedTransport();
    const promise = transport.request(
      new URL("https://scontent.whatsapp.net/download"),
      "198.51.100.7",
      {},
      4321,
    );
    const recorded = mockRequests[0]!;
    expect(recorded.options.servername).toBe("scontent.whatsapp.net");
    expect(capturedLookup(recorded)).toBeDefined();
    recorded.outgoing.respond();
    await expect(promise).resolves.toMatchObject({ status: 200 });
  });

  it("times out and fails closed instead of hanging", async () => {
    const transport = new HttpsPinnedTransport();
    const promise = transport.request(
      new URL("https://lookaside.fbsbx.com/slow"),
      "8.8.8.8",
      {},
      250,
    );
    const recorded = mockRequests[0]!;
    expect(recorded.outgoing.timeoutHandler).toBeDefined();
    recorded.outgoing.timeoutHandler!();
    await expect(promise).rejects.toMatchObject({
      message: "MEDIA_PROVIDER_UNAVAILABLE",
    });
  });
});