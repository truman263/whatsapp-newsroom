import { syncPayload, validateStateResponse, draftStateFingerprint, type SyncWordPressDraftInput, type SyncWordPressDraftResult, type WordPressDraftState } from './wordpress-draft-state';
import { WordPressDraftError } from './wordpress-draft.errors';
import { assertApprovedRoute, decodeDraftHmacSecret, signNewsroomRequest } from './wordpress-hmac';
import type { CreateWordPressDraftInput, CreateWordPressDraftResult, WordPressDraftClientOptions, WordPressDraftReference } from './wordpress-draft.types';

export interface TransportResponse { status: number; body: unknown; }
export interface WordPressTransport {
  send(request: { method: 'GET' | 'POST' | 'PUT'; url: string; headers: Readonly<Record<string, string>>; body?: string; timeoutMs: number }): Promise<TransportResponse>;
}

class FetchWordPressTransport implements WordPressTransport {
  async send(request: { method: 'GET' | 'POST' | 'PUT'; url: string; headers: Readonly<Record<string, string>>; body?: string; timeoutMs: number }): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), redirect: 'manual', signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
      return { status: response.status, body };
    } finally { clearTimeout(timeout); }
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const wait = (milliseconds: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class WordPressDraftClient {
  private readonly baseUrl: URL;
  private readonly secret: Buffer;
  private readonly transport: WordPressTransport;

  constructor(private readonly options: WordPressDraftClientOptions, transport?: WordPressTransport, private readonly now: () => number = () => Date.now()) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.keyId)) throw new Error('Invalid WordPress draft HMAC configuration.');
    this.secret = decodeDraftHmacSecret(options.secret);
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100 || !Number.isInteger(options.reconciliationAttempts) || options.reconciliationAttempts < 1 || !Number.isInteger(options.reconciliationDelayMs) || options.reconciliationDelayMs < 0) throw new Error('Invalid WordPress draft client configuration.');
    this.transport = transport ?? new FetchWordPressTransport();
  }

  async createDraft(input: CreateWordPressDraftInput): Promise<CreateWordPressDraftResult> {
    validateCreateInput(input);
    const rawBody = JSON.stringify({ draft_key: input.wordpressDraftKey, title: input.headline, content: input.body, excerpt: input.excerpt ?? '', categories: input.wordpressCategoryIds });
    return this.postOrReconcile(input.wordpressDraftKey, rawBody, true);
  }

  async getDraftByKey(wordpressDraftKey: string): Promise<WordPressDraftReference> {
    validateDraftKey(wordpressDraftKey);
    return this.getDraft(wordpressDraftKey);
  }

  async getDraftState(draftKey: string): Promise<WordPressDraftState> {
    validateDraftKey(draftKey);
    const response = await this.send('GET', `/newsroom/v1/drafts/${draftKey}/state`);
    if (response.status !== 200) throw classifyStatus(response.status);
    return validateStateResponse(response.body, draftKey, true);
  }

  async syncDraft(input: SyncWordPressDraftInput): Promise<SyncWordPressDraftResult> {
    const payload = syncPayload(input);
    const rawBody = JSON.stringify(payload);
    const desired = draftStateFingerprint(payload);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.send('PUT', `/newsroom/v1/drafts/${payload.draft_key}`, rawBody);
        if (response.status === 200) {
          const result = validateStateResponse(response.body, payload.draft_key, false);
          if (result.applied_version !== desired || result.featured_media_key !== payload.featured_media_key) throw new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned inconsistent sync state.');
          return { ...result, outcome: result.replayed ? 'REPLAYED' : 'APPLIED' };
        }
        if (response.status === 409 && response.body && typeof response.body === 'object' && (response.body as Record<string, unknown>).code === 'newsroom_draft_sync_stale_version') throw new WordPressDraftError('STALE_VERSION', 'WordPress draft state changed.', 409);
        if (response.status >= 200 && response.status < 300) throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress sync outcome is uncertain.');
        throw classifyStatus(response.status);
      } catch (error) {
        const failure = classifyTransport(error);
        if (!['UNCERTAIN_OUTCOME', 'UNEXPECTED_RESPONSE'].includes(failure.code)) throw failure;
        let current: WordPressDraftState;
        try { current = await this.getDraftState(payload.draft_key); }
        catch { throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress sync could not be reconciled.'); }
        if (current.applied_version === desired) return { draft_key: current.draft_key, post_id: current.post_id, status: 'draft', featured_media_key: current.featured_media_key, applied_version: current.applied_version, replayed: true, outcome: 'RECOVERED' };
        if (payload.expected_version !== null && payload.expected_version !== current.applied_version) throw new WordPressDraftError('STALE_VERSION', 'WordPress draft state changed.', 409);
        if (attempt === 1) throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress sync outcome remains uncertain.');
      }
    }
    throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress sync outcome remains uncertain.');
  }

  private async postOrReconcile(draftKey: string, rawBody: string, mayRetryPost: boolean): Promise<CreateWordPressDraftResult> {
    try {
      const response = await this.send('POST', '/newsroom/v1/drafts', rawBody);
      if (response.status === 200 || response.status === 201) {
        const value = validateBridgeResponse(response.body, true);
        if (value.wordpressDraftKey !== draftKey || (response.status === 201) === value.replayed) throw new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned an inconsistent draft response.', response.status);
        return { wordpressDraftKey: value.wordpressDraftKey, wordpressPostId: value.wordpressPostId, status: value.status, outcome: value.replayed ? 'REPLAYED' : 'CREATED' };
      }
      throw classifyStatus(response.status);
    } catch (error) {
      const classified = classifyTransport(error);
      if (classified.code !== 'UNCERTAIN_OUTCOME') throw classified;
      return this.reconcileUncertain(draftKey, rawBody, mayRetryPost);
    }
  }

  private async reconcileUncertain(draftKey: string, rawBody: string, mayRetryPost: boolean): Promise<CreateWordPressDraftResult> {
    for (let attempt = 0; attempt < this.options.reconciliationAttempts; attempt += 1) {
      try {
        const found = await this.getDraft(draftKey);
        return { ...found, outcome: 'RECOVERED' };
      } catch (error) {
        const classified = classifyTransport(error);
        if (classified.code === 'NOT_FOUND') {
          if (mayRetryPost) return this.postOrReconcile(draftKey, rawBody, false);
          throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress draft outcome remains uncertain.');
        }
        if (!['UNCERTAIN_OUTCOME', 'WORDPRESS_UNAVAILABLE'].includes(classified.code)) throw classified;
        if (attempt + 1 === this.options.reconciliationAttempts) throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress draft outcome remains uncertain.');
        if (this.options.reconciliationDelayMs > 0) await wait(this.options.reconciliationDelayMs);
      }
    }
    throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress draft outcome remains uncertain.');
  }

  private async getDraft(draftKey: string): Promise<WordPressDraftReference> {
    const response = await this.send('GET', `/newsroom/v1/drafts/${draftKey}`);
    if (response.status === 200) return validateBridgeResponse(response.body, false);
    throw classifyStatus(response.status);
  }

  private async send(method: 'GET' | 'POST' | 'PUT', route: string, rawBody = ''): Promise<TransportResponse> {
    assertApprovedRoute(method, route);
    const headers: Record<string, string> = { ...signNewsroomRequest({ method, route, rawBody, keyId: this.options.keyId, secret: this.secret, timestamp: Math.floor(this.now() / 1000) }) };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const url = this.urlFor(route);
    try { return await this.transport.send({ method, url, headers, ...(method !== 'GET' ? { body: rawBody } : {}), timeoutMs: this.options.requestTimeoutMs }); }
    catch { throw new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress request outcome is uncertain.'); }
  }

  private urlFor(route: string): string {
    const url = new URL(this.baseUrl.toString());
    url.pathname = `${url.pathname === '/' ? '' : url.pathname}/wp-json${route}`;
    if (url.origin !== this.baseUrl.origin || url.search || url.hash) throw new Error('Invalid WordPress request URL.');
    return url.toString();
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid WordPress base URL.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

function validateDraftKey(value: string): void { if (!UUID_V4.test(value)) throw new WordPressDraftError('CONTRACT_FAILURE', 'Invalid WordPress draft key.'); }
function validateCreateInput(input: CreateWordPressDraftInput): void {
  validateDraftKey(input.wordpressDraftKey);
  if (typeof input.headline !== 'string' || input.headline.trim() === '' || typeof input.body !== 'string' || input.body.trim() === '' || (input.excerpt !== undefined && typeof input.excerpt !== 'string') || !Array.isArray(input.wordpressCategoryIds) || input.wordpressCategoryIds.length === 0 || input.wordpressCategoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new WordPressDraftError('CONTRACT_FAILURE', 'Invalid WordPress draft input.');
}

function validateBridgeResponse(body: unknown, creation: true): WordPressDraftReference & { replayed: boolean };
function validateBridgeResponse(body: unknown, creation: false): WordPressDraftReference;
function validateBridgeResponse(body: unknown, creation: boolean): WordPressDraftReference & { replayed?: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed response.');
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = (creation ? ['draft_key', 'post_id', 'replayed', 'status'] : ['draft_key', 'post_id', 'status']).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || typeof value.draft_key !== 'string' || !UUID_V4.test(value.draft_key) || !Number.isSafeInteger(value.post_id) || (value.post_id as number) <= 0 || value.status !== 'draft' || (creation && typeof value.replayed !== 'boolean')) throw new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed response.');
  return { wordpressDraftKey: value.draft_key, wordpressPostId: value.post_id as number, status: 'draft', ...(creation ? { replayed: value.replayed as boolean } : {}) };
}

function classifyStatus(status: number): WordPressDraftError {
  if (status === 401) return new WordPressDraftError('AUTHENTICATION_FAILURE', 'WordPress draft authentication failed.', status);
  if (status === 403 || status === 400 || status === 422 || (status >= 300 && status < 400)) return new WordPressDraftError('CONTRACT_FAILURE', 'WordPress rejected the draft contract.', status);
  if (status === 409) return new WordPressDraftError('CONFLICT', 'WordPress draft key conflicts with another payload.', status);
  if (status === 404) return new WordPressDraftError('NOT_FOUND', 'WordPress draft mapping was not found.', status);
  if (status >= 500) return new WordPressDraftError('UNCERTAIN_OUTCOME', 'WordPress request outcome is uncertain.', status);
  return new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned an unexpected response.', status);
}

function classifyTransport(error: unknown): WordPressDraftError {
  return error instanceof WordPressDraftError ? error : new WordPressDraftError('WORDPRESS_UNAVAILABLE', 'WordPress is unavailable.');
}
