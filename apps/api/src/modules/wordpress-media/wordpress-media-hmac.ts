import { createHash, createHmac } from 'node:crypto';

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREATE_ROUTE = '/newsroom-media/v1/media';
const MEDIA_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GET_ROUTE = /^\/newsroom-media\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export interface NewsroomMediaHeaders {
  'X-Newsroom-Media-Auth-Version': '1';
  'X-Newsroom-Media-Key-Id': string;
  'X-Newsroom-Media-Timestamp': string;
  'X-Newsroom-Media-Signature': string;
  'X-Newsroom-Media-Key': string;
  'X-Newsroom-Media-Filename': string;
  'X-Newsroom-Media-Mime': string;
}

export function decodeMediaHmacSecret(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('Invalid WordPress media HMAC configuration.');
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== encoded) throw new Error('Invalid WordPress media HMAC configuration.');
  return decoded;
}

export function assertApprovedMediaRoute(method: string, route: string): void {
  if (!((method === 'POST' && route === CREATE_ROUTE) || (method === 'GET' && GET_ROUTE.test(route)))) {
    throw new Error('Unsupported WordPress newsroom media operation.');
  }
}

export function mediaKeyIsValid(value: string): boolean {
  return MEDIA_KEY.test(value);
}

export function mediaMimeIsValid(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, value);
}

export function mediaExtensionFor(mime: string): string {
  return MIME_EXTENSIONS[mime] as string;
}

/**
 * Canonical media HMAC v1:
 *
 *   newsroom-media-hmac-v1
 *   {key_id}
 *   {METHOD}
 *   {concrete_route}
 *   {timestamp}
 *   {media_key}
 *   {sha256(filename) | '-'}
 *   {claimed_mime | '-'}
 *   {sha256(exact_raw_body)}
 *
 * Nine LF-separated fields, no trailing LF.
 */
export function mediaCanonical(input: {
  keyId: string; method: 'GET' | 'POST'; route: string; timestamp: string; mediaKey: string; filename: string | null; mime: string | null; body: Buffer;
}): string {
  assertApprovedMediaRoute(input.method, input.route);
  const method = input.method;
  const filenameHash = method === 'GET' ? '-' : createHash('sha256').update(Buffer.from(input.filename ?? '', 'utf8')).digest('hex');
  const mimeValue = method === 'GET' ? '-' : (input.mime ?? '');
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return ['newsroom-media-hmac-v1', input.keyId, method, input.route, input.timestamp, input.mediaKey, filenameHash, mimeValue, bodyHash].join('\n');
}

export function signNewsroomMediaRequest(input: {
  keyId: string; method: 'GET' | 'POST'; route: string; timestamp: string; mediaKey: string; filename: string | null; mime: string | null; body: Buffer; secret: Buffer;
}): NewsroomMediaHeaders {
  assertApprovedMediaRoute(input.method, input.route);
  if (!KEY_ID.test(input.keyId) || !/^[0-9]{10,12}$/.test(input.timestamp)) throw new Error('Invalid WordPress media HMAC configuration.');
  if (input.method === 'GET') {
    if (input.body.length !== 0 || input.filename !== null || input.mime !== null) throw new Error('Signed newsroom media GET must carry an empty body and no filename/MIME.');
  } else if (!mediaKeyIsValid(input.mediaKey) || !mediaMimeIsValid(input.mime ?? '')) {
    throw new Error('Invalid WordPress media HMAC configuration.');
  }
  const canonical = mediaCanonical({ keyId: input.keyId, method: input.method, route: input.route, timestamp: input.timestamp, mediaKey: input.mediaKey, filename: input.filename, mime: input.mime, body: input.body });
  return {
    'X-Newsroom-Media-Auth-Version': '1',
    'X-Newsroom-Media-Key-Id': input.keyId,
    'X-Newsroom-Media-Timestamp': input.timestamp,
    'X-Newsroom-Media-Signature': createHmac('sha256', input.secret).update(canonical).digest('hex'),
    'X-Newsroom-Media-Key': input.mediaKey,
    'X-Newsroom-Media-Filename': input.filename ?? '',
    'X-Newsroom-Media-Mime': input.mime ?? '',
  };
}