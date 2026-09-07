import { createHash, createHmac } from 'node:crypto';
import { assertApprovedRoute, decodeDraftHmacSecret, signNewsroomRequest } from './wordpress-hmac';

const TEST_SECRET_43A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_KEY_ID = 'test-v1';
const FIXED_TIMESTAMP = 1700000000;

const POST_BODY = JSON.stringify({ draft_key: '550e8400-e29b-41d4-a716-446655440000', title: 'Test Draft', content: 'Hello body', excerpt: 'Excerpt here', categories: [1, 2] });
const POST_BODY_SHA = '675e9e0ad9c937ce3f61dc3c73879c77c98a4c1bdab97b370bd14e6041d49db6';
const POST_SIGNATURE = 'f75f9c7e455e18e875f53ac5d984652cc6ebe0a0e8e6130e0e43e2abee9fed67';
const POST_CANONICAL = 'newsroom-hmac-v1\ntest-v1\nPOST\n/newsroom/v1/drafts\n1700000000\n675e9e0ad9c937ce3f61dc3c73879c77c98a4c1bdab97b370bd14e6041d49db6';

const GET_ROUTE = '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000';
const GET_SIGNATURE = 'e1d7fca517ad9443c1bcfb03ddc23992f347d2ce7c326c5686893c165daf4e09';

const VALID_SECRET = Buffer.from(TEST_SECRET_43A, 'base64url');

