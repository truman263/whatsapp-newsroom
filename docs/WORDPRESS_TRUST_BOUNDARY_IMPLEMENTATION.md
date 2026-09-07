# WordPress trust-boundary implementation

## 1. Status and implementation scope

Round 2B.2B implements the supervisor-approved Round 2B.2A Option C design in local production-quality Newsroom Bridge source. It adds route-scoped HMAC authentication, identity-scoped generic-credential lockdown, reduced-service-user policy validation, temporary request authority, and local disposable validation. It does not deploy, access Simbidzebasa, implement backend code, upload media, or grant publication authority.

**Status: CURRENT — implementation under supervisor review.** Overall Round 2B remains pending.

## 2. Files and classes

- `class-newsroom-bridge-key-ring-json.php` preserves JSON structure while accepting only the key-ring schema, including duplicate-member detection.
- `class-newsroom-bridge-security-config.php` validates strict configuration values and complete key rings.
- `class-newsroom-bridge-service-user.php` enforces identity-scoped password/Application Password lockdown and the capability policy.
- `class-newsroom-bridge-auth.php` validates direct REST HMAC requests without granting user authority, wraps only the frozen bridge handlers, restores each temporary authority period in `finally`, blocks nested dispatch while authority is active, and emits optional safe logs.
- `newsroom-bridge.php` loads and registers the focused components.
- `wordpress/runtime/trust-boundary-implementation/` is a new disposable harness mounting the production plugin read-only. Its probe is test-only and does not implement authentication.

The approved database, reconciliation, and REST controller classes are unchanged.

## 3. Plugin and schema versions

Plugin version is `1.1.0`. Reconciliation schema version remains `2`; this round adds no tables, columns, meta, secret options, nonce ledgers, settings pages, or migrations.

## 4. Configuration constants

Protected `wp-config.php` or equivalent deployment configuration supplies:

- `NEWSROOM_BRIDGE_USER_ID`: positive service-user ID, matching the existing bridge identity.
- `NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED`: literal boolean.
- `NEWSROOM_BRIDGE_HMAC_ENABLED`: literal boolean.
- `NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON`: JSON list of exact key-ID/secret entries.
- `NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED`: optional literal boolean; logging defaults off.

Secrets are not sourced from or persisted to WordPress database storage. The plugin generates no secret.

## 5. Staged enablement model

Absent or literal-false HMAC configuration leaves the existing bridge authentication behavior in place and establishes no HMAC context. Explicit lockdown can be enabled independently. HMAC success requires both HMAC and lockdown to be literal `true`, a valid matching user, a completely valid nonempty key ring, and a valid service policy.

When HMAC is enabled, either security flag is malformed, or lockdown is explicitly enabled, service lockdown is effective for a resolvable configured identity. HMAC with disabled or malformed explicit lockdown still fails. This prevents a configuration error from producing simultaneous generic and route-scoped service authority.

## 6. HMAC pipeline

An early authentication filter snapshots prior user, Authorization, and WordPress-cookie conflicts before core REST cookie handling can clear them. The final authentication filter validates positive route/method scope, complete configuration, overrides/query, body/media contract, prior authentication conflict, exact header grammar, integer/timestamp safety, key lookup, raw body, HMAC signature, service identity, capability policy, and Application Password unavailability. It creates a one-request proof bound to the actual top-level request's immutable facts and establishes no service user.

## 7. Service-user lockdown

The service identity is selected only by the configured positive user ID. `authenticate` denies successful password authentication for that identity without disabling login or XML-RPC globally. `wp_is_application_passwords_available_for_user` returns false only for that identity while effective lockdown is active. Existing records are not deleted automatically; controlled migration must revoke and verify them separately.

## 8. Capability validation

Every HMAC request requires `read` and `edit_posts`. It rejects the full approved set covering publication, editing others/published/private content, deletion, media, taxonomy management, options, users, plugins, themes/files, unfiltered HTML, and network administration. A multisite super administrator is rejected. The plugin observes and enforces; it never assigns roles or capabilities.

## 9. Current-user context

The endpoint filter wraps only the frozen bridge permission and route callbacks. Each wrapper revalidates the proof, request method/route/body/headers/parameters/external representation, configuration, and service policy. It then captures the prior user, marks authority execution active, establishes the reduced service identity, invokes the original callback, and restores the prior user and clears execution state in nested `finally` blocks. Normal returns, `WP_Error`, and `Throwable` paths were exercised in-process. Response filters are used only as proof-disposal fallbacks and never for user restoration. No cookie, session, nonce, Application Password, or persistent authentication state is created.

While either wrapped callback holds service authority, `rest_pre_dispatch` rejects every nested server dispatch with the generic HTTP 401 response. Tests cover the same unchanged request recursively, the same object with mutated route and method, a different core request, and an unrelated plugin route. The bridge's direct internal `WP_REST_Posts_Controller` call is not a nested server dispatch and remains available.

## 10. Safe logging

Logging is disabled unless explicitly enabled. Structured records contain only component/event, protocol version, a grammar-validated key ID, route category, result category, and timestamp-skew category. They omit secrets, signatures, authorization values, passwords, Application Passwords, cookies, raw bodies, and article content. External errors never expose internal categories.

## 11. Key-ring handling

