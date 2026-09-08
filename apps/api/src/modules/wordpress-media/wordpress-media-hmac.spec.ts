import { createHash } from 'node:crypto';
import { decodeMediaHmacSecret, mediaCanonical, signNewsroomMediaRequest } from './wordpress-media-hmac';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KAT_BODY = Buffer.concat([PNG_MAGIC, Buffer.from('FIXTURE-BYTES', 'ascii')]);
const SECRET = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const SECRET_BYTES = Buffer.from(SECRET, 'base64url');
const KEY_ID = 'media-local-v1';
const TIMESTAMP = '1750000000';
const MEDIA_KEY = '01234567-89ab-47cd-8e01-23456789abcd';
const FILENAME = 'hero.png';
const MIME = 'image/png';
const CREATE_ROUTE = '/newsroom-media/v1/media';
const GET_ROUTE = `/newsroom-media/v1/media/${MEDIA_KEY}`;

describe('wordpress-media-hmac', () => {
  describe('decodeMediaHmacSecret', () => {
    it('decodes a canonical 43-character base64url secret to a 32-byte buffer', () => {
      const decoded = decodeMediaHmacSecret(SECRET);
      expect(decoded).toEqual(SECRET_BYTES);
      expect(decoded.length).toBe(32);
    });
    it('rejects a secret that is not exactly 43 canonical base64url characters', () => {
      expect(() => decodeMediaHmacSecret(SECRET.slice(0, -1))).toThrow();
      expect(() => decodeMediaHmacSecret(`${SECRET}AAAA`)).toThrow();
      expect(() => decodeMediaHmacSecret('not!a!secret!')).toThrow();
    });
    it('rejects a secret that does not re-encode to its canonical form', () => {
      const nonCanonical = `${'A'.repeat(42)}B`;
      expect(() => decodeMediaHmacSecret(nonCanonical)).toThrow();
    });
  });

  describe('mediaCanonical', () => {
    it('builds the exact POST canonical string', () => {
      const canonical = mediaCanonical({ keyId: KEY_ID, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY });
      expect(canonical).toBe([
        'newsroom-media-hmac-v1', KEY_ID, 'POST', CREATE_ROUTE, TIMESTAMP, MEDIA_KEY,
        createHash('sha256').update(FILENAME).digest('hex'), MIME,
        createHash('sha256').update(KAT_BODY).digest('hex'),
      ].join('\n'));
    });
    it('hashes the exact UTF-8 filename bytes', () => {
      const canonical = mediaCanonical({ keyId: KEY_ID, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY });
      expect(canonical.includes(createHash('sha256').update(FILENAME).digest('hex'))).toBe(true);
    });
    it('uses placeholders for filename and MIME on GET', () => {
      const canonical = mediaCanonical({ keyId: KEY_ID, method: 'GET', route: GET_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: null, mime: null, body: Buffer.alloc(0) });
      expect(canonical).toBe([
        'newsroom-media-hmac-v1', KEY_ID, 'GET', GET_ROUTE, TIMESTAMP, MEDIA_KEY, '-', '-',
        createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      ].join('\n'));
    });
    it('hashes the empty body for the GET empty-body digest', () => {
      const canonical = mediaCanonical({ keyId: KEY_ID, method: 'GET', route: GET_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: null, mime: null, body: Buffer.alloc(0) });
      expect(canonical.endsWith(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))).toBe(true);
    });
    it('rejects an unapproved route', () => {
      expect(() => mediaCanonical({ keyId: KEY_ID, method: 'POST', route: '/newsroom-media/v1/other', timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY })).toThrow();
    });
  });

  describe('signNewsroomMediaRequest (approved KAT)', () => {
    it('produces the exact frozen POST signature and headers', () => {
      const headers = signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY });
      expect(headers).toEqual({
        'X-Newsroom-Media-Auth-Version': '1',
        'X-Newsroom-Media-Key-Id': KEY_ID,
        'X-Newsroom-Media-Timestamp': TIMESTAMP,
        'X-Newsroom-Media-Signature': '3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd',
        'X-Newsroom-Media-Key': MEDIA_KEY,
        'X-Newsroom-Media-Filename': FILENAME,
        'X-Newsroom-Media-Mime': MIME,
      });
    });
    it('produces the exact frozen GET signature and headers', () => {
      const headers = signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'GET', route: GET_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: null, mime: null, body: Buffer.alloc(0) });
      expect(headers['X-Newsroom-Media-Signature']).toBe('d8f7a00fd0a1121e25dad834884e8bb90f15aae170e301d079573d19b6299238');
      expect(headers['X-Newsroom-Media-Key']).toBe(MEDIA_KEY);
      expect(headers['X-Newsroom-Media-Filename']).toBe('');
      expect(headers['X-Newsroom-Media-Mime']).toBe('');
    });
    it('signs the raw bytes exactly as transmitted (no string conversion)', () => {
      const headers = signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY });
      expect(headers['X-Newsroom-Media-Signature']).toBe('3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd');
    });
    it('rejects an invalid key id', () => {
      expect(() => signNewsroomMediaRequest({ keyId: 'Not Valid!', secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY })).toThrow();
    });
    it('rejects a non-v4 media key', () => {
      expect(() => signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY.toUpperCase(), filename: FILENAME, mime: MIME, body: KAT_BODY })).toThrow();
    });
    it('rejects an unsupported MIME type', () => {
      expect(() => signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: 'image/svg+xml', body: KAT_BODY })).toThrow();
    });
    it('rejects a GET that carries filename or MIME', () => {
      expect(() => signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'GET', route: GET_ROUTE, timestamp: TIMESTAMP, mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: Buffer.alloc(0) })).toThrow();
    });
    it('rejects an invalid timestamp', () => {
      expect(() => signNewsroomMediaRequest({ keyId: KEY_ID, secret: SECRET_BYTES, method: 'POST', route: CREATE_ROUTE, timestamp: 'not-a-timestamp', mediaKey: MEDIA_KEY, filename: FILENAME, mime: MIME, body: KAT_BODY })).toThrow();
    });
  });
});