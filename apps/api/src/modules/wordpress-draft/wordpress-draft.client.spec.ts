import { createHash, createHmac } from 'node:crypto';
import type { WordPressDraftClientOptions } from './wordpress-draft.types';
import { WordPressDraftClient, type TransportResponse, type WordPressTransport } from './wordpress-draft.client';
import { WordPressDraftError, type WordPressDraftErrorCode } from './wordpress-draft.errors';

const TEST_KEY_ID = 'test-draft-key';
const TEST_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BASE_URL = 'http://localhost:8080';
const SUBDIRECTORY_URL = 'http://localhost:8080/wp';
const FIXED_NOW = 1700000000000;
const UUID = '550e8400-e29b-41d4-a716-446655440000';

interface MockRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

class MockTransport implements WordPressTransport {
  public readonly requests: MockRequest[] = [];
  private handler: ((req: MockRequest) => TransportResponse) | undefined;

  public setHandler(fn: (req: MockRequest) => TransportResponse): void {
    this.handler = fn;
  }

  public send(req: MockRequest): Promise<TransportResponse> {
    const request: MockRequest = { ...req, headers: { ...req.headers } };
    this.requests.push(request);
    const response = this.handler
      ? this.handler(request)
      : { status: 201, body: { draft_key: UUID, post_id: 1, replayed: false, status: 'draft' } };
    return Promise.resolve(response);
  }
}

interface Options {
  baseUrl?: string;
  keyId?: string;
  secret?: string;
  requestTimeoutMs?: number;
  reconciliationAttempts?: number;
  reconciliationDelayMs?: number;
}

function makeOptions(overrides: Options = {}): WordPressDraftClientOptions {
  return {
    baseUrl: overrides.baseUrl ?? BASE_URL,
    keyId: overrides.keyId ?? TEST_KEY_ID,
    secret: overrides.secret ?? TEST_SECRET,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5000,
    reconciliationAttempts: overrides.reconciliationAttempts ?? 1,
    reconciliationDelayMs: overrides.reconciliationDelayMs ?? 0,
  };
}

function makeClient(options: Options = {}, transport?: MockTransport): { client: WordPressDraftClient; transport: MockTransport } {
  const mock = transport ?? new MockTransport();
  const client = new WordPressDraftClient(makeOptions(options), mock, () => FIXED_NOW);
  return { client, transport: mock };
}

function transportStub(): WordPressTransport {
  return {
    send: (): Promise<TransportResponse> => Promise.resolve({ status: 200, body: null }),
  };
}

function firstRequest(transport: MockTransport): MockRequest {
  const request = transport.requests[0];
  if (!request) throw new Error('No transport request was recorded.');
  return request;
}

async function expectClientError(promise: Promise<unknown>, code: WordPressDraftErrorCode, httpStatus?: number): Promise<void> {
  const error = await promise.then(
    () => { throw new Error(`Expected WordPressDraftError ${code} to be thrown.`); },
    (caught: unknown) => caught,
  );
  if (!(error instanceof WordPressDraftError)) throw new Error(`Expected WordPressDraftError, received ${typeof error}.`);
  expect(error.code).toBe(code);
  if (httpStatus !== undefined) expect(error.httpStatus).toBe(httpStatus);
}

const validDraftInput = { wordpressDraftKey: UUID, headline: 'Title', body: 'Content', wordpressCategoryIds: [1] };

