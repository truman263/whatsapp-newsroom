import { WordPressMediaClient, type MediaTransportResponse, type WordPressMediaTransport } from "./wordpress-media.client";
import { WordPressMediaError } from "./wordpress-media.errors";

const FIXED_NOW = 1750000000 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KAT_BODY = Buffer.concat([PNG_MAGIC, Buffer.from("FIXTURE-BYTES", "ascii")]);
const SECRET = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const KEY_ID = "media-local-v1";
const BASE_URL = "https://localhost:8080";
const SUBDIRECTORY_URL = "https://site.example/wp";
const MEDIA_KEY = "01234567-89ab-47cd-8e01-23456789abcd";
const FILENAME = "hero.png";
const MIME = "image/png";
const REQUEST_TIMEOUT_MS = 60000;
const MAX_BYTES = 500000;

const createClient = (
  transport: WordPressMediaTransport,
  overrides: Partial<{
    reconciliationAttempts: number;
    reconciliationDelayMs: number;
    baseUrl: string;
  }> = {},
  now: () => number = () => FIXED_NOW,
): WordPressMediaClient =>
  new WordPressMediaClient(
    {
      baseUrl: overrides.baseUrl ?? BASE_URL,
      keyId: KEY_ID,
      secret: SECRET,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      reconciliationAttempts: overrides.reconciliationAttempts ?? 3,
      reconciliationDelayMs: overrides.reconciliationDelayMs ?? 0,
      maxBytes: MAX_BYTES,
    },
    transport,
    now,
  );

class MockTransport implements WordPressMediaTransport {
  public requests: Array<{
    method: string;
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: Buffer;
  }> = [];
  private readonly queue: Array<() => Promise<MediaTransportResponse>>;

  constructor(behaviors: Array<MediaTransportResponse | Error | "throw-unavailable">) {
    this.queue = behaviors.map((behavior): (() => Promise<MediaTransportResponse>) => () => {
      if (behavior === "throw-unavailable") throw new Error("connection refused");
      if (behavior instanceof Error) throw behavior;
      return Promise.resolve(behavior);
    });
  }

  async send(request: { method: "GET" | "POST"; url: string; headers: Readonly<Record<string, string>>; body?: Buffer; timeoutMs: number }): Promise<MediaTransportResponse> {
    if (this.queue.length === 0) throw new Error(`unexpected ${request.method} ${request.url}`);
    this.requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
    const behavior = this.queue.shift()!;
    return behavior();
  }
}

const requestAt = (transport: MockTransport, index: number): MockTransport["requests"][number] => {
  const request = transport.requests[index];
  if (!request) throw new Error("No transport request was recorded.");
  return request;
};

const created = (extra: Partial<Record<string, unknown>> = {}): MediaTransportResponse => ({
  status: 201,
  body: {
    media_key: MEDIA_KEY,
    attachment_id: 41,
    status: "attachment",
    replayed: false,
    ...extra,
  },
});
const replayed = (extra: Partial<Record<string, unknown>> = {}): MediaTransportResponse => ({
  status: 200,
  body: {
    media_key: MEDIA_KEY,
    attachment_id: 41,
    status: "attachment",
    replayed: true,
    ...extra,
  },
});
const attachment = (extra: Partial<Record<string, unknown>> = {}): MediaTransportResponse => ({
  status: 200,
  body: {
    media_key: MEDIA_KEY,
    attachment_id: 41,
    status: "attachment",
    replayed: true,
    ...extra,
  },
});
const mediaKeyIn = (url: string): boolean => url.endsWith(`/newsroom-media/v1/media/${MEDIA_KEY}`);

