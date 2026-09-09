import { WordPressDraftError } from './wordpress-draft.errors';
import { canonicalStateJson, draftStateFingerprint, isDraftKey, isStateVersion, reconciliationFingerprint, reconciliationJson, syncPayload, validateStateResponse, type CanonicalDraftState } from './wordpress-draft-state';

const KEY = '550e8400-e29b-41d4-a716-446655440000';
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

const ASCII_VECTOR: CanonicalDraftState = { title: 'Hello "world" \\ done / now', content: 'Line one\nLine two', excerpt: '', categories: [1, 2, 3], featured_media_key: null };
const UNICODE_VECTOR: CanonicalDraftState = { title: 'héllo wörld λ 中文', content: 'body', excerpt: 'e', categories: [2, 5], featured_media_key: null };
const C1_007F_VECTOR: CanonicalDraftState = { title: 'a\u007Fb', content: 'body', excerpt: '', categories: [1], featured_media_key: null };
const C1_009F_VECTOR: CanonicalDraftState = { title: 'a\u009Fb', content: 'body', excerpt: '', categories: [1], featured_media_key: null };
const MIXED_VECTOR: CanonicalDraftState = { title: 'q\u007F\u009F\u2028\u2029w / λ', content: 'body / with slashes and \u2029', excerpt: '', categories: [1, 2, 3], featured_media_key: null };
const CONTROL_VECTOR: CanonicalDraftState = { title: '\u0000\t\n\u0008\u001F', content: 'backspace:\u0008 formfeed:\u000C', excerpt: '', categories: [1], featured_media_key: null };
const FEATURED_VECTOR: CanonicalDraftState = { title: 'With featured', content: 'body', excerpt: '', categories: [4, 7], featured_media_key: KEY };
const MULTI_CATEGORY_VECTOR: CanonicalDraftState = { title: 'Multi', content: 'body', excerpt: 'x\u2028y', categories: [1, 3, 4, 9], featured_media_key: null };

