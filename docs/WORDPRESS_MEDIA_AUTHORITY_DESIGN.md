# WordPress Media Authority — Round 2B.3B Design and Disposable Proof

## 1. Status / scope

- Round 2B.3B produces a TEST-ONLY disposable media authority (prototype plugin under `wordpress/runtime/media-authority-proof/`) and a proof harness (`run-media-authority-proof-tests.mjs`). The proof is GREEN: 39/39 evidence groups PASS.
- Scope: media *authority* and *idempotent upload* design/proof only. No production plugin, no backend adapter, no deployment. Production WordPress source under `wordpress/newsroom-bridge/**` is FROZEN and byte-identical to the baseline (hashes verified before and after the proof).
- This document captures the design the proof exercises and the guidance Round 2B.3C must implement. It does NOT claim production validation.

## 2. Threat model

Identities with network access to a WordPress host may attempt to:

1. Upload/publish via the newsroom media service without a valid media signature.
2. Reuse the draft authority credential/key on the media route and vice versa (cross-authority reuse).
3. Use a generic WordPress credential (password, Application Password, cookie, XML-RPC) of the media service user.
4. Gain publication authority by escalating the media service role/capabilities.
5. Replay an identical media create (expected idempotent), inject a different payload under the same media key (conflict), or race concurrent creates.
6. Spoof filename, claimed MIME, payload size, or body content (path traversal, double extension, executable content, fake MIME).
7. Exploit upload/GC semantics to delete files outside the media-managed directory or leave orphans.
8. Obtain secrets via logs, database, webroot files, or repository artifacts.

The proof's in-scope countermeasures cover 1–7. Secret handling (8) is covered by the no-secret evidence groups and the secrets audit.

## 3. Separate media authority rationale

- The draft authority (Round 2B.2B) is already approved and frozen. Extending it to media would couple two different payload/body semantics (JSON draft vs raw binary octet-stream) and two different idempotency contracts into one canonical.
- Media requires additional authenticated metadata (filename, MIME, media key) that the draft canonical does not carry.
- Separation gives independent key rotation, independent service identity per capability set (`upload_files` without `edit_posts`), and a crisp authorization boundary testable in isolation.

## 4. Transport alternatives considered

| Alternative | Assessment |
|---|---|
| WordPress core `wp/v2/media` with Application Passwords | Requires `upload_files` via a generic credential path; no idempotent media-key contract; App Password belongs to the generic credential model we are removing. Rejected. |
| Draft authority route extended to media | Couples JSON draft canonical to binary media; muddies key/identity separation. Rejected. |
| Dedicated `newsroom-media/v1` REST namespace + media canonical HMAC + `wp_upload_bits` pipeline | Chosen: mirrors the proven draft pattern, independent key ring/headers/identity, deterministic media-key idempotency. |

## 5. Selected transport

- REST under namespace `newsroom-media/v1` on the same WordPress host, HTTP/1.1.
- Routes (registered on `rest_api_init` — the same timing the frozen bridge uses; registration during `plugins_loaded` forces premature REST server construction and fatals on `$wp_rewrite`):
  - `POST /newsroom-media/v1/media` — create.
  - `GET /newsroom-media/v1/media/{media_key}` — reconciliation lookup (UUIDv4 shape).
- Body: raw `application/octet-stream`; signature covers the byte-exact body hash. GET carries no body.

## 6. Final canonical media HMAC (frozen)

Nine fields, LF-joined, no trailing LF, UTF-8:

```
newsroom-media-hmac-v1
{key_id}
{UPPERCASE_METHOD}
{concrete_route}
{timestamp}
{media_key}
{sha256(filename) | '-'}
{claimed_mime | '-'}
{sha256(exact_raw_body)}
```

- Signature: lowercase-hex HMAC-SHA-256 over the canonical using the 32-byte decoded key secret.
- Version marker `v1` is part of the canonical. A version change changes the canonical (and thus every signature).
- `filename` and `mime` are hashed/constant on POST, `-` on GET; body hash is `e3b0c442...855` on GET.
- Clock window: ±300 s (`MAX_CLOCK_SKEW`).

## 7. Exact signed fields (nothing security-relevant is unsigned)

Authenticated by the canonical and enforced on the wire:

- protocol version, key id, method, concrete route (exact, no query string, no trailing slash), timestamp, media key, filename (POST), claimed MIME (POST), exact body bytes.
- Content-Length is NOT client-claimed: the server derives byte length from the body it reads; it is stored for evidence only, never trusted for framing.
- Any request that carries media-authority headers on a non-media route, a query string, a method override, an Authorization header/cookie, or an already-authenticated user is rejected with 401 before any pipeline work.

