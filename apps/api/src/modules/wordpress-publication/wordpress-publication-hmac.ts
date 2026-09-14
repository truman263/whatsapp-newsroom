import { createHash, createHmac } from "node:crypto";

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PUBLICATION_HMAC_VERSION = "newsroom-publish-hmac-v1";

export function decodePublicationSecret(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Invalid WordPress publication HMAC configuration.");
  const value = Buffer.from(encoded, "base64url");
  if (value.length !== 32 || value.toString("base64url") !== encoded) throw new Error("Invalid WordPress publication HMAC configuration.");
  return value;
}
export function assertPublicationRoute(method: "GET" | "POST", route: string): void {
  if ((method === "POST" && route === "/newsroom/v1/publications") || (method === "GET" && /^\/newsroom\/v1\/publications\/[0-9a-f-]{36}$/.test(route) && UUID.test(route.slice(-36)))) return;
  throw new Error("Unapproved WordPress publication route.");
}
export function publicationCanonical(input: { keyId: string; method: "GET" | "POST"; route: string; timestamp: number; rawBody: string }): string {
  assertPublicationRoute(input.method, input.route);
  if (!KEY_ID.test(input.keyId) || !Number.isSafeInteger(input.timestamp) || input.timestamp < 0 || (input.method === "GET" && input.rawBody !== "")) throw new Error("Invalid WordPress publication HMAC input.");
  return [PUBLICATION_HMAC_VERSION, input.keyId, input.method, input.route, String(input.timestamp), createHash("sha256").update(input.rawBody, "utf8").digest("hex")].join("\n");
}
export function signPublicationRequest(input: { keyId: string; secret: Buffer; method: "GET" | "POST"; route: string; timestamp: number; rawBody: string }): Readonly<Record<string, string>> {
  if (input.secret.length !== 32) throw new Error("Invalid WordPress publication HMAC input.");
  const signature = createHmac("sha256", input.secret).update(publicationCanonical(input), "utf8").digest("base64url");
  return { "X-Newsroom-Publish-Auth-Version": PUBLICATION_HMAC_VERSION, "X-Newsroom-Publish-Key-Id": input.keyId, "X-Newsroom-Publish-Timestamp": String(input.timestamp), "X-Newsroom-Publish-Signature": signature };
}
