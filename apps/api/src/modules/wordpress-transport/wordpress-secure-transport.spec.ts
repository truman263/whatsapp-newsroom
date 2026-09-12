import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { SecureWordPressTransport, WORDPRESS_RESPONSE_MAX_BYTES, WordPressTransportSecurityError, isPublicAddress, normalizeWordPressBaseUrl, type WordPressHttpsRequester, type WordPressResolver } from "./wordpress-secure-transport";

type Harness = {
  requester: WordPressHttpsRequester;
  options: RequestOptions[];
  bodies: Buffer[];
  timeout?: () => void;
};

function harness(status = 200, responseBody = "{}", respond = true): Harness {
  const options: RequestOptions[] = [];
  const bodies: Buffer[] = [];
  const result: Harness = {
    options,
    bodies,
    requester: (requestOptions, callback) => {
      options.push(requestOptions);
      const request = new PassThrough() as unknown as ClientRequest;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.setTimeout = (_milliseconds: number, listener?: () => void): ClientRequest => {
        result.timeout = listener;
        return request;
      };
      request.destroy = (error?: Error): ClientRequest => {
        if (error) request.emit("error", error);
        return request;
      };
      const originalEnd = request.end.bind(request);
      request.end = ((...args: unknown[]) => {
        const ended = originalEnd(...(args as Parameters<ClientRequest["end"]>));
        bodies.push(Buffer.concat(chunks));
        if (respond) {
          const response = new PassThrough() as PassThrough & IncomingMessage;
          response.statusCode = status;
          callback(response);
          response.end(responseBody);
        }
        return ended;
      }) as ClientRequest["end"];
      return request;
    },
  };
  return result;
}