## 8. Media key semantics

- A single media key represents exactly one logical media object for its lifetime.
- Deterministic, client-generated UUID v4; must be a valid RFC-4122 v4 GUID (validated server-side).
- Once a row exists for the key: same fingerprint → replay; different fingerprint → 409 conflict; key is immutable thereafter (no overwrite).
- A key freed by `during_metadata` cleanup or expired-reservation recovery can be reused with a fresh deterministic create.

## 9. Service user / capability model

Media identity is user id 3 (`runtime_media_service`), role `newsroom_media_service`:

- Required capabilities (proven live): `read`, `upload_files`.
- Proven absent: `edit_posts`, `publish_posts`, `edit_others_posts`, `edit_published_posts`, `edit_private_posts`, `delete_*`, `manage_categories`, `manage_options`, user/plugin/theme/network administration, `unfiltered_html`, `activate_plugins`.
- Application Passwords are disabled for the media identity; generic password login (REST and XML-RPC) is denied; privilege creep (e.g., adding `manage_options` live) is rejected with 401 until restored.
- Draft identity (user 2) does NOT have `upload_files`; media identity has no draft/publication authority. Proven disjoint.

## 10. MIME / filename / size policy

Allow-list (server-side constant): `image/png`, `image/jpeg`, `image/webp`, `image/gif`.

Pipeline (rejected with 400 unless stated):