describe('wordpress-draft-state PHP byte parity', () => {
  it('ASCII with quotes/backslash/slash/newline matches PHP wp_json_encode exactly', () => {
    expect(hex(canonicalStateJson(ASCII_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a2248656c6c6f205c22776f726c645c22205c5c20646f6e65202f206e6f77222c22636f6e74656e74223a224c696e65206f6e655c6e4c696e652074776f222c2265786365727074223a22222c2263617465676f72696573223a5b312c322c335d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(ASCII_VECTOR)).toBe('6d84b7f0e61c2d0b129e7c10f59bf9ff32b9414efddd78128cacc25aeb66bd78');
  });

  it('Unicode is emitted as raw UTF-8 by both runtimes', () => {
    expect(hex(canonicalStateJson(UNICODE_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a2268c3a96c6c6f2077c3b6726c6420cebb20e4b8ade69687222c22636f6e74656e74223a22626f6479222c2265786365727074223a2265222c2263617465676f72696573223a5b322c355d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(UNICODE_VECTOR)).toBe('c8b814ff3acecf7dcd72534538375a80476e507433556d9cceea039108311fe3');
  });

  it('U+007F (DEL) is emitted raw, not escaped', () => {
    expect(hex(canonicalStateJson(C1_007F_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a22617f62222c22636f6e74656e74223a22626f6479222c2265786365727074223a22222c2263617465676f72696573223a5b315d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(C1_007F_VECTOR)).toBe('e7e25120de21882360b354a9471288b55471ce5194eaf7220fba199773f8b96f');
  });

  it('U+009F is emitted as raw two-byte UTF-8, not escaped', () => {
    expect(hex(canonicalStateJson(C1_009F_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a2261c29f62222c22636f6e74656e74223a22626f6479222c2265786365727074223a22222c2263617465676f72696573223a5b315d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(C1_009F_VECTOR)).toBe('be97509fa09b238715b1c8729c925eac3cb8080854b7d3893f9e261652615002');
  });

  it('escapes U+2028/U+2029 while leaving C1 bytes and Unicode raw (full canonical vector)', () => {
    expect(hex(canonicalStateJson(MIXED_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a22717fc29f5c75323032385c753230323977202f20cebb222c22636f6e74656e74223a22626f6479202f207769746820736c617368657320616e64205c7532303239222c2265786365727074223a22222c2263617465676f72696573223a5b312c322c335d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(MIXED_VECTOR)).toBe('21e71e038ff5c3447b871effe973d42cd28b0abce4eecbf98f3efef8c24a8976');
  });

  it('matches PHP short escapes for control characters (backspace/tab/nl/ff) and \\uXXXX for the rest', () => {
    expect(hex(canonicalStateJson(CONTROL_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a225c75303030305c745c6e5c625c7530303166222c22636f6e74656e74223a226261636b73706163653a5c6220666f726d666565643a5c66222c2265786365727074223a22222c2263617465676f72696573223a5b315d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(CONTROL_VECTOR)).toBe('c60988968331569bf18d1e82c64ff7332420f317ee203b9f970defc72367fe1e');
  });

  it('serialises a non-null featured media key exactly like PHP', () => {
    expect(draftStateFingerprint(FEATURED_VECTOR)).toBe('7bd223c4372512cef275d2428ee98e1bd771b0d967ffa2ec61039a0967cb77f5');
  });

  it('serialises a sorted multi-category set exactly like PHP', () => {
    expect(hex(canonicalStateJson(MULTI_CATEGORY_VECTOR))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a224d756c7469222c22636f6e74656e74223a22626f6479222c2265786365727074223a22785c753230323879222c2263617465676f72696573223a5b312c332c342c395d2c2266656174757265645f6d656469615f6b6579223a6e756c6c7d');
    expect(draftStateFingerprint(MULTI_CATEGORY_VECTOR)).toBe('b045dd535717f2087c0632e85a8e5292e7c0dc7c2623365d9d35a8555bf66ebe');
  });
});

describe('wordpress-draft-state reconciliation fingerprint', () => {
  it('excludes featured_media_key and matches the PHP payload vector', () => {
    const payloadState = { title: MIXED_VECTOR.title, content: MIXED_VECTOR.content, excerpt: MIXED_VECTOR.excerpt, categories: MIXED_VECTOR.categories };
    expect(hex(reconciliationJson(payloadState))).toBe('7b22636f6e74726163745f76657273696f6e223a312c227469746c65223a22717fc29f5c75323032385c753230323977202f20cebb222c22636f6e74656e74223a22626f6479202f207769746820736c617368657320616e64205c7532303239222c2265786365727074223a22222c2263617465676f72696573223a5b312c322c335d7d');
    expect(reconciliationFingerprint(payloadState)).toBe('9a70ef994c56fed8047463d70ee57add1a76db2f151f30c7f089ecf19d88a516');
  });

  it('reconciliation fingerprint never changes on a featured-only change while the state fingerprint does', () => {
    const base = { title: 'With featured', content: 'body', excerpt: '', categories: [4, 7] };
    const withA: CanonicalDraftState = { ...base, featured_media_key: '550e8400-e29b-41d4-a716-446655440000' };
    const withB: CanonicalDraftState = { ...base, featured_media_key: '550e8400-e29b-41d4-a716-446655440001' };
    expect(reconciliationFingerprint(withA)).toBe(reconciliationFingerprint(withB));
    expect(draftStateFingerprint(withA)).not.toBe(draftStateFingerprint(withB));
  });

  it('dedupes and numerically sorts categories before serialising', () => {
    const duplicate: CanonicalDraftState = { title: 'T', content: 'C', excerpt: '', categories: [2, 2, 5], featured_media_key: null };
    const deduped: CanonicalDraftState = { title: 'T', content: 'C', excerpt: '', categories: [2, 5], featured_media_key: null };
    expect(canonicalStateJson(duplicate)).toBe(canonicalStateJson(deduped));
  });
});

describe('wordpress-draft-state syncPayload', () => {
  it('returns a canonical payload with deduped sorted categories, default excerpt and null version', () => {
    const payload = syncPayload({ wordpressDraftKey: KEY, headline: 'Headline', body: 'Body', wordpressCategoryIds: [3, 1, 2, 3], featuredMediaKey: null });
    expect(payload).toEqual({ draft_key: KEY, title: 'Headline', content: 'Body', excerpt: '', categories: [1, 2, 3], featured_media_key: null, expected_version: null });
  });

  it('rejects unknown fields', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null, post_id: 1 } as never)).toThrow(WordPressDraftError);
  });

  it('rejects a non-canonical draft key', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY.toUpperCase(), headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects an empty title', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: '  ', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects an empty body', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: '  ', wordpressCategoryIds: [1], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects an empty category list', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects a non-integer category id', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1.5] as never, featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects a negative category id', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [-1], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects a non-string excerpt', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], excerpt: 5 as never, featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects a lone surrogate in the headline', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'bad \uD800 char', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null })).toThrow(WordPressDraftError);
  });

  it('rejects a non-canonical featured media key', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: 'not-a-uuid' })).toThrow(WordPressDraftError);
  });

  it('accepts a null featured media key', () => {
    expect(syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null }).featured_media_key).toBeNull();
  });

  it('rejects an invalid expected_version', () => {
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null, expectedVersion: 'ZZ' })).toThrow(WordPressDraftError);
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null, expectedVersion: 'A'.repeat(64) })).toThrow(WordPressDraftError);
    expect(() => syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null, expectedVersion: 'AB' })).toThrow(WordPressDraftError);
  });

  it('accepts a canonical lowercase 64-hex expected_version', () => {
    const version = 'a'.repeat(64);
    expect(syncPayload({ wordpressDraftKey: KEY, headline: 'H', body: 'B', wordpressCategoryIds: [1], featuredMediaKey: null, expectedVersion: version }).expected_version).toBe(version);
  });
});