describe('WordPressDraftClient', () => {
  describe('constructor validation', () => {
    it('rejects invalid base URL', () => {
      expect(() => new WordPressDraftClient(makeOptions({ baseUrl: 'not-a-url' }), transportStub(), () => FIXED_NOW)).toThrow();
    });

    it('rejects base URL with userinfo', () => {
      expect(() => new WordPressDraftClient(makeOptions({ baseUrl: 'http://user:pass@host/' }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress base URL.');
    });

    it('rejects base URL with query string', () => {
      expect(() => new WordPressDraftClient(makeOptions({ baseUrl: 'http://host/?x=1' }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress base URL.');
    });

    it('rejects base URL with fragment', () => {
      expect(() => new WordPressDraftClient(makeOptions({ baseUrl: 'http://host/#x' }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress base URL.');
    });

    it('rejects invalid key ID', () => {
      expect(() => new WordPressDraftClient(makeOptions({ keyId: 'Bad Key' }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('rejects invalid secret', () => {
      expect(() => new WordPressDraftClient(makeOptions({ secret: 'short' }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress draft HMAC configuration.');
    });

    it('rejects invalid timeout', () => {
      expect(() => new WordPressDraftClient(makeOptions({ requestTimeoutMs: 50 }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress draft client configuration.');
    });

    it('rejects invalid reconciliation attempts', () => {
      expect(() => new WordPressDraftClient(makeOptions({ reconciliationAttempts: 0 }), transportStub(), () => FIXED_NOW)).toThrow('Invalid WordPress draft client configuration.');
    });
  });

  describe('subdirectory base URL', () => {
    it('appends /wp-json before route', async () => {
      const { client, transport } = makeClient({ baseUrl: SUBDIRECTORY_URL });
      await client.createDraft(validDraftInput);
      expect(firstRequest(transport).url).toBe('http://localhost:8080/wp/wp-json/newsroom/v1/drafts');
    });
  });

  describe('no generic auth headers', () => {
    it('never sends Authorization, Cookie, or X-WP-Nonce on POST', async () => {
      const mock = new MockTransport();
      const { client, transport } = makeClient({}, mock);
      await client.createDraft(validDraftInput);
      const h = firstRequest(transport).headers;
      expect(h['Authorization']).toBeUndefined();
      expect(h['authorization']).toBeUndefined();
      expect(h['Cookie']).toBeUndefined();
      expect(h['cookie']).toBeUndefined();
      expect(h['X-WP-Nonce']).toBeUndefined();
      expect(h['x-wp-nonce']).toBeUndefined();
    });

    it('never sends Authorization, Cookie, or X-WP-Nonce on GET', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 1, status: 'draft' } }));
      const { client, transport } = makeClient({}, mock);
      await client.getDraftByKey(UUID);
      const h = firstRequest(transport).headers;
      expect(h['Authorization']).toBeUndefined();
      expect(h['Cookie']).toBeUndefined();
      expect(h['X-WP-Nonce']).toBeUndefined();
    });
  });

  describe('GET zero-body no Content-Type', () => {
    it('sends no body and no Content-Type on GET', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 1, status: 'draft' } }));
      const { client, transport } = makeClient({}, mock);
      await client.getDraftByKey(UUID);
      const req = firstRequest(transport);
      expect(req.method).toBe('GET');
      expect(Object.prototype.hasOwnProperty.call(req, 'body')).toBe(false);
      expect(req.headers['Content-Type']).toBeUndefined();
      expect(req.headers['content-type']).toBeUndefined();
    });
  });

  describe('exact-byte POST transport', () => {
    it('signs exact same bytes as transmitted', async () => {
      const { client, transport } = makeClient();
      await client.createDraft(validDraftInput);
      const req = firstRequest(transport);
      const rawBody = JSON.stringify({ draft_key: UUID, title: 'Title', content: 'Content', excerpt: '', categories: [1] });
      expect(req.body).toBe(rawBody);
      expect(req.method).toBe('POST');
      expect(req.headers['Content-Type']).toBe('application/json');
      const bodyHash = createHash('sha256').update(rawBody).digest('hex');
      const canonical = ['newsroom-hmac-v1', TEST_KEY_ID, 'POST', '/newsroom/v1/drafts', String(Math.floor(FIXED_NOW / 1000)), bodyHash].join('\n');
      const expectedSig = createHmac('sha256', Buffer.from(TEST_SECRET, 'base64url')).update(canonical).digest('hex');
      expect(req.headers['X-Newsroom-Signature']).toBe(expectedSig);
    });
  });

  describe('redirect handling', () => {
    it('maps 302 to CONTRACT_FAILURE', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 302, body: null }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'CONTRACT_FAILURE');
    });

    it('maps 301 to CONTRACT_FAILURE', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 301, body: null }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'CONTRACT_FAILURE');
    });
  });

  describe('error classification', () => {
    it('maps 401 to AUTHENTICATION_FAILURE', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 401, body: { code: 'unauthorized' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'AUTHENTICATION_FAILURE', 401);
    });

    it('maps 403 to CONTRACT_FAILURE', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 403, body: { code: 'forbidden' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'CONTRACT_FAILURE', 403);
    });

    it('maps 409 to CONFLICT', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 409, body: { code: 'conflict' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'CONFLICT', 409);
    });

    it('maps 404 to NOT_FOUND', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 404, body: { code: 'not_found' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'NOT_FOUND', 404);
    });

    it('maps 500+ to UNCERTAIN_OUTCOME', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 503, body: { code: 'server_error' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'UNCERTAIN_OUTCOME');
    });
  });

  describe('strict response validation', () => {
    it('rejects missing draft_key', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 201, body: { post_id: 1, replayed: false, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNEXPECTED_RESPONSE');
    });

    it('rejects null body', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: null }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'UNEXPECTED_RESPONSE');
    });

    it('rejects array body', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 201, body: [1, 2, 3] }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNEXPECTED_RESPONSE');
    });

    it('rejects extra fields', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 201, body: { draft_key: UUID, post_id: 1, replayed: false, status: 'draft', extra: true } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNEXPECTED_RESPONSE');
    });

    it('rejects non-draft status', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 1, status: 'publish' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'UNEXPECTED_RESPONSE');
    });

    it('rejects negative post_id', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: -1, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'UNEXPECTED_RESPONSE');
    });

    it('rejects inconsistent 201+replayed=true', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 201, body: { draft_key: UUID, post_id: 1, replayed: true, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNEXPECTED_RESPONSE');
    });

    it('rejects inconsistent 200+replayed=false', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 1, replayed: false, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNEXPECTED_RESPONSE');
    });
  });

  describe('input validation', () => {
    it('rejects non-UUID draft key', async () => {
      const { client } = makeClient();
      await expectClientError(client.createDraft({ ...validDraftInput, wordpressDraftKey: 'not-a-uuid' }), 'CONTRACT_FAILURE');
    });

    it('rejects empty headline', async () => {
      const { client } = makeClient();
      await expectClientError(client.createDraft({ ...validDraftInput, headline: '  ' }), 'CONTRACT_FAILURE');
    });

    it('rejects empty body', async () => {
      const { client } = makeClient();
      await expectClientError(client.createDraft({ ...validDraftInput, body: '  ' }), 'CONTRACT_FAILURE');
    });

    it('rejects empty categories', async () => {
      const { client } = makeClient();
      await expectClientError(client.createDraft({ ...validDraftInput, wordpressCategoryIds: [] }), 'CONTRACT_FAILURE');
    });

    it('rejects non-positive category ID', async () => {
      const { client } = makeClient();
      await expectClientError(client.createDraft({ ...validDraftInput, wordpressCategoryIds: [0] }), 'CONTRACT_FAILURE');
    });
  });

  describe('successful createDraft', () => {
    it('returns CREATED on 201', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 201, body: { draft_key: UUID, post_id: 42, replayed: false, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      const result = await client.createDraft(validDraftInput);
      expect(result).toEqual({ wordpressDraftKey: UUID, wordpressPostId: 42, status: 'draft', outcome: 'CREATED' });
    });

    it('returns REPLAYED on 200', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 42, replayed: true, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      const result = await client.createDraft(validDraftInput);
      expect(result).toEqual({ wordpressDraftKey: UUID, wordpressPostId: 42, status: 'draft', outcome: 'REPLAYED' });
    });
  });

  describe('successful getDraftByKey', () => {
    it('returns WordPressDraftReference on 200', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 200, body: { draft_key: UUID, post_id: 42, status: 'draft' } }));
      const { client } = makeClient({}, mock);
      const result = await client.getDraftByKey(UUID);
      expect(result).toEqual({ wordpressDraftKey: UUID, wordpressPostId: 42, status: 'draft' });
    });
  });

  describe('uncertain outcome — response lost after commit', () => {
    it('recovers by GET after uncertain POST', async () => {
      const mock = new MockTransport();
      let postCount = 0;
      mock.setHandler((req) => {
        if (req.method === 'POST') {
          postCount += 1;
          throw new Error('socket hang up');
        }
        return { status: 200, body: { draft_key: UUID, post_id: 99, status: 'draft' } };
      });
      const { client, transport } = makeClient({ reconciliationAttempts: 2 }, mock);
      const result = await client.createDraft(validDraftInput);
      expect(result).toEqual({ wordpressDraftKey: UUID, wordpressPostId: 99, status: 'draft', outcome: 'RECOVERED' });
      expect(postCount).toBe(1);
      expect(transport.requests).toHaveLength(2);
      expect(transport.requests[1]?.method).toBe('GET');
    });
  });

  describe('uncertain outcome — POST not delivered', () => {
    it('retries GET 404 then POST succeeds', async () => {
      const mock = new MockTransport();
      let postCount = 0;
      let getCount = 0;
      mock.setHandler((req) => {
        if (req.method === 'POST') {
          postCount += 1;
          if (postCount === 1) throw new Error('ECONNREFUSED');
          return { status: 201, body: { draft_key: UUID, post_id: 50, replayed: false, status: 'draft' } };
        }
        getCount += 1;
        return { status: 404, body: { code: 'not_found' } };
      });
      const { client } = makeClient({ reconciliationAttempts: 3 }, mock);
      const result = await client.createDraft(validDraftInput);
      expect(result).toEqual({ wordpressDraftKey: UUID, wordpressPostId: 50, status: 'draft', outcome: 'CREATED' });
      expect(postCount).toBe(2);
      expect(getCount).toBe(1);
    });
  });

  describe('uncertain POST + GET uncertain → no blind second POST', () => {
    it('does not send a second POST when GET is also uncertain', async () => {
      const mock = new MockTransport();
      let postCount = 0;
      let getCount = 0;
      mock.setHandler((req) => {
        if (req.method === 'POST') {
          postCount += 1;
          throw new Error('ECONNREFUSED');
        }
        getCount += 1;
        throw new Error('ETIMEDOUT');
      });
      const { client } = makeClient({ reconciliationAttempts: 2 }, mock);
      await expectClientError(client.createDraft(validDraftInput), 'UNCERTAIN_OUTCOME');
      expect(postCount).toBe(1);
      expect(getCount).toBe(2);
    });
  });

  describe('transport error', () => {
    it('maps transport throw to UNCERTAIN_OUTCOME', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => { throw new Error('abort'); });
      const { client } = makeClient({}, mock);
      await expectClientError(client.getDraftByKey(UUID), 'UNCERTAIN_OUTCOME');
    });
  });

  describe('secret redaction', () => {
    it('error messages do not contain the secret', async () => {
      const mock = new MockTransport();
      mock.setHandler(() => ({ status: 401, body: {} }));
      const { client } = makeClient({}, mock);
      await expectClientError(client.createDraft(validDraftInput), 'AUTHENTICATION_FAILURE', 401);
    });
  });
});