describe("WordPressMediaClient", () => {
  it("POST: transmits the exact binary Buffer as the request body with application/octet-stream", async () => {
    const transport = new MockTransport([created()]);
    const client = createClient(transport);
    const result = await client.uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result).toEqual({
      mediaKey: MEDIA_KEY,
      attachmentId: 41,
      status: "attachment",
      outcome: "CREATED",
    });
    expect(transport.requests).toHaveLength(1);
    const post = requestAt(transport, 0);
    expect(post.method).toBe("POST");
    expect(post.body).toBe(KAT_BODY);
    expect(post.headers["Content-Type"]).toBe("application/octet-stream");
    expect(post.headers["X-Newsroom-Media-Auth-Version"]).toBe("1");
    expect(post.headers["X-Newsroom-Media-Signature"]).toBe("3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd");
  });

  it("POST: never sends Authorization, Cookie or X-WP-Nonce headers", async () => {
    const transport = new MockTransport([created()]);
    const client = createClient(transport);
    await client.uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    const post = requestAt(transport, 0);
    const headerNames = Object.keys(post.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("x-wp-nonce");
  });

  it("POST: replayed 200 returns a REPLAYED outcome", async () => {
    const transport = new MockTransport([replayed()]);
    const result = await createClient(transport).uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result.outcome).toBe("REPLAYED");
    expect(result.attachmentId).toBe(41);
  });

  it("POST: a body over the byte limit is rejected without a transport call", async () => {
    const transport = new MockTransport([created()]);
    const toobits = Buffer.alloc(MAX_BYTES + 1);
    await expect(
      createClient(transport).uploadMedia({
        mediaKey: MEDIA_KEY,
        filename: FILENAME,
        mimeType: MIME,
        body: toobits,
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_REJECTED" });
    expect(transport.requests).toHaveLength(0);
  });

  it("POST: maps status codes to the strict media error taxonomy", async () => {
    const cases: Array<[number, string, number | undefined]> = [
      [400, "CONTRACT_FAILURE", 400],
      [401, "AUTHENTICATION_FAILURE", 401],
      [403, "AUTHENTICATION_FAILURE", 403],
      [404, "NOT_FOUND", 404],
      [409, "CONFLICT", 409],
      [413, "PAYLOAD_REJECTED", 413],
      [503, "IN_PROGRESS", 503],
      [418, "UNEXPECTED_RESPONSE", 418],
    ];
    for (const [status, code, httpStatus] of cases) {
      const transport = new MockTransport([{ status, body: {} }]);
      await expect(
        createClient(transport).uploadMedia({
          mediaKey: MEDIA_KEY,
          filename: FILENAME,
          mimeType: MIME,
          body: KAT_BODY,
        }),
      ).rejects.toMatchObject({
        code,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
    }
  });
  it("POST: a non-503 server failure is treated as uncertain and reinvestigated", async () => {
    const transport = new MockTransport([{ status: 500, body: {} }, attachment()]);
    const result = await createClient(transport).uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result.outcome).toBe("RECOVERED");
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
  });

  it("GET: sends no body and no Content-Type/Content-Length headers", async () => {
    const transport = new MockTransport([attachment()]);
    const result = await createClient(transport).getMediaByKey(MEDIA_KEY);
    expect(result).toEqual({
      mediaKey: MEDIA_KEY,
      attachmentId: 41,
      status: "attachment",
    });
    const get = requestAt(transport, 0);
    expect(get.method).toBe("GET");
    expect(get.body).toBeUndefined();
    const headerNames = Object.keys(get.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("content-type");
    expect(headerNames).not.toContain("content-length");
  });

  it("GET: the URL carries no query string", async () => {
    const transport = new MockTransport([attachment()]);
    await createClient(transport).getMediaByKey(MEDIA_KEY);
    expect(requestAt(transport, 0).url).not.toContain("?");
  });

  it("GET: joins the concrete route onto a subdirectory baseUrl", async () => {
    const transport = new MockTransport([attachment()]);
    await createClient(transport, { baseUrl: SUBDIRECTORY_URL }).getMediaByKey(MEDIA_KEY);
    expect(requestAt(transport, 0).url).toBe(`${SUBDIRECTORY_URL}/wp-json/newsroom-media/v1/media/${MEDIA_KEY}`);
  });

  it("GET: a reserved row surfaces as IN_PROGRESS", async () => {
    const transport = new MockTransport([
      {
        status: 200,
        body: {
          media_key: MEDIA_KEY,
          attachment_id: null,
          status: "reserved",
          replayed: false,
        },
      },
    ]);
    await expect(createClient(transport).getMediaByKey(MEDIA_KEY)).rejects.toMatchObject({ code: "IN_PROGRESS" });
  });

  it("response validation: exactly the strict creation fields, types and values are accepted", async () => {
    const malformed: unknown[] = [
      {
        media_key: MEDIA_KEY,
        attachment_id: 41,
        status: "attachment",
        replayed: false,
        extra: 1,
      },
      { media_key: MEDIA_KEY, attachment_id: 41, status: "attachment" },
      {
        media_key: MEDIA_KEY,
        attachment_id: 41,
        status: "attachment",
        replayed: "yes",
      },
      {
        media_key: MEDIA_KEY,
        attachment_id: 0,
        status: "attachment",
        replayed: false,
      },
      {
        media_key: MEDIA_KEY,
        attachment_id: "41",
        status: "attachment",
        replayed: false,
      },
      {
        media_key: "not-a-key",
        attachment_id: 41,
        status: "attachment",
        replayed: false,
      },
      {
        media_key: MEDIA_KEY,
        attachment_id: 41,
        status: "video",
        replayed: false,
      },
      [],
      null,
      "oops",
    ];
    for (const body of malformed) {
      const transport = new MockTransport([{ status: 201, body }]);
      await expect(
        createClient(transport).uploadMedia({
          mediaKey: MEDIA_KEY,
          filename: FILENAME,
          mimeType: MIME,
          body: KAT_BODY,
        }),
      ).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
    }
  });

  it("reconciliation: an uncertain POST recovers success via a signed GET on the same key", async () => {
    const transport = new MockTransport(["throw-unavailable", attachment()]);
    const result = await createClient(transport).uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result).toEqual({
      mediaKey: MEDIA_KEY,
      attachmentId: 41,
      status: "attachment",
      outcome: "RECOVERED",
    });
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requestAt(transport, 1).headers["X-Newsroom-Media-Signature"]).toBe("d8f7a00fd0a1121e25dad834884e8bb90f15aae170e301d079573d19b6299238");
  });

  it("reconciliation: a dropped POST followed by a definite 404 retries the POST exactly once with a fresh timestamp and identical payload", async () => {
    const timestamps = [FIXED_NOW, FIXED_NOW, FIXED_NOW + 1000];
    let index = 0;
    const steppedNow = (): number => timestamps[Math.min(index++, timestamps.length - 1)] ?? FIXED_NOW;
    const transport = new MockTransport(["throw-unavailable", { status: 404, body: {} }, created()]);
    const result = await createClient(transport, {}, steppedNow).uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result.outcome).toBe("CREATED");
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
    const first = requestAt(transport, 0);
    const second = requestAt(transport, 2);
    expect(second.body).toBe(first.body);
    expect(second.headers["X-Newsroom-Media-Key"]).toBe(first.headers["X-Newsroom-Media-Key"]);
    expect(second.headers["X-Newsroom-Media-Filename"]).toBe(first.headers["X-Newsroom-Media-Filename"]);
    expect(second.headers["X-Newsroom-Media-Mime"]).toBe(first.headers["X-Newsroom-Media-Mime"]);
    expect(second.headers["X-Newsroom-Media-Timestamp"]).toBe("1750000001");
    expect(second.headers["X-Newsroom-Media-Signature"]).not.toBe(first.headers["X-Newsroom-Media-Signature"]);
  });

  it("reconciliation: an uncertain POST followed by an uncertain GET never triggers a blind second POST", async () => {
    const transport = new MockTransport(["throw-unavailable", "throw-unavailable", "throw-unavailable", "throw-unavailable"]);
    await expect(
      createClient(transport).uploadMedia({
        mediaKey: MEDIA_KEY,
        filename: FILENAME,
        mimeType: MIME,
        body: KAT_BODY,
      }),
    ).rejects.toMatchObject({ code: "UNCERTAIN_OUTCOME" });
    expect(transport.requests.map((request) => request.method).filter((method) => method === "POST")).toHaveLength(1);
    expect(transport.requests.map((request) => request.method).filter((method) => method === "GET")).toHaveLength(3);
  });

  it("reconciliation: a GET failure that is a definite IN_PROGRESS is not retried", async () => {
    const transport = new MockTransport(["throw-unavailable", { status: 503, body: {} }]);
    await expect(
      createClient(transport).uploadMedia({
        mediaKey: MEDIA_KEY,
        filename: FILENAME,
        mimeType: MIME,
        body: KAT_BODY,
      }),
    ).rejects.toMatchObject({ code: "IN_PROGRESS" });
    expect(transport.requests).toHaveLength(2);
  });

  it("reconciliation: a GET-backed reserved row is POSTed to only once more", async () => {
    const transport = new MockTransport([
      "throw-unavailable",
      {
        status: 200,
        body: {
          media_key: MEDIA_KEY,
          attachment_id: null,
          status: "reserved",
          replayed: false,
        },
      },
      replayed(),
    ]);
    const result = await createClient(transport).uploadMedia({
      mediaKey: MEDIA_KEY,
      filename: FILENAME,
      mimeType: MIME,
      body: KAT_BODY,
    });
    expect(result.outcome).toBe("REPLAYED");
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("errors: never include the secret or credential material in messages", async () => {
    const transport = new MockTransport([{ status: 401, body: {} }]);
    const error = await createClient(transport)
      .uploadMedia({
        mediaKey: MEDIA_KEY,
        filename: FILENAME,
        mimeType: MIME,
        body: KAT_BODY,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WordPressMediaError);
    const message = (error as Error).message;
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("BwcH");
  });

  it("configuration: invalid base URL, key id or numeric bounds are rejected at construction", () => {
    const transport = new MockTransport([]);
    expect(() => createClient(transport, { baseUrl: "ftp://site" })).toThrow();
    expect(
      () =>
        new WordPressMediaClient(
          {
            baseUrl: BASE_URL,
            keyId: "Not Valid!",
            secret: SECRET,
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
            reconciliationAttempts: 3,
            reconciliationDelayMs: 0,
            maxBytes: MAX_BYTES,
          },
          transport,
          () => FIXED_NOW,
        ),
    ).toThrow();
    expect(
      () =>
        new WordPressMediaClient(
          {
            baseUrl: BASE_URL,
            keyId: KEY_ID,
            secret: "not-a-secret",
            requestTimeoutMs: 0,
            reconciliationAttempts: 3,
            reconciliationDelayMs: 0,
            maxBytes: MAX_BYTES,
          },
          transport,
          () => FIXED_NOW,
        ),
    ).toThrow();
  });

  it("GET: the signed GET uses the media lookup route for the exact key", () => {
    const transport = new MockTransport([attachment()]);
    void createClient(transport).getMediaByKey(MEDIA_KEY);
    expect(mediaKeyIn(requestAt(transport, 0).url)).toBe(true);
  });
});
