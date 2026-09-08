# Newsroom media bridge implementation

Production media-authority extension of the Newsroom Bridge WordPress plugin
(Round 2B.3C), plus the Node.js backend media adapter. The media boundary is
deliberately separate from the draft boundary approved in Round 2B.3A.

**Production status: NO-GO.** The plugin and adapter may be validated only in
disposable local/staging runtimes and must never be deployed until the
supervisor approves the full Round 2B sequence.

## Design source

The media authority architecture was designed and proven in Round 2B.3B
(disposable proof only). See `docs/WORDPRESS_MEDIA_AUTHORITY_DESIGN.md` for the
authority rules, canonical KAT vectors, crash windows, and GC semantics. This
document describes the production implementation of that design.

## Scope

| Artifact | Purpose |
| --- | --- |
| `wordpress/newsroom-bridge/newsroom-bridge.php` | Production loader (activates draft + media boundary) |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-config.php` | Validated read-only view of deployment security config |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-service-user.php` | Media service identity lockdown |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-auth.php` | HMAC request authentication + request-binding guard |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-db.php` | `wp_newsroom_media` schema + transactional row ops |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-reconciliation.php` | Reservation-first idempotent media lifecycle |
| `wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-rest.php` | REST surface, upload-dir scoping, hourly orphan GC |
| `apps/api/src/modules/wordpress-media/` | NestJS `wordpress-media` adapter + HMAC signer + client |
| `apps/api/tsconfig.wordpress-media-harness.json` | Harness TypeScript build for the runtime suite |
| `wordpress/runtime/media-implementation/` | Disposable integration runtime suite (32 evidence groups) |

## Authority boundary

The media boundary borrows the draft boundary's fail-closed posture:

- Any request carrying a media header, or targeting the media namespace, is
  authenticated exclusively by `Newsroom_Bridge_Media_Auth` (`rest_authentication_errors`
  priority 120) and rejected unless every check passes.
- Rejections (401) are issued for: non-whitelisted routes, any query string,
  method override, an `Authorization` header, an authentication cookie, or an
  already-authenticated user. A media-identity request may never piggyback on
  generic WordPress credentials.
- The media service user is locked down: REST and XML-RPC generic logins are
  rejected (`403` XML-RPC fault) and application passwords are denied for the
  media user.
- Draft and media headers are mutually exclusive; a request mixing media and
  draft headers is rejected.
- Ordinary WordPress authors are unaffected when no media header/route is
  involved.

## HMAC protocol

Version header value is `1`; clock skew window is ±300 seconds.

Request headers:

- `X-Newsroom-Media-Auth-Version`
- `X-Newsroom-Media-Key-Id`
- `X-Newsroom-Media-Timestamp`
- `X-Newsroom-Media-Signature`
- POST only: `X-Newsroom-Media-Key`, `X-Newsroom-Media-Filename`, `X-Newsroom-Media-Mime`

Canonical string (`newsroom-media-hmac-v1`):

```
newsroom-media-hmac-v1
{key_id}
{METHOD}
{route}
{timestamp}
{media_key}
{filename_sha256_or_dash}
{mime_or_dash}
{body_sha256}
```

`filename_sha256` = lowercase hex SHA-256 of the filename; for GET requests the
filename and MIME fields are `-`. Signature = lowercase hex
`HMAC-SHA256(canonical, key_secret)` where the key secret is the decoded
32-byte value from the configured key ring.

### KAT vector (frozen)

keyId `media-local-v1`; timestamp `1750000000`; mediaKey
`01234567-89ab-47cd-8e01-23456789abcd`; filename `hero.png`; MIME `image/png`;
body = PNG magic + `FIXTURE-BYTES`.

- POST signature `3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd`
- GET signature `d8f7a00fd0a1121e25dad834884e8bb90f15aae170e301d079573d19b6299238`

## Deployment configuration

The media boundary is fail-closed: media-header traffic is rejected unless a
valid production configuration is present. Constants:

| Constant | Meaning |
| --- | --- |
| `NEWSROOM_BRIDGE_MEDIA_USER_ID` | ID of the media service user |
| `NEWSROOM_BRIDGE_MEDIA_HMAC_ENABLED` | `true` to require HMAC authentication |
| `NEWSROOM_BRIDGE_MEDIA_SERVICE_LOCKDOWN_ENABLED` | `true` to lock the media identity |
| `NEWSROOM_BRIDGE_MEDIA_HMAC_KEYS_JSON` | JSON key ring (`[{"id": "...", "secret": "..."}]`, 43-char base64url secrets decoding to 32 bytes) |
| `NEWSROOM_BRIDGE_MEDIA_MAX_BYTES` | Body byte limit (default 500000) |
| `NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED` | `true` for redacted security event logging |

Schema option `newsroom_bridge_media_schema_version` fixed at `1`; table
`wp_newsroom_media` is installed by the production activation hook.

## REST surface

- `POST /wp-json/newsroom-media/v1/media` — create/reserve; body is raw octets
  with `Content-Type: application/octet-stream`. 201 created, 200 reserved or
  replayed, 409 idempotency conflict, 413 too large, 400 validation, 401/403
  authority, 503 not ready.
- `GET /wp-json/newsroom-media/v1/media/{media_key}` — deterministic lookup:
  attachment DTO 200, reserved 200, 404 missing, 401/403 authority.

Supported MIME: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.

Media-managed files are written under
`{uploads_basedir}/{year}/{month}/newsroom-media/` via the `upload_dir` filter,
isolated from ordinary upload storage.

## Orphan garbage collection

Run on demand while a verified media request is served, gated by the transient
`newsroom_bridge_media_gc_gate` (one pass per hour):

1. Adopt reserved rows whose media can be completed.
2. Remove orphan attachments (media-linked file without a live media key).
3. Remove scoped files without a live attachment reference.

## Node adapter

`apps/api/src/modules/wordpress-media/` provides:

- `wordpress-media-hmac.ts` — canonical signing, key-ring parsing, secret
  decode (the signer decodes the configured secret to bytes before signing).
- `wordpress-media.client.ts` — `WordPressMediaClient` with bounded retries,
  replay/conflict classification, and MIME/filename validation. The client
  `validateCreateInput` uses `mimeType`; local `upload()` maps `mime` to
  `mimeType` and `fingerprint()` takes `mime`.
- `.spec.ts` files and `.types.ts`/`.errors.ts` mirror the draft adapter
  conventions.

## Validation

- Disposable runtime suite
  `wordpress/runtime/media-implementation/run-media-implementation-tests.mjs`:
  32/32 green against the production plugin (activation/schema, KAT, positive
  create, replay, conflict, 401/403 authority, payload/content validation,
  cross-route rejection, XML-RPC isolation, no-generic-auth, uncertainty
  recovery, reserved/stale reclaim, concurrency, three GC passes, secret
  scanning, final integrity).
- Backend draft adapter regression
  `wordpress/runtime/backend-draft-adapter/` remains 15/15 green; its
  activation assertion now expects both newsroom tables after activation
  (`wp_newsroom_media` + `wp_newsroom_reconciliation`).
- The Round 2B.3B authority-proof harness reports 6/7 under the current
  loader: its one failure (`create_media_201`) is a deterministic harness
  artifact — the proof stack does not feed the production
  `NEWSROOM_BRIDGE_MEDIA_*` deployment config, so the production boundary
  fail-closes the prototype surface as designed; the same production loader
  passes the full 32-group suite when configured. Production media authority
  and positive paths are therefore validated exclusively by the 32-group
  production suite.