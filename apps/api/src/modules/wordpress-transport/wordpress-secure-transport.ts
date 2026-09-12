import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const WORDPRESS_RESPONSE_MAX_BYTES = 1024 * 1024;

export type WordPressRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string | Buffer;
  timeoutMs: number;
};

export type WordPressTransportResponse = { status: number; body: unknown };
export type WordPressResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;
export type WordPressHttpsRequester = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export class WordPressTransportSecurityError extends Error {
  constructor() {
    super("WordPress transport security policy rejected the request.");
  }
}

export function normalizeWordPressBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid WordPress base URL.");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

export class SecureWordPressTransport {
  constructor(
    private readonly resolver: WordPressResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: 4 | 6 }>>,
    private readonly maxResponseBytes = WORDPRESS_RESPONSE_MAX_BYTES,
    private readonly requester: WordPressHttpsRequester = httpsRequest,
  ) {}

  async send(request: WordPressRequest): Promise<WordPressTransportResponse> {
    const url = normalizeRequestUrl(request.url);
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const records = await resolveOnce(hostname, this.resolver);
    const selected = records[0];
    if (!selected) throw new WordPressTransportSecurityError();
    const bytes = request.body === undefined ? undefined : Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, "utf8");

    return new Promise((resolve, reject) => {
      const outgoing = this.requester(
        {
          protocol: "https:",
          hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: { ...request.headers, Host: url.host },
          servername: isIP(hostname) === 0 ? hostname : undefined,
          rejectUnauthorized: true,
          lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          let settled = false;
          response.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > this.maxResponseBytes) {
              response.destroy(new Error("WordPress response exceeded limit."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = null;
            try {
              body = text === "" ? null : JSON.parse(text);
            } catch {
              body = text;
            }
            resolve({ status: response.statusCode ?? 0, body });
          });
        },
      );
      outgoing.setTimeout(request.timeoutMs, () => outgoing.destroy(new Error("WordPress request timed out.")));
      outgoing.once("error", reject);
      if (bytes !== undefined) outgoing.write(bytes);
      outgoing.end();
    });
  }
}

async function resolveOnce(hostname: string, resolver: WordPressResolver): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  const literalFamily = isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname).catch(() => {
        throw new WordPressTransportSecurityError();
      });
  if (records.length === 0) throw new WordPressTransportSecurityError();
  for (const record of records) {
    if ((record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family || !isPublicAddress(record.address)) throw new WordPressTransportSecurityError();
  }
  return [...records].sort((a, b) => (a.family === b.family ? a.address.localeCompare(b.address) : a.family - b.family));
}

function normalizeRequestUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new WordPressTransportSecurityError();
  return url;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6Value(address);
  if (value === null) return false;
  const mappedPrefix = 0xffffn;
  if (value >> 32n === mappedPrefix) return publicIpv4([24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join("."));
  if (value >> 125n !== 1n) return false;
  const forbidden: ReadonlyArray<readonly [bigint, number]> = [
    [0n, 128],
    [1n, 128],
    [0x7en, 7],
    [0x3fan, 10],
    [0xffn, 8],
    [0x20010db8n, 32],
  ];
  return !forbidden.some(([prefix, bits]) => value >> BigInt(128 - bits) === prefix);
}

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return false;
  const value = (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
  return ![
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([network, bits]) => {
    const networkParts = (network as string).split(".").map(Number);
    const networkValue = (((networkParts[0] ?? 0) << 24) | ((networkParts[1] ?? 0) << 16) | ((networkParts[2] ?? 0) << 8) | (networkParts[3] ?? 0)) >>> 0;
    const mask = (0xffffffff << (32 - (bits as number))) >>> 0;
    return (value & mask) === (networkValue & mask);
  });
}

function ipv6Value(address: string): bigint | null {
  let source = address.toLowerCase();
  const mapped = source.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped?.[1]) {
    const parts = mapped[1].split(".").map(Number);
    source = `::ffff:${(((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16)}:${(((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}
