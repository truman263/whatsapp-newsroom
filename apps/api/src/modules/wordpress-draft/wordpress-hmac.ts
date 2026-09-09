import { createHash, createHmac } from 'node:crypto';

const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREATE_ROUTE = '/newsroom/v1/drafts';
const GET_ROUTE = /^\/newsroom\/v1\/drafts\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface NewsroomHmacHeaders {
  'X-Newsroom-Auth-Version': '1';
  'X-Newsroom-Key-Id': string;
  'X-Newsroom-Timestamp': string;
  'X-Newsroom-Signature': string;
}

export function decodeDraftHmacSecret(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('Invalid WordPress draft HMAC configuration.');
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== encoded) throw new Error('Invalid WordPress draft HMAC configuration.');
  return decoded;
}

export function assertApprovedRoute(method: string, route: string): void {
  if (!((method === 'POST' && route === CREATE_ROUTE) || ((method === 'GET' || method === 'PUT') && GET_ROUTE.test(route)) || (method === 'GET' && route.endsWith('/state') && GET_ROUTE.test(route.slice(0, -6))))) {
    throw new Error('Unsupported WordPress newsroom operation.');
  }
}

export function signNewsroomRequest(input: {
  method: 'GET' | 'POST' | 'PUT'; route: string; rawBody: string; keyId: string; secret: Buffer; timestamp: number;
}): NewsroomHmacHeaders {
  assertApprovedRoute(input.method, input.route);
  if (!KEY_ID.test(input.keyId) || !Number.isSafeInteger(input.timestamp) || input.timestamp < 0) throw new Error('Invalid WordPress draft HMAC configuration.');
  if (input.method === 'GET' && input.rawBody !== '') throw new Error('Signed newsroom GET must have an empty body.');
  const timestamp = String(input.timestamp);
  const canonical = ['newsroom-hmac-v1', input.keyId, input.method, input.route, timestamp, createHash('sha256').update(input.rawBody).digest('hex')].join('\n');
  return {
    'X-Newsroom-Auth-Version': '1',
    'X-Newsroom-Key-Id': input.keyId,
    'X-Newsroom-Timestamp': timestamp,
    'X-Newsroom-Signature': createHmac('sha256', input.secret).update(canonical).digest('hex'),
  };
}
