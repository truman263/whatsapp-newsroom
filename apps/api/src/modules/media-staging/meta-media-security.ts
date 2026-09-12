import { isIP } from "node:net";

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return (
    (((parts[0]! << 24) >>> 0) +
      (parts[1]! << 16) +
      (parts[2]! << 8) +
      parts[3]!) >>>
    0
  );
}

function inV4(address: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const value = ipv4Number(address)!;
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) =>
      inV4(value, ipv4Number(base)!, prefix),
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("ff")
    )
      return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    return mapped ? isPublicAddress(mapped[1]!) : true;
  }
  return false;
}

export function approvedMetaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    host === "graph.facebook.com" ||
    host === "lookaside.fbsbx.com" ||
    host === "scontent.whatsapp.net" ||
    host.endsWith(".fbcdn.net")
  );
}

export function validateMediaUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname ||
    !approvedMetaHost(url.hostname)
  )
    throw new Error("MEDIA_URL_REJECTED");
  if (
    url.hostname === "localhost" ||
    (isIP(url.hostname) !== 0 && !isPublicAddress(url.hostname))
  )
    throw new Error("MEDIA_URL_REJECTED");
  return url;
}
