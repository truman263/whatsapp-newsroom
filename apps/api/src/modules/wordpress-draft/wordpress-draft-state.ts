import { createHash } from 'node:crypto';
import { WordPressDraftError } from './wordpress-draft.errors';

export interface SyncWordPressDraftInput {
  wordpressDraftKey: string;
  headline: string;
  body: string;
  excerpt?: string;
  wordpressCategoryIds: number[];
  featuredMediaKey: string | null;
  expectedVersion?: string | null;
}
export interface CanonicalDraftState {
  title: string;
  content: string;
  excerpt: string;
  categories: number[];
  featured_media_key: string | null;
}
export interface WordPressDraftState extends CanonicalDraftState {
  draft_key: string;
  post_id: number;
  status: 'draft';
  author_id: number;
  applied_version: string;
}
export interface SyncWordPressDraftResult {
  draft_key: string;
  post_id: number;
  status: 'draft';
  replayed: boolean;
  featured_media_key: string | null;
  applied_version: string;
  outcome: 'APPLIED' | 'REPLAYED' | 'RECOVERED';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isDraftKey = (v: unknown): v is string => typeof v === 'string' && uuid.test(v) && v.length === 36;
export const isStateVersion = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) && v.length === 64;
const mediaKey = (v: unknown): boolean => v === null || isDraftKey(v);
const positiveId = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;
const validString = (v: unknown): v is string => typeof v === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
export function canonicalStateJson(state: CanonicalDraftState): string {
  // PHP escapes line/paragraph separators unless JSON_UNESCAPED_LINE_TERMINATORS is set.
  return JSON.stringify({ contract_version: 1, title: state.title, content: state.content, excerpt: state.excerpt, categories: [...new Set(state.categories)].sort((a, b) => a - b), featured_media_key: state.featured_media_key }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export function draftStateFingerprint(state: CanonicalDraftState): string {
  return createHash('sha256').update(canonicalStateJson(state), 'utf8').digest('hex');
}
export function reconciliationJson(state: Pick<CanonicalDraftState, 'title' | 'content' | 'excerpt' | 'categories'>): string {
  // The reconciliation payload fingerprint has NO featured_media_key and is
  // byte-identical to PHP's wp_json_encode(..., JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE).
  return JSON.stringify({ contract_version: 1, title: state.title, content: state.content, excerpt: state.excerpt, categories: [...new Set(state.categories)].sort((a, b) => a - b) }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export function reconciliationFingerprint(state: Pick<CanonicalDraftState, 'title' | 'content' | 'excerpt' | 'categories'>): string {
  return createHash('sha256').update(reconciliationJson(state), 'utf8').digest('hex');
}
export function syncPayload(input: SyncWordPressDraftInput): CanonicalDraftState & { draft_key: string; expected_version: string | null } {
  const allowed = ['wordpressDraftKey', 'headline', 'body', 'excerpt', 'wordpressCategoryIds', 'featuredMediaKey', 'expectedVersion'];
  if (!input || Object.keys(input).some((k) => !allowed.includes(k)) || !isDraftKey(input.wordpressDraftKey) || !validString(input.headline) || !input.headline.trim() || !validString(input.body) || !input.body.trim() || (input.excerpt !== undefined && !validString(input.excerpt)) || !Array.isArray(input.wordpressCategoryIds) || !input.wordpressCategoryIds.length || !input.wordpressCategoryIds.every(positiveId) || !mediaKey(input.featuredMediaKey) || (input.expectedVersion !== undefined && input.expectedVersion !== null && !isStateVersion(input.expectedVersion))) throw new WordPressDraftError('CONTRACT_FAILURE', 'Invalid WordPress sync input.');
  return { draft_key: input.wordpressDraftKey, title: input.headline, content: input.body, excerpt: input.excerpt ?? '', categories: [...new Set(input.wordpressCategoryIds)].sort((a, b) => a - b), featured_media_key: input.featuredMediaKey, expected_version: input.expectedVersion ?? null };
}
export function validateStateResponse(body: unknown, key: string, state: true): WordPressDraftState;
export function validateStateResponse(body: unknown, key: string, state: false): Omit<SyncWordPressDraftResult, 'outcome'>;
export function validateStateResponse(body: unknown, key: string, state: boolean): WordPressDraftState | Omit<SyncWordPressDraftResult, 'outcome'> {
  const bad = (): never => { throw new WordPressDraftError('UNEXPECTED_RESPONSE', 'WordPress returned an invalid draft state.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad();
  const b = body as Record<string, unknown>;
  const fields = ['draft_key', 'post_id', 'status', 'featured_media_key', 'applied_version', ...(state ? ['title', 'content', 'excerpt', 'categories', 'author_id'] : ['replayed'])];
  if (Object.keys(b).sort().join() !== fields.sort().join() || b.draft_key !== key || !positiveId(b.post_id) || b.status !== 'draft' || !mediaKey(b.featured_media_key) || !isStateVersion(b.applied_version)) return bad();
  if (state) {
    if (!validString(b.title) || !validString(b.content) || !validString(b.excerpt) || !positiveId(b.author_id) || !Array.isArray(b.categories) || !b.categories.length || !b.categories.every(positiveId) || b.categories.some((id: number, i: number) => i > 0 && id <= ((b.categories as number[])[i - 1] ?? 0))) return bad();
    const value = b as unknown as WordPressDraftState;
    if (draftStateFingerprint(value) !== value.applied_version) return bad();
    return value;
  }
  if (typeof b.replayed !== 'boolean') return bad();
  return b as unknown as Omit<SyncWordPressDraftResult, 'outcome'>;
}