describe('wordpress-draft-state validators', () => {
  it('isDraftKey accepts only canonical lowercase v4 UUIDs', () => {
    expect(isDraftKey(KEY)).toBe(true);
    expect(isDraftKey(KEY.toUpperCase())).toBe(false);
    expect(isDraftKey('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
    expect(isDraftKey('550e8400-e29b-51d4-a716-446655440000')).toBe(false);
    expect(isDraftKey(123)).toBe(false);
  });

  it('isStateVersion accepts exactly 64 lowercase hex chars', () => {
    expect(isStateVersion('a'.repeat(64))).toBe(true);
    expect(isStateVersion('A'.repeat(64))).toBe(false);
    expect(isStateVersion('a'.repeat(63))).toBe(false);
    expect(isStateVersion(null)).toBe(false);
  });
});

describe('wordpress-draft-state validateStateResponse', () => {
  const STATE_FIELDS = { title: 'T', content: 'C', excerpt: '', categories: [1, 2], featured_media_key: null };
  const applied = draftStateFingerprint(STATE_FIELDS);
  const validState = { draft_key: KEY, post_id: 42, status: 'draft', ...STATE_FIELDS, author_id: 2, applied_version: applied };
  const validSync = { draft_key: KEY, post_id: 42, status: 'draft', replayed: false, featured_media_key: null, applied_version: 'a'.repeat(64) };

  it('accepts a valid state response whose applied_version matches the fingerprint', () => {
    expect(validateStateResponse(validState, KEY, true).applied_version).toBe(applied);
  });

  it('rejects a state whose applied_version does not match the fingerprint', () => {
    expect(() => validateStateResponse({ ...validState, applied_version: 'a'.repeat(64) }, KEY, true)).toThrow(WordPressDraftError);
  });

  it('rejects a state with unsorted categories', () => {
    expect(() => validateStateResponse({ ...validState, categories: [2, 1] }, KEY, true)).toThrow(WordPressDraftError);
  });

  it('rejects a non-positive author_id', () => {
    expect(() => validateStateResponse({ ...validState, author_id: 0 }, KEY, true)).toThrow(WordPressDraftError);
  });

  it('rejects a non-draft status', () => {
    expect(() => validateStateResponse({ ...validState, status: 'publish' }, KEY, true)).toThrow(WordPressDraftError);
  });

  it('rejects a state for the wrong draft key', () => {
    expect(() => validateStateResponse(validState, '550e8400-e29b-41d4-a716-446655440001', true)).toThrow(WordPressDraftError);
  });

  it('rejects a state with extra fields', () => {
    expect(() => validateStateResponse({ ...validState, extra: true }, KEY, true)).toThrow(WordPressDraftError);
  });

  it('rejects a non-object response', () => {
    expect(() => validateStateResponse([1], KEY, true)).toThrow(WordPressDraftError);
    expect(() => validateStateResponse(null, KEY, true)).toThrow(WordPressDraftError);
  });

  it('accepts a valid sync response body', () => {
    expect(validateStateResponse(validSync, KEY, false).replayed).toBe(false);
  });

  it('rejects a sync response missing replayed', () => {
    const missing = { draft_key: KEY, post_id: 42, status: 'draft', featured_media_key: null, applied_version: 'a'.repeat(64) };
    expect(() => validateStateResponse(missing, KEY, false)).toThrow(WordPressDraftError);
  });

  it('rejects a sync response with a non-boolean replayed', () => {
    expect(() => validateStateResponse({ ...validSync, replayed: 'yes' }, KEY, false)).toThrow(WordPressDraftError);
  });

  it('rejects a sync response with an invalid applied_version', () => {
    expect(() => validateStateResponse({ ...validSync, applied_version: 'zz' }, KEY, false)).toThrow(WordPressDraftError);
  });

  it('rejects an invalid featured_media_key in a sync response', () => {
    expect(() => validateStateResponse({ ...validSync, featured_media_key: 'bad' }, KEY, false)).toThrow(WordPressDraftError);
  });
});