1. Filename: printable-ASCII only, no `/`, `\`, `,`, no leading dot, not `.`/`..`, max 255 bytes, then WordPress `sanitize_file_name()`.
2. Extension of the sanitized filename must match the claimed MIME.
3. Claimed MIME must match the content detected via `getimagesizefromstring()` on the raw body.
4. Body size: empty → 400; > `TEST_MEDIA_MAX_BYTES` (500 000 in proof) → 413; valid large image (≈200 KB in proof) → 201.
5. AFTER the file is written by `wp_upload_bits()`: WordPress-native `wp_check_filetype_and_ext()` against the REAL on-disk file — detects content/MIME mismatch and spoofed extensions (`proper_filename` re-check currently explicit: native result MIME must equal claimed MIME). On failure the file and reservation row are removed and 400 returned.
6. Uploads are isolated into `wp-content/uploads/{year}/{month}/newsroom-media/` via an `upload_dir` filter so the proof (and future GC) reasons about a scoped directory.
7. Thumbnails/derived files produced by `wp_generate_attachment_metadata()` (with `wp-admin/includes/image.php` loaded, as core's media endpoint does) land in the same scoped directory and are recognised by GC.
8. Executable/PHP content cannot pass: claimed MIME must be image/*, detected MIME must equal claimed, and the final extension must equal the claimed MIME's extension.

## 11. Reconciliation table

Disposable table `wp_newsroom_media` (proof schema, not a production migration):

| column | meaning |
|---|---|
| `media_key` | PK, CHAR(36). |
| `attachment_id` | nullable, UNIQUE; set only on commit. |
| `payload_hash` | deterministic fingerprint `sha256("media-payload-v1\n{HASH}\n{filename-sha256}\n{mime}")`. |
| `content_length` | server-observed byte length. |
| `actor_user_id` | media service user id. |
| `reservation_token` | nullable; present while in progress; cleared on commit. |
| `created_at/updated_at` | UTC timestamps; `updated_at` drives stale-reservation reclamation. |

## 12. Reservation semantics

- Create flow first inserts a reservation row via a single atomic `INSERT` (PK on `media_key`). Exactly one request wins; losers see a duplicate-key failure.
- Winner owns the key and carries a fresh UUID reservation token.
- Every state-changing store mutation is bounded by the token and returns success only when EXACTLY ONE row was affected (`1 === (int) $wpdb->query(...)`). (An earlier false-positive truthiness bug — `false !== 0` — was found by the concurrency proof and fixed.)
- A reservation whose `updated_at` is older than 30 s may be reclaimed atomically by a matching-fingerprint request (`UPDATE ... WHERE media_key=? AND reservation_token=? AND updated_at < cutoff`).

## 13. Idempotency behaviour

- Same key + same fingerprint → deterministic single logical media object; replay responses return `status: "attachment"`, `replayed: true`, and the SAME `attachment_id`.
- One reconciliation row, one winning attachment, no duplicate managed upload, same payload hash, no reservation token after success (all asserted by the proof).
- A request that cannot obtain ownership within bounded retries receives 503 `newsroom_media_reservation_in_progress`, which the client may retry.

## 14. Replay / conflict behaviour

- Replay (identical fingerprint): 200 with the committed attachment id.
- Conflict (same key, different fingerprint): 409 `newsroom_media_idempotency_conflict`; row, payload hash, and attachment are immutable.
- Concurrent identical: exactly one CREATED + N REPLAYED sharing one attachment id (proof asserted).
- Concurrent conflicting: exactly one deterministic winner; loser returns 409 (proof asserted).

## 15. Filesystem semantics

- The proof writes exactly one uploaded file per committed row; its content hash equals the signed raw body hash.
- SQL rollback does NOT roll back filesystem writes. The design therefore separates the IDEMPOTENT LOGICAL MEDIA RESULT (guaranteed by the reconciliation row) from ORPHAN RECOVERY (garbage collection, eventually consistent, bounded by the GC probe).
- On validation/filetype failure the just-written file is deleted before returning 400.

## 16. Crash / fault-window matrix (proven)

| phase | DB observable | FS observable | recovery |
|---|---|---|---|
| after reservation | row reserved | none | GET 200 `reserved`; stale reclaim → fresh deterministic create |
| after file write | row reserved | orphan file present | GC deletes orphan file; stale reclaim → fresh create |
| after attachment insert | row reserved, attachment+meta exist | file present | GC ADOPTS attachment into the row; GET returns attachment |
| during metadata | clean self-delete (row+attachment+file removed) | none | GET 404; retry is a fresh deterministic create |
| after mapping commit | durable committed row | file present, referenced | GET returns attachment; no GC action |
| after success, response lost | committed | file present | GET recovery only; NO duplicate POST |

- `after_reservation`, `after_file`, `after_insert`, `during_metadata`, `after_mapping` are proven via injected fault phases that crash the PHP worker mid-request. Response loss / uncertain-response windows are proven via a TCP proxy that drops POST deliveries and mangles responses.

## 17. Orphan attachment handling

- Pass 2 of GC: any attachment carrying `_newsroom_media_key` meta whose key has no reconciliation row is orphaned → its managed file is deleted and the attachment is force-deleted.
- Only attachments carrying the media meta are eligible; ordinary WordPress attachments are never touched.

## 18. Orphan file handling

- Pass 3 of GC: files inside the scoped media upload directory that are not referenced by `_newsroom_media_file` or `_wp_attached_file`, and are not derived thumbnail files of a referenced base, are deleted.
- GC only ever scans/deletes inside the media-managed sub-directory; non-managed filesystem paths are never touched. (Production must re-scope the upload root per `filter_upload_dir`.)

## 19. GC / adoption rules

- Pass 1: a reserved row with an attachment that claims the media key is ADOPTED: the row's token is refreshed and the attachment is committed.
- Passes run in order; a final GC on the live proof reports zero leftover attachments/files.
- GC is eventually consistent (probe-driven, disposable); production will schedule it idempotently. It is NOT what makes idempotency safe — the reservation row is.

## 20. Concurrency behaviour

- Single atomic reservation INSERT arbitrates identical and conflicting concurrency; stale reclamation is an atomic conditional UPDATE.
- No blind double-insert of attachments can occur once ownership is correctly bounded by affected-rows checks (this was the defect the concurrency proof caught and the fix the store applies).

## 21. Uncertain POST recovery

- Any non-2xx/non-client-4xx response, connection failure, or worker death is treated as UNCERTAIN, never as success or failure.
- The client then runs bounded signed GET reconciliation (up to 3 attempts).

## 22. Response-loss recovery

- After a committed upload, if the POST response is lost, GET returns the committed attachment with `replayed: false`; the client recovers WITHOUT a second POST (proxy proof: `POST count == 1`, `GET count == 1`).

## 23. True-not-created retry

- If GET returns 404 and the POST was actually undelivered, the client sends exactly ONE fresh-signed POST retry (proxy proof). A delivered POST that crashed mid-flight leaves a reservation, so the retry POST path still converges to a single attachment.

## 24. GET-uncertain no-blind-retry behaviour

- If the reconciliation GET itself is uncertain (network error, mangled body, unavailable), the client NEVER blind-posts a second create; it reports UNCERTAIN_OUTCOME and waits for operator/next-pipeline decision (proxy proof).

## 25. Draft/media cross-authority isolation (proven)

- Draft credential on media route → 401; media credential on draft route → 401; media credential on `wp/v2/media`, `wp/v2/posts`, batch, and XML-RPC → 401/(403 XML-RPC fault); media identity publishing impossible.

## 26. Generic credential isolation (proven)

- Locked service identities: no Application Passwords, no HTTP basic/XML-RPC password login, no cookie fallback. Ordinary author users are unaffected (media upload 201, post create 201, XML-RPC login OK).

## 27. Backend implementation guidance for Round 2B.3C

Production implementation (later round) must mirror the proven contract:

1. Register media routes on `rest_api_init`; keep global filters on `plugins_loaded`.
2. Load `wp-admin/includes/image.php` before `wp_generate_attachment_metadata()` on the REST path.
3. Validate: filename format → extension↔MIME → body `getimagesize` → size limit → write → native `wp_check_filetype_and_ext` against the real file; on failure delete file+row.
4. Reservation-first idempotency with `1 === affected-rows` ownership semantics; 30 s stale window tunable.
5. Isolate uploads under a media-scoped sub-directory; GC scoped to that directory; never touch non-managed paths.
6. Use the exact canonical (section 6), KAT in section 28, and the media service capability model (section 9).
7. Keep a `uncertain` client state machine: reconcile via GET; 404 → single retry; GET-uncertain → no blind retry.
8. Reject any request with media headers outside the media namespace, query strings, method overrides, Authorization headers, or pre-authenticated users.
9. Maintain draft/media key-ring separation and rotation.

## 28. Canonical KAT (frozen vector, matches PHP and Node builders)

- secret (base64url): `BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc` → 32 bytes; key id: `media-local-v1`.
- timestamp: `1750000000`; POST route: `/newsroom-media/v1/media`.
- media key: `01234567-89ab-47cd-8e01-23456789abcd`; filename `hero.png` (sha256 `290617ed3bab229d65d4f128ba0956bc68fd773814a6537d376fea89c4743eb6`); mime `image/png`.
- body = PNG magic + `FIXTURE-BYTES`; body sha256 = `78ced3511f8d2005e2193fc28699dd0e80282fa5ab11a5e7c0161e2bb55396f2`.
- POST signature: `3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd`.
- GET canonical (route `/newsroom-media/v1/media/01234567-89ab-47cd-8e01-23456789abcd`, media key from route, `-`/`-`, empty-body hash `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`): GET signature `d8f7a00fd0a1121e25dad834884e8bb90f15aae170e301d079573d19b6299238`.

## 29. Logging / redaction

Security events log only: component, event type, protocol version, key id (a non-secret identifier), route category, result, skew category. No secrets, signatures, bodies, filenames, or raw payloads are logged (proof-inspected docker logs + webroot grep). Test vectors in this document are NON-SECRET static constants, not runtime credentials.

## 30. Production ingress unknowns

- Real-world TF set to 500 000 bytes in the proof; production must fix a value consistent with WordPress limits and image pipeline.
- Production broken-authenticator/rate-limit/edge behaviour at a real ingress (CDN, WAF, reverse proxy) is not exercised by the local proof.
- Whether an existing Simbidzebasa media pipeline, other plugins, or object-storage/offload plugins intercept `wp_upload_bits`/`upload_dir` is NOT known; the design assumes stock `wp_upload_bits` semantics.

## 31. Persistent-storage/cache unknowns

- The proof uses stock MariaDB/MySQL with autocommit. Object cache layers, read replicas, or multi-node WP were not exercised; production must ensure the reconciliation table is read/written consistently and that `get_option`/`wp_cache` do not serve stale reservation state.

## 32. Key rotation

- Media keys are distinct from draft keys. Rotation = add new id/secret pair to `TEST_MEDIA_HMAC_KEYS_JSON` (production: env/secret manager), retire old after timestamp-window AND reconciliation quiescence. Old secrets must remain accepted until all in-flight media reconciles; nothing in the proof requires realtime cross-key invalidation.

## 33. Deployment prerequisites (for Round 2B.3C, not yet planned)

- Supervisor approval of this design + production migration/schema plan; frozen production bridge remains untouched; media plugin added as a SEPARATE plugin/namespace; secrets injected via env/secret manager, never in repo; media table migration reviewed; GC scheduled idempotently; retry/uncertain handling wired into the backend adapter.

## 34. Production NO-GO

Nothing in this round may be deployed. Production WordPress source is frozen; the media prototype is disposable and TEST-ONLY. Deployment of media authority requires a later approved round.