describe("SecureWordPressTransport origin and address policy", () => {
  it("accepts only HTTPS base origins without credentials, query, or fragment", () => {
    expect(normalizeWordPressBaseUrl("https://wordpress.example/wp/").toString()).toBe("https://wordpress.example/wp");
    for (const url of ["http://wordpress.example", "ftp://wordpress.example", "https://u:p@wordpress.example", "https://wordpress.example/?x=1", "https://wordpress.example/#x"]) {
      expect(() => normalizeWordPressBaseUrl(url)).toThrow();
    }
  });

  it.each([
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["0.1.2.3", false],
    ["10.0.0.1", false],
    ["100.64.0.1", false],
    ["127.0.0.1", false],
    ["169.254.1.1", false],
    ["172.16.0.1", false],
    ["192.0.0.1", false],
    ["192.0.2.1", false],
    ["192.168.1.1", false],
    ["198.18.0.1", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["224.0.0.1", false],
    ["240.0.0.1", false],
    ["2606:4700:4700::1111", true],
    ["::", false],
    ["::1", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["ff00::1", false],
    ["2001:db8::1", false],
    ["::ffff:10.0.0.1", false],
    ["bad", false],
  ])("classifies %s as public=%s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("fails closed before connecting for empty, mixed, malformed, and family-mismatched DNS answers", async () => {
    const cases: Array<ReadonlyArray<{ address: string; family: 4 | 6 }>> = [
      [],
      [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      [{ address: "bad", family: 4 }],
      [{ address: "8.8.8.8", family: 6 }],
    ];
    for (const records of cases) {
      const io = harness();
      const transport = new SecureWordPressTransport(() => Promise.resolve(records), undefined, io.requester);
      await expect(
        transport.send({
          method: "GET",
          url: "https://wordpress.example/state",
          headers: {},
          timeoutMs: 50,
        }),
      ).rejects.toBeInstanceOf(WordPressTransportSecurityError);
      expect(io.options).toHaveLength(0);
    }
  });

  it("fails closed before connecting when resolution throws", async () => {
    const io = harness(200, "{}", false);
    const transport = new SecureWordPressTransport(() => Promise.reject(new Error("DNS detail")), undefined, io.requester);
    await expect(
      transport.send({
        method: "GET",
        url: "https://wordpress.example/state",
        headers: {},
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(WordPressTransportSecurityError);
    expect(io.options).toHaveLength(0);
  });
});

describe("SecureWordPressTransport pinned TLS request", () => {
  it("resolves once, pins the approved address, and preserves SNI, Host, TLS verification, and exact bytes", async () => {
    let calls = 0;
    const resolver: WordPressResolver = () => Promise.resolve(++calls === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const io = harness(200, '{"ok":true}');
    const transport = new SecureWordPressTransport(resolver, undefined, io.requester);
    const body = Buffer.from("exact\u2028bytes", "utf8");
    await expect(
      transport.send({
        method: "PUT",
        url: "https://wordpress.example:8443/wp-json/state",
        headers: { "X-Signature": "signed" },
        body,
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });
    const options = io.options[0]!;
    expect(calls).toBe(1);
    expect(options.hostname).toBe("wordpress.example");
    expect(options.servername).toBe("wordpress.example");
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toMatchObject({
      Host: "wordpress.example:8443",
      "X-Signature": "signed",
    });
    expect(io.bodies[0]).toEqual(body);
    const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      (options.lookup as NonNullable<RequestOptions["lookup"]>)("wordpress.example", {}, (error, address, family) =>
        error
          ? reject(error)
          : resolve({
              address: address as string,
              family: family as number,
            }),
      );
    });
    expect(pinned).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it.each([301, 302, 307, 308])("returns redirect %s without a follow-up or HMAC forwarding", async (status) => {
    const io = harness(status, "");
    const transport = new SecureWordPressTransport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), undefined, io.requester);
    await expect(
      transport.send({
        method: "GET",
        url: "https://wordpress.example/state",
        headers: { "X-Signature": "signed" },
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ status, body: null });
    expect(io.options).toHaveLength(1);
    expect(io.bodies[0]).toEqual(Buffer.alloc(0));
  });

  it("accepts a maximum-size Story body whose escaped draft-state JSON exceeds the former 256 KiB ceiling", async () => {
    const content = "\u0001".repeat(100_000);
    const responseBody = JSON.stringify({
      draft_key: "550e8400-e29b-41d4-a716-446655440000",
      post_id: 42,
      status: "draft",
      title: "Maximum escaped body",
      content,
      excerpt: "",
      categories: [1, 2],
      editorial_byline: "Reporter Example",
      featured_media_key: null,
      author_id: 2,
      applied_version: "a".repeat(64),
    });
    const serializedBytes = Buffer.byteLength(responseBody, "utf8");
    expect(serializedBytes).toBeGreaterThan(256 * 1024);
    expect(serializedBytes).toBeLessThan(WORDPRESS_RESPONSE_MAX_BYTES);
    const io = harness(200, responseBody);
    const transport = new SecureWordPressTransport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), undefined, io.requester);
    const result = await transport.send({ method: "GET", url: "https://wordpress.example/state", headers: {}, timeoutMs: 50 });
    expect((result.body as { content: string }).content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(result.body), "utf8")).toBe(serializedBytes);
  });

  it("accepts an ordinary JSON control response above 256 KiB", async () => {
    const responseBody = JSON.stringify({ padding: "x".repeat(300 * 1024) });
    const io = harness(200, responseBody);
    const transport = new SecureWordPressTransport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), undefined, io.requester);
    const result = await transport.send({ method: "GET", url: "https://wordpress.example/state", headers: {}, timeoutMs: 50 });
    expect((result.body as { padding: string }).padding).toHaveLength(300 * 1024);
  });

  it("fails closed when a response exceeds 1 MiB", async () => {
    const io = harness(200, JSON.stringify({ padding: "x".repeat(WORDPRESS_RESPONSE_MAX_BYTES) }));
    const transport = new SecureWordPressTransport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), undefined, io.requester);
    await expect(
      transport.send({
        method: "GET",
        url: "https://wordpress.example/state",
        headers: {},
        timeoutMs: 50,
      }),
    ).rejects.toThrow("exceeded limit");
  });

  it("arms and enforces the request timeout", async () => {
    const io = harness(200, "{}", false);
    const transport = new SecureWordPressTransport(() => Promise.resolve([{ address: "8.8.8.8", family: 4 }]), undefined, io.requester);
    const pending = transport.send({
      method: "GET",
      url: "https://wordpress.example/state",
      headers: {},
      timeoutMs: 50,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(io.timeout).toBeDefined();
    io.timeout!();
    await expect(pending).rejects.toThrow("timed out");
  });
});