The focused parser accepts only a nonempty top-level JSON array. Every entry must be an object containing exactly one string `id` and one string `secret`; numeric-key objects, duplicate or escaped-duplicate members, missing/extra members, trailing data, and malformed secondary entries reject the complete ring before lossy associative decoding. Key IDs use 1–64 lowercase ASCII letters/digits/dot/underscore/hyphen with an alphanumeric first character. Secrets use exactly 43 unpadded base64url characters, strict decoding to 32 bytes, and identical canonical re-encoding. Selection is exact; there is no literal-secret fallback.

## 12. No-database-secret qualification

Production code contains no persistence call for HMAC material and exposes no secret route, UI, diagnostic, option, transient, or meta field. Local validation enumerated 13 disposable WordPress tables and searched 56 character/text/binary columns for the exact encoded and decoded key, with database errors treated as failures. It also searched an explicit 21-file approved artifact list that excludes root `.env` files without opening them. This evidence does not cover process memory, external caches, administrators, hosts, or secret managers.

## 13. Local implementation proof

The final source-audit suite ran from `2026-09-07T05:54:18.706Z` through `2026-09-07T06:06:54.339Z` against loopback-bound WordPress 7.1, PHP 8.2.33, MariaDB 10.11.19, and WP-CLI 2.12.0 using immutable image digests. All 20 evidence groups passed, including 31 exact-401 protocol negatives with durable snapshots, exact deterministic ±300/301 timestamp boundaries, cookie conflicts, strict JSON escape regressions, nested attacks, and in-process restoration. The harness mounted the production plugin read-only and never mounted the Round 2B.2A authentication shim. This is local pre-supervisor evidence.

## 14. Reconciliation regression evidence

The validation matrix passed first create, deterministic GET recovery, identical replay, changed-payload conflict, exact post/category/mapping postconditions, twenty identical concurrent requests, and twenty conflicting concurrent requests. Identical concurrency produced exactly one HTTP 201 and nineteen HTTP 200 responses, zero other statuses, one shared positive post ID, one post/mapping, a null token, and the independently calculated payload hash. Conflicting concurrency produced exactly one HTTP 201, nine HTTP 200, ten HTTP 409, zero other statuses, one mapped post, a null token, and a durable hash calculated from the winner identified by the unique 201 response. A subsequent losing retry returned 409 without changing the mapping or post.

## 15. Security test matrix

The harness passed activation/inert schema behavior; strict duplicate-preserving key-ring parsing and malformed escape/Unicode cases; the complete absent/false/true/malformed lockdown truth table; positive/negative service capabilities; password, Application Password, cookie, and XML-RPC behavior; valid HMAC POST/GET; raw-body and Content-Type rules; timestamps; tampering; core REST/media/credential/batch isolation with durable snapshots; embedded batch behavior; five nested dispatch attacks; seventeen restoration/binding cases including engine errors and user-context hooks; ordinary-user non-regression; 23 logging sentinels with zero matches; fail-closed database and approved-file secret searches; exact concurrency including an executable rejection of the former 1×201 + 10×409 + 9×500 false-positive vector; and strict cleanup. Durable snapshots cover posts, post meta, terms, term taxonomy/meta/relationships, reconciliation rows, and credential identities. Teardown and both project-label residue queries exited 0, no project containers or volumes remained, and `.env.runtime` was absent.

## 16. Production migration prerequisites

1. Obtain supervisor approval for source and disposable evidence.
2. Review active production hooks, storage engines, caches, and deployment integrity.
3. Create/assign the reduced service role using separately authorized administration.
4. Deploy code inert, then configure and prove identity-scoped lockdown.
5. Verify legacy password and every Application Password fail through REST, XML-RPC, and interactive surfaces.
6. Provision the HMAC key from a protected secret manager and validate only an approved harmless reconciliation GET.
7. Revoke legacy Application Password records and verify a zero final count.
8. Prove CDN/proxy preservation and duplicate rejection for auth and Content-Type headers, exact raw body, method, and path.
9. Seek separate authorization before any production draft write.

## 17. Rollback considerations

Code rollback and authority rollback are different. On a hardening incident, stop newsroom writes, disable HMAC operation if required, preserve generic-credential lockdown and reconciliation data, investigate, and redeploy approved code. Do not automatically recreate an Application Password, re-enable the service password, broaden the role, or treat generic credential restoration as safe rollback.

## 18. Unresolved production risks

- Production CDN/proxy duplicate-header rejection and byte preservation are unproven.
- Active hooks, nontransactional effects, DDL, transaction interference, and persistent caches require production-specific review.
- Clock synchronization, secret rotation, monitoring/rate limits, incident response, and deployment integrity require operational proof.
- Credential migration rehearsal remains required before any production change.
- Abnormal process/host/Docker failures can interrupt disposable cleanup and require operator residue verification.
- Media idempotency and authority remain unresolved; publication remains separately unresolved and unimplemented.

## 19. Production decision

**PRODUCTION NO-GO.** Evidence remains local and the production prerequisites above remain unresolved. No production request or deployment is authorized by Round 2B.2B.

## 20. Next supervisor audit requirements

Supervisor review must cover configuration parsing, effective-lockdown semantics, positive route scope, raw request handling, signature comparison, context restoration/nested dispatch, identity-scoped filters, exact 401 behavior, log redaction, disposable evidence, immutable reconciliation hashes, production ingress prerequisites, migration order, and rollback separation. Round 2B.2B remains current until that review approves it.
