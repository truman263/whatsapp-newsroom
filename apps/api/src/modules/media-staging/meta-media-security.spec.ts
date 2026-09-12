import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import {
  collectBounded,
  MetaMediaClient,
  type MetaResolver,
  type MetaTransport,
  type PinnedResponse,
} from "./meta-media.client";
import {
  approvedMetaHost,
  isPublicAddress,
  validateMediaUrl,
} from "./meta-media-security";
import type { MediaAuthority } from "./media-staging.types";

const TEST_TOKEN = "closure-a-token-never-log";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const AUTHORITY: MediaAuthority = {
  providerMediaId: "closure-a-media",
  mimeType: "image/jpeg",
};

function stream(
  chunks: readonly Uint8Array[],
  error?: Error,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      await Promise.resolve();
      for (const chunk of chunks) yield chunk;
      if (error) throw error;
    },
  };
}

function response(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  headers: Record<string, string | undefined> = {},
  status = 200,
): PinnedResponse {
  return {
    status,
    headers,
    body: body instanceof Uint8Array ? stream([body]) : body,
  };
}

function metadata(
  changes: Partial<{
    id: string;
    url: string;
    mime_type: string;
    file_size: number;
    sha256: string;
  }> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: AUTHORITY.providerMediaId,
      url: "https://lookaside.fbsbx.com/closure-a-source",
      mime_type: "image/jpeg",
      file_size: JPEG.length,
      ...changes,
    }),
  );
}

class FixtureResolver implements MetaResolver {
  readonly calls: string[] = [];
  constructor(private readonly addresses: Record<string, string[]> = {}) {}

  resolve(hostname: string): Promise<string[]> {
    this.calls.push(hostname);
    return Promise.resolve(this.addresses[hostname] ?? ["8.8.8.8"]);
  }
}

class FixtureTransport implements MetaTransport {
  readonly calls: Array<{
    url: string;
    address: string;
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
  }> = [];
  constructor(private readonly replies: PinnedResponse[]) {}

  request(
    url: URL,
    address: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<PinnedResponse> {
    this.calls.push({ url: url.toString(), address, headers, timeoutMs });
    const reply = this.replies.shift();
    if (!reply) throw new Error("unexpected transport request");
    return Promise.resolve(reply);
  }
}

function client(
  replies: PinnedResponse[],
  resolver: MetaResolver = new FixtureResolver(),
  maxBytes = JPEG.length,
): { client: MetaMediaClient; transport: FixtureTransport; resolver: FixtureResolver } {
  const transport = new FixtureTransport(replies);
  const config = {
    getOrThrow<T>(key: string): T {
      const values: Record<string, unknown> = {
        "whatsapp.accessToken": TEST_TOKEN,
        "mediaStaging.maxBytes": maxBytes,
        "mediaStaging.requestTimeoutMs": 4321,
      };
      return values[key] as T;
    },
  } as ConfigService;
  return {
    client: new MetaMediaClient(transport, resolver, config),
    transport,
    resolver: resolver as FixtureResolver,
  };
}

describe("Meta media SSRF policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "240.0.0.1",
    "224.0.0.1",
    "239.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe90::1",
    "fea0::1",
    "febf::ffff",
    "fc00::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
    "::ffff:100.64.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it.each([
    "http://lookaside.fbsbx.com/file",
    "https://user:pass@lookaside.fbsbx.com/file",
    "https://localhost/file",
    "https://127.0.0.1/file",
    "https://lookaside.fbsbx.com.evil.example/file",
    "https://evilfacebook.com/file",
    "https://facebook.com.evil.example/file",
    "https://lookaside.fbsbx.com:444/file",
    "https://facebook.com.attacker.example/file",
    "https://facebook.com.evil/file",
    "https://lookaside.fbsbx.com@evil.example/file",
    "https://evil.example#@lookaside.fbsbx.com/file",
    "https://cdn.fbcxdn.net/file",
    "not a URL",
  ])("rejects untrusted URL %s", (url) => {
    expect(() => validateMediaUrl(url)).toThrow();
  });

  it("uses exact hostname boundaries", () => {
    expect(approvedMetaHost("lookaside.fbsbx.com")).toBe(true);
    expect(approvedMetaHost("cdn.fbcdn.net")).toBe(true);
    expect(approvedMetaHost("fbcdn.net.evil.test")).toBe(false);
  });
});

describe("MetaMediaClient pinned network and media evidence", () => {
  it("pins the validated address instead of performing an ordinary second lookup", async () => {
    const resolver = new FixtureResolver({
      "graph.facebook.com": ["8.8.8.8"],
      "lookaside.fbsbx.com": ["1.1.1.1"],
    });
    const fixture = client(
      [
        response(metadata()),
        response(JPEG, {
          "content-type": "image/jpeg",
          "content-length": String(JPEG.length),
        }),
      ],
      resolver,
    );

    await expect(fixture.client.fetch(AUTHORITY)).resolves.toMatchObject({
      bytes: JPEG,
      size: JPEG.length,
      sha256: createHash("sha256").update(JPEG).digest("hex"),
    });
    expect(fixture.transport.calls.map(({ address }) => address)).toEqual([
      "8.8.8.8",
      "1.1.1.1",
    ]);
    expect(fixture.resolver.calls).toEqual([
      "graph.facebook.com",
      "lookaside.fbsbx.com",
    ]);
    expect(fixture.transport.calls.every(({ timeoutMs }) => timeoutMs === 4321)).toBe(true);
  });

  it("proves DNS-rebinding resistance: the single validated address is used and never re-resolved", async () => {
    let lookasideResolves = 0;
    const rebinding: MetaResolver = {
      resolve(hostname: string): Promise<string[]> {
        if (hostname === "lookaside.fbsbx.com") {
          lookasideResolves += 1;
          return Promise.resolve(
            lookasideResolves === 1 ? ["1.1.1.1"] : ["127.0.0.1"],
          );
        }
        return Promise.resolve(["8.8.8.8"]);
      },
    };
    const fixture = client(
      [
        response(metadata()),
        response(JPEG, {
          "content-type": "image/jpeg",
          "content-length": String(JPEG.length),
        }),
      ],
      rebinding,
    );
    await expect(fixture.client.fetch(AUTHORITY)).resolves.toMatchObject({
      size: JPEG.length,
    });
    expect(lookasideResolves).toBe(1);
    expect(fixture.transport.calls.map(({ address }) => address)).toEqual([
      "8.8.8.8",
      "1.1.1.1",
    ]);
    expect(JSON.stringify(fixture.transport.calls)).not.toContain("127.0.0.1");
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])("rejects a forbidden resolved address before transport: %s", async (address) => {
    const fixture = client([], new FixtureResolver({ "graph.facebook.com": [address] }));
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({
      code: "MEDIA_URL_REJECTED",
    });
    expect(fixture.transport.calls).toEqual([]);
  });

  it("revalidates every approved redirect and keeps the provider token inside approved hosts", async () => {
    const fixture = client([
      response(metadata()),
      response(Buffer.alloc(0), { location: "https://scontent.whatsapp.net/redirected" }, 302),
      response(JPEG, {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).resolves.toMatchObject({ size: 4 });
    expect(fixture.transport.calls).toHaveLength(3);
    expect(fixture.resolver.calls).toEqual([
      "graph.facebook.com",
      "lookaside.fbsbx.com",
      "scontent.whatsapp.net",
    ]);
    for (const call of fixture.transport.calls)
      expect(call.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it.each([
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://localhost/private",
    "https://attacker.example/private",
    "https://user:pass@lookaside.fbsbx.com/private",
  ])("rejects an unsafe redirect before a token can be forwarded: %s", async (location) => {
    const fixture = client([
      response(metadata()),
      response(Buffer.alloc(0), { location }, 302),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({
      code: "MEDIA_URL_REJECTED",
    });
    expect(fixture.transport.calls).toHaveLength(2);
    expect(JSON.stringify(fixture.transport.calls)).not.toContain(location);
    expect(fixture.transport.calls.at(-1)?.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("rejects an approved redirect when its fresh resolution is private", async () => {
    const fixture = client(
      [
        response(metadata()),
        response(Buffer.alloc(0), { location: "https://scontent.whatsapp.net/private-dns" }, 302),
      ],
      new FixtureResolver({ "scontent.whatsapp.net": ["10.0.0.8"] }),
    );
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({
      code: "MEDIA_URL_REJECTED",
    });
    expect(fixture.transport.calls).toHaveLength(2);
    expect(fixture.resolver.calls).toContain("scontent.whatsapp.net");
  });

  it("rejects redirect loops and bounded redirect overflow", async () => {
    const fixture = client([
      response(metadata()),
      response(Buffer.alloc(0), { location: "https://lookaside.fbsbx.com/a" }, 302),
      response(Buffer.alloc(0), { location: "https://lookaside.fbsbx.com/b" }, 302),
      response(Buffer.alloc(0), { location: "https://lookaside.fbsbx.com/c" }, 302),
      response(Buffer.alloc(0), { location: "https://lookaside.fbsbx.com/d" }, 302),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({
      code: "MEDIA_REDIRECT_REJECTED",
    });
    expect(fixture.transport.calls).toHaveLength(5);
  });

  it("uses bounded collection for exact limits, overflow, and stream failure", async () => {
    await expect(collectBounded(stream([Buffer.from("x")]), 1)).resolves.toEqual(Buffer.from("x"));
    await expect(collectBounded(stream([Buffer.from("ab"), Buffer.from("cd")]), 4)).resolves.toEqual(Buffer.from("abcd"));
    await expect(collectBounded(stream([Buffer.from("abc"), Buffer.from("de")]), 4)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    await expect(collectBounded(stream([Buffer.from("a")], new Error("aborted")), 4)).rejects.toMatchObject({ code: "MEDIA_PROVIDER_UNAVAILABLE" });
  });

  it.each([
    ["within a declared exact Content-Length", String(JPEG.length), JPEG, JPEG.length, undefined],
    ["without Content-Length", undefined, JPEG, JPEG.length, undefined],
    ["with a content length over the ceiling", "5", JPEG, JPEG.length, "MEDIA_TOO_LARGE"],
    ["with a lying short content length", "3", JPEG, JPEG.length, "MEDIA_SIZE_MISMATCH"],
    ["with an invalid Content-Length", "not-a-number", JPEG, JPEG.length, "MEDIA_SIZE_INVALID"],
    ["with an empty stream", "0", Buffer.alloc(0), 0, "MEDIA_SIZE_INVALID"],
  ] as const)("handles download %s", async (_name, contentLength, body, size, error) => {
    const headers: Record<string, string | undefined> = { "content-type": "image/jpeg" };
    if (contentLength !== undefined) headers["content-length"] = contentLength;
    const fixture = client([response(metadata({ file_size: size || JPEG.length })), response(body, headers)]);
    const result = fixture.client.fetch(AUTHORITY);
    if (error) await expect(result).rejects.toMatchObject({ code: error });
    else await expect(result).resolves.toMatchObject({ size, sha256: createHash("sha256").update(body).digest("hex") });
  });

  it("rejects actual overflow even where Content-Length claims compliance", async () => {
    const fixture = client([
      response(metadata()),
      response(stream([JPEG, Buffer.from([0])]), {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("bounds the stream byte count when Content-Length is absent", async () => {
    const fixture = client([
      response(metadata()),
      response(stream([JPEG, Buffer.from([0])]), {
        "content-type": "image/jpeg",
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("rejects an over-ceiling Content-Length before the body is consumed", async () => {
    let iterated = false;
    const neverRead: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        iterated = true;
        yield JPEG;
        await Promise.resolve();
      },
    };
    const fixture = client([
      response(metadata()),
      response(neverRead, {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length + 1),
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    expect(iterated).toBe(false);
  });

  it("rejects a broken stream mid-body as provider-unavailable", async () => {
    const fixture = client([
      response(metadata()),
      response(stream([JPEG], new Error("socket prematurely closed")), {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_PROVIDER_UNAVAILABLE" });
  });

  it("rejects a zero-byte body even without a Content-Length header", async () => {
    const fixture = client([
      response(metadata()),
      response(Buffer.alloc(0), { "content-type": "image/jpeg" }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_SIZE_INVALID" });
  });

  it("bounds the metadata response to 64 KiB", async () => {
    const fixture = client([
      response(stream([Buffer.alloc(64 * 1024), Buffer.from([0])]), {
        "content-type": "application/json",
      }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it.each([
    ["correct", createHash("sha256").update(JPEG).digest("base64"), undefined],
    ["wrong", Buffer.alloc(32, 1).toString("base64"), "MEDIA_HASH_MISMATCH"],
    ["absent", undefined, undefined],
  ] as const)("verifies provider SHA evidence when %s", async (_name, providerSha256, error) => {
    const fixture = client([
      response(metadata(providerSha256 ? { sha256: providerSha256 } : {})),
      response(JPEG, {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ]);
    const result = fixture.client.fetch({
      ...AUTHORITY,
      ...(providerSha256 ? { providerSha256 } : {}),
    });
    if (error) await expect(result).rejects.toMatchObject({ code: error });
    else await expect(result).resolves.toMatchObject({ sha256: /^[0-9a-f]{64}$/u });
  });

  it.each([
    ["smaller metadata size", JPEG.length - 1],
    ["larger metadata size", JPEG.length + 1],
  ])("rejects %s against exact staged bytes", async (_name, fileSize) => {
    const fixture = client([
      response(metadata({ file_size: fileSize })),
      response(JPEG, {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ], new FixtureResolver(), 5);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code: "MEDIA_SIZE_MISMATCH" });
  });

  it.each([
    ["metadata MIME", metadata({ mime_type: "image/png" }), "image/jpeg", "MEDIA_MIME_MISMATCH"],
    ["response MIME", metadata(), "image/png", "MEDIA_MIME_MISMATCH"],
    ["unsupported metadata MIME", metadata({ mime_type: "image/svg+xml" }), "image/jpeg", "MEDIA_PROVIDER_INVALID"],
    ["text metadata MIME", metadata({ mime_type: "text/plain" }), "image/jpeg", "MEDIA_PROVIDER_INVALID"],
    ["binary metadata MIME", metadata({ mime_type: "application/octet-stream" }), "image/jpeg", "MEDIA_PROVIDER_INVALID"],
  ] as const)("rejects %s contradictions", async (_name, meta, contentType, code) => {
    const fixture = client([
      response(meta),
      response(JPEG, { "content-type": contentType, "content-length": String(JPEG.length) }),
    ]);
    await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({ code });
  });

  it.each([undefined, "another-media-id"])(
    "requires the provider metadata ID to match the requested media ID: %s",
    async (id) => {
      const fixture = client([response(metadata({ id }))]);
      await expect(fixture.client.fetch(AUTHORITY)).rejects.toMatchObject({
        code: "MEDIA_PROVIDER_INVALID",
      });
      expect(fixture.transport.calls).toHaveLength(1);
    },
  );

  it("does not put a token, temporary URL, caption, or response bytes in failures", async () => {
    const sentinelUrl = "https://attacker.example/secret-url";
    const fixture = client([response(metadata({ url: sentinelUrl }))]);
    const authority = { ...AUTHORITY, caption: "caption-secret-never-audit" };
    try {
      await fixture.client.fetch(authority);
      throw new Error("expected media URL rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "MEDIA_URL_REJECTED" });
      const serialized = JSON.stringify(error);
      for (const secret of [TEST_TOKEN, sentinelUrl, authority.caption, "closure-a-media"])
        expect(serialized).not.toContain(secret);
    }
  });

  it("keeps tokens, temporary URLs, captions, and response bodies out of every failure surface", async () => {
    const sentinelUrl = "https://attacker.example/secret-url";
    const sentinelBody = "RAW-BODY-SENTINEL-9b1f2c";
    const sentinelCaption = "caption-secret-never-audit";
    const failingScenarios: Array<{ replies: PinnedResponse[] }> = [
      { replies: [response(metadata({ url: sentinelUrl }))] },
      {
        replies: [
          response(metadata()),
          response(Buffer.alloc(0), { location: sentinelUrl }, 302),
        ],
      },
      {
        replies: [
          response(metadata({ file_size: 999999999 })),
          response(JPEG),
        ],
      },
      {
        replies: [
          response(metadata()),
          response(stream([Buffer.from(sentinelBody)]), {
            "content-type": "image/jpeg",
            "content-length": "3",
          }),
        ],
      },
      {
        replies: [
          response(
            metadata({ sha256: Buffer.alloc(32, 1).toString("base64") }),
          ),
          response(JPEG, {
            "content-type": "image/jpeg",
            "content-length": String(JPEG.length),
          }),
        ],
      },
    ];
    for (const scenario of failingScenarios) {
      const fixture = client(scenario.replies);
      let failure: unknown;
      try {
        await fixture.client.fetch({
          ...AUTHORITY,
          caption: sentinelCaption,
        });
        failure = undefined;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(JSON.stringify(failure)).not.toContain(
        "expected a media staging failure",
      );
      const serialized =
        failure instanceof Error
          ? JSON.stringify({
              message: failure.message,
              name: failure.name,
              ...(failure as unknown as Record<string, unknown>),
            })
          : JSON.stringify(failure);
      for (const secret of [
        TEST_TOKEN,
        sentinelUrl,
        sentinelBody,
        sentinelCaption,
      ])
        expect(serialized).not.toContain(secret);
    }
  });

  it("exposes only content-safe fields to downstream persistence structures", async () => {
    const fixture = client([
      response(metadata({ url: "https://lookaside.fbsbx.com/ok-source" })),
      response(JPEG, {
        "content-type": "image/jpeg",
        "content-length": String(JPEG.length),
      }),
    ]);
    const downloaded = await fixture.client.fetch({
      ...AUTHORITY,
      caption: "sensitive-caption-never-persist",
    });
    expect(Object.keys(downloaded).sort()).toEqual([
      "bytes",
      "mimeType",
      "sha256",
      "size",
    ]);
    const serialized = JSON.stringify(downloaded);
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(serialized).not.toContain("sensitive-caption-never-persist");
    expect(serialized).not.toContain("lookaside.fbsbx.com/ok-source");
  });
});