describe('wordpress-hmac', () => {
  describe('decodeDraftHmacSecret', () => {
    it('decodes a valid 43-char base64url secret to 32 bytes', () => {
      const decoded = decodeDraftHmacSecret(TEST_SECRET_43A);
      expect(decoded).toBeInstanceOf(Buffer);
      expect(decoded.length).toBe(32);
      expect(decoded.every((byte) => byte === 0)).toBe(true);
    });

    it('rejects non-43-char secrets', () => {
      expect(() => decodeDraftHmacSecret('short')).toThrow('Invalid WordPress draft HMAC configuration.');
      expect(() => decodeDraftHmacSecret('A'.repeat(42))).toThrow('Invalid WordPress draft HMAC configuration.');
      expect(() => decodeDraftHmacSecret('A'.repeat(44))).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('rejects secrets with invalid base64url characters', () => {
      expect(() => decodeDraftHmacSecret('A'.repeat(42) + '!')).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('rejects non-canonical base64url encoding', () => {
      const validDecoded = Buffer.from('A'.repeat(42) + 'A', 'base64url');
      const canonical = validDecoded.toString('base64url');
      expect(canonical).toHaveLength(43);
      const nonCanonicalLast = canonical.slice(0, -1) + 'B';
      expect(nonCanonicalLast).toHaveLength(43);
      expect(() => decodeDraftHmacSecret(nonCanonicalLast)).toThrow('Invalid WordPress draft HMAC configuration.');
    });
  });

  describe('assertApprovedRoute', () => {
    it('accepts POST /newsroom/v1/drafts', () => {
      expect(() => assertApprovedRoute('POST', '/newsroom/v1/drafts')).not.toThrow();
    });

    it('accepts GET with canonical UUID v4', () => {
      expect(() => assertApprovedRoute('GET', '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
    });

    it('rejects GET without UUID', () => {
      expect(() => assertApprovedRoute('GET', '/newsroom/v1/drafts')).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('rejects POST with UUID', () => {
      expect(() => assertApprovedRoute('POST', '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000')).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('rejects unsupported methods', () => {
      expect(() => assertApprovedRoute('PUT', '/newsroom/v1/drafts')).toThrow('Unsupported WordPress newsroom operation.');
      expect(() => assertApprovedRoute('DELETE', '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000')).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('rejects non-newsroom routes', () => {
      expect(() => assertApprovedRoute('POST', '/wp/v2/posts')).toThrow('Unsupported WordPress newsroom operation.');
      expect(() => assertApprovedRoute('GET', '/wp/v2/posts/1')).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('rejects GET with non-canonical UUID (uppercase)', () => {
      expect(() => assertApprovedRoute('GET', '/newsroom/v1/drafts/550E8400-E29B-41D4-A716-446655440000')).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('rejects GET with trailing path segments', () => {
      expect(() => assertApprovedRoute('GET', '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000/extra')).toThrow('Unsupported WordPress newsroom operation.');
    });
  });

  describe('signNewsroomRequest', () => {
    it('produces deterministic POST signature matching cross-language vector', () => {
      const headers = signNewsroomRequest({
        method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY,
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      });
      expect(headers['X-Newsroom-Auth-Version']).toBe('1');
      expect(headers['X-Newsroom-Key-Id']).toBe(TEST_KEY_ID);
      expect(headers['X-Newsroom-Timestamp']).toBe(String(FIXED_TIMESTAMP));
      expect(headers['X-Newsroom-Signature']).toBe(POST_SIGNATURE);
    });

    it('produces deterministic GET signature matching cross-language vector', () => {
      const headers = signNewsroomRequest({
        method: 'GET', route: GET_ROUTE, rawBody: '',
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      });
      expect(headers['X-Newsroom-Auth-Version']).toBe('1');
      expect(headers['X-Newsroom-Key-Id']).toBe(TEST_KEY_ID);
      expect(headers['X-Newsroom-Timestamp']).toBe(String(FIXED_TIMESTAMP));
      expect(headers['X-Newsroom-Signature']).toBe(GET_SIGNATURE);
    });

    it('produces exact canonical string with no trailing LF', () => {
      const canonicalString = ['newsroom-hmac-v1', TEST_KEY_ID, 'POST', '/newsroom/v1/drafts', String(FIXED_TIMESTAMP), POST_BODY_SHA].join('\n');
      expect(canonicalString).toBe(POST_CANONICAL);
      expect(canonicalString.endsWith('\n')).toBe(false);
      expect(canonicalString.split('\n')).toHaveLength(6);
    });

    it('uses lowercase hex HMAC-SHA-256', () => {
      const headers = signNewsroomRequest({
        method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY,
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      });
      expect(/^[0-9a-f]{64}$/.test(headers['X-Newsroom-Signature'])).toBe(true);
      const expected = createHmac('sha256', VALID_SECRET).update(POST_CANONICAL).digest('hex');
      expect(headers['X-Newsroom-Signature']).toBe(expected);
    });

    it('SHA-256 body hash is lowercase hex', () => {
      const sha = createHash('sha256').update(POST_BODY).digest('hex');
      expect(sha).toBe(POST_BODY_SHA);
      expect(/^[0-9a-f]{64}$/.test(sha)).toBe(true);
    });

    it('GET signature uses empty-body SHA-256 (constant)', () => {
      const sha = createHash('sha256').update('').digest('hex');
      expect(sha).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('throws on GET with non-empty body', () => {
      expect(() => signNewsroomRequest({
        method: 'GET', route: GET_ROUTE, rawBody: 'non-empty',
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      })).toThrow('Signed newsroom GET must have an empty body.');
    });

    it('throws on invalid key ID', () => {
      expect(() => signNewsroomRequest({
        method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY,
        keyId: 'Bad Key!', secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      })).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('throws on negative timestamp', () => {
      expect(() => signNewsroomRequest({
        method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY,
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: -1,
      })).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('throws on non-safe-integer timestamp', () => {
      expect(() => signNewsroomRequest({
        method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY,
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: 1.5,
      })).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('throws on unsupported route', () => {
      expect(() => signNewsroomRequest({
        method: 'POST', route: '/wp/v2/posts', rawBody: POST_BODY,
        keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP,
      })).toThrow('Unsupported WordPress newsroom operation.');
    });

    it('signature changes with different secret', () => {
      const altSecret = Buffer.alloc(32, 0xff);
      const h1 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY, keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      const h2 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY, keyId: TEST_KEY_ID, secret: altSecret, timestamp: FIXED_TIMESTAMP });
      expect(h1['X-Newsroom-Signature']).not.toBe(h2['X-Newsroom-Signature']);
    });

    it('signature changes with different body', () => {
      const h1 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY, keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      const h2 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: '{"changed":true}', keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      expect(h1['X-Newsroom-Signature']).not.toBe(h2['X-Newsroom-Signature']);
    });

    it('signature changes with different timestamp', () => {
      const h1 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY, keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      const h2 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: POST_BODY, keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP + 1 });
      expect(h1['X-Newsroom-Signature']).not.toBe(h2['X-Newsroom-Signature']);
    });

    it('signature changes with different method', () => {
      const getRoute = '/newsroom/v1/drafts/550e8400-e29b-41d4-a716-446655440000';
      const h1 = signNewsroomRequest({ method: 'POST', route: '/newsroom/v1/drafts', rawBody: '', keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      const h2 = signNewsroomRequest({ method: 'GET', route: getRoute, rawBody: '', keyId: TEST_KEY_ID, secret: VALID_SECRET, timestamp: FIXED_TIMESTAMP });
      expect(h1['X-Newsroom-Signature']).not.toBe(h2['X-Newsroom-Signature']);
    });
  });
});
