import { WordPressMediaError } from './wordpress-media.errors';
import { assertApprovedMediaRoute, decodeMediaHmacSecret, mediaMimeIsValid, signNewsroomMediaRequest } from './wordpress-media-hmac';
import type { CreateMediaInput, CreateMediaResult, WordPressMediaClientOptions } from './wordpress-media.types';

export interface MediaTransportResponse { status: number; body: unknown; }
export interface WordPressMediaTransport {
  send(request: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>>; body?: Buffer; timeoutMs: number }): Promise<MediaTransportResponse>;
}

class FetchWordPressMediaTransport implements WordPressMediaTransport {
  async send(request: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>>; body?: Buffer; timeoutMs: number }): Promise<MediaTransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: new Uint8Array(request.body) }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const arrayBuffer = await response.arrayBuffer();
      const text = Buffer.from(arrayBuffer).toString('utf8');
      let body: unknown = null;
      try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
      return { status: response.status, body };
    } finally { clearTimeout(timeout); }
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const wait = (milliseconds: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class WordPressMediaClient {
  private readonly baseUrl: URL;
  private readonly secret: Buffer;
  private readonly transport: WordPressMediaTransport;

  constructor(private readonly options: WordPressMediaClientOptions, transport?: WordPressMediaTransport, private readonly now: () => number = () => Date.now()) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.keyId)) throw new Error('Invalid WordPress media HMAC configuration.');
    this.secret = decodeMediaHmacSecret(options.secret);
    if (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 100
      || !Number.isInteger(options.reconciliationAttempts) || options.reconciliationAttempts < 1
      || !Number.isInteger(options.reconciliationDelayMs) || options.reconciliationDelayMs < 0
      || !Number.isInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('Invalid WordPress media client configuration.');
    this.transport = transport ?? new FetchWordPressMediaTransport();
  }

  async uploadMedia(input: CreateMediaInput): Promise<CreateMediaResult> {
    validateCreateInput(input, this.options.maxBytes);
    const route = '/newsroom-media/v1/media';
    return this.postOrReconcile(input, route, true);
  }

  async getMediaByKey(mediaKey: string): Promise<{ mediaKey: string; attachmentId: number; status: 'attachment' }> {
    validateMediaKey(mediaKey);
    const route = `/newsroom-media/v1/media/${mediaKey}`;
    const response = await this.send('GET', route, mediaKey, null, null, Buffer.alloc(0));
    if (response.status === 200) {
      const value = validateMediaResponse(response.body);
      if (value.status === 'reserved') throw new WordPressMediaError('IN_PROGRESS', 'Media creation is already in progress.');
      return { mediaKey: value.mediaKey, attachmentId: value.attachmentId, status: 'attachment' };
    }
    throw classifyMediaStatus(response.status);
  }

  private async postOrReconcile(input: CreateMediaInput, route: string, mayRetryPost: boolean): Promise<CreateMediaResult> {
    try {
      const response = await this.send('POST', route, input.mediaKey, input.filename, input.mimeType, input.body);
if (response.status === 200 || response.status === 201) {
      const value = validateMediaResponse(response.body);
      if (value.status !== 'attachment' || value.mediaKey !== input.mediaKey || (response.status === 201) === value.replayed) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned an inconsistent media response.', response.status);
      return { mediaKey: value.mediaKey, attachmentId: value.attachmentId, status: 'attachment', outcome: value.replayed ? 'REPLAYED' : 'CREATED' };
    }
      throw classifyMediaStatus(response.status);
    } catch (error) {
      const classified = classifyTransport(error);
      if (classified.code !== 'UNCERTAIN_OUTCOME') throw classified;
      return this.reconcileUncertain(input, route, mayRetryPost);
    }
  }

  private async reconcileUncertain(input: CreateMediaInput, route: string, mayRetryPost: boolean): Promise<CreateMediaResult> {
    for (let attempt = 0; attempt < this.options.reconciliationAttempts; attempt += 1) {
      try {
        const getRoute = `/newsroom-media/v1/media/${input.mediaKey}`;
        const getResponse = await this.send('GET', getRoute, input.mediaKey, null, null, Buffer.alloc(0));
        if (getResponse.status === 200) {
          const media = validateMediaResponse(getResponse.body);
          if (media.status === 'attachment') {
            return { mediaKey: media.mediaKey, attachmentId: media.attachmentId, status: 'attachment', outcome: 'RECOVERED' };
          }
          if (media.status === 'reserved') {
            if (mayRetryPost) return this.postOrReconcile(input, route, false);
            throw new WordPressMediaError('IN_PROGRESS', 'Media creation is already in progress.');
          }
        }
        throw classifyMediaStatus(getResponse.status);
      } catch (error) {
        const classified = classifyTransport(error);
        if (classified.code === 'NOT_FOUND') {
          if (mayRetryPost) return this.postOrReconcile(input, route, false);
          throw new WordPressMediaError('UNCERTAIN_OUTCOME', 'WordPress media outcome remains uncertain.');
        }
        if (classified.code === 'IN_PROGRESS') throw classified;
        if (!['UNCERTAIN_OUTCOME', 'WORDPRESS_UNAVAILABLE'].includes(classified.code)) throw classified;
        if (attempt + 1 === this.options.reconciliationAttempts) throw new WordPressMediaError('UNCERTAIN_OUTCOME', 'WordPress media outcome remains uncertain.');
        if (this.options.reconciliationDelayMs > 0) await wait(this.options.reconciliationDelayMs);
      }
    }
    throw new WordPressMediaError('UNCERTAIN_OUTCOME', 'WordPress media outcome remains uncertain.');
  }

  private async send(method: 'GET' | 'POST', route: string, mediaKey: string, filename: string | null, mimeType: string | null, body: Buffer): Promise<MediaTransportResponse> {
    assertApprovedMediaRoute(method, route);
    const timestamp = Math.floor(this.now() / 1000);
    const headers: Record<string, string> = {
      ...signNewsroomMediaRequest({
        keyId: this.options.keyId,
        secret: this.secret,
        method,
        route,
        timestamp: String(timestamp),
        mediaKey,
        filename,
        mime: mimeType,
        body,
      }),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(body.length);
    }
    const url = this.urlFor(route);
    try {
      return await this.transport.send({
        method,
        url,
        headers,
        ...(method === 'POST' ? { body } : {}),
        timeoutMs: this.options.requestTimeoutMs,
      });
    } catch {
      throw new WordPressMediaError('UNCERTAIN_OUTCOME', 'WordPress media request outcome is uncertain.');
    }
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

function validateMediaKey(value: string): void { if (!UUID_V4.test(value)) throw new WordPressMediaError('CONTRACT_FAILURE', 'Invalid media key.'); }

function validateCreateInput(input: CreateMediaInput, maxBytes: number): void {
  if (!UUID_V4.test(input.mediaKey)) throw new WordPressMediaError('CONTRACT_FAILURE', 'Invalid media key.');
  if (!Buffer.isBuffer(input.body)) throw new WordPressMediaError('CONTRACT_FAILURE', 'Media body must be a Buffer.');
  if (input.body.length === 0) throw new WordPressMediaError('CONTRACT_FAILURE', 'Empty media body rejected.');
  if (input.body.length > maxBytes) throw new WordPressMediaError('PAYLOAD_REJECTED', 'Media body exceeds the byte limit.', 413);
  if (typeof input.filename !== 'string' || input.filename.length === 0 || input.filename.length > 255) throw new WordPressMediaError('CONTRACT_FAILURE', 'Invalid media filename.');
  if (typeof input.mimeType !== 'string' || !mediaMimeIsValid(input.mimeType)) throw new WordPressMediaError('CONTRACT_FAILURE', 'Unsupported media MIME type.');
}

function validateMediaResponse(body: unknown): { mediaKey: string; attachmentId: null; status: 'reserved'; replayed: boolean } | { mediaKey: string; attachmentId: number; status: 'attachment'; replayed: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ['attachment_id', 'media_key', 'replayed', 'status'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  if (typeof value.media_key !== 'string' || !UUID_V4.test(value.media_key)) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  if (typeof value.replayed !== 'boolean') throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  if (value.status === 'reserved') {
    if (value.attachment_id !== null) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
    return { mediaKey: value.media_key, attachmentId: null, status: 'reserved', replayed: value.replayed };
  }
  if (value.status !== 'attachment') throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  if (!Number.isSafeInteger(value.attachment_id) || (value.attachment_id as number) <= 0) throw new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned a malformed media response.');
  return { mediaKey: value.media_key, attachmentId: value.attachment_id as number, status: 'attachment', replayed: value.replayed };
}

function classifyMediaStatus(status: number): WordPressMediaError {
  if (status === 401 || status === 403) return new WordPressMediaError('AUTHENTICATION_FAILURE', 'WordPress media authentication failed.', status);
  if (status === 413) return new WordPressMediaError('PAYLOAD_REJECTED', 'WordPress rejected the media payload.', status);
  if (status === 400 || (status >= 300 && status < 400)) return new WordPressMediaError('CONTRACT_FAILURE', 'WordPress rejected the media contract.', status);
  if (status === 409) return new WordPressMediaError('CONFLICT', 'WordPress media key conflicts with another payload.', status);
  if (status === 404) return new WordPressMediaError('NOT_FOUND', 'WordPress media mapping was not found.', status);
  if (status === 503) return new WordPressMediaError('IN_PROGRESS', 'Media creation is already in progress.', status);
  if (status >= 500) return new WordPressMediaError('UNCERTAIN_OUTCOME', 'WordPress media request outcome is uncertain.', status);
  return new WordPressMediaError('UNEXPECTED_RESPONSE', 'WordPress returned an unexpected response.', status);
}

function classifyTransport(error: unknown): WordPressMediaError {
  return error instanceof WordPressMediaError ? error : new WordPressMediaError('WORDPRESS_UNAVAILABLE', 'WordPress is unavailable.');
}