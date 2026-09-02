# WordPress newsroom trust-boundary design

## 1. Problem statement

Round 2B.1 proved that a WordPress Author Application Password is a generic WordPress credential. Its holder could bypass Newsroom Bridge and mutate core resources directly. A promise that the backend will call only the bridge is not a security boundary.

Round 2B.2A therefore requires a credential whose meaning WordPress restricts to approved newsroom routes. This document records a disposable local proof and a proposed architecture. It is **not production implementation, deployment, or validation**.

## 2. Round 2B.1 evidence

The approved Round 2B.1 runtime showed that the integration Author's Application Password could create both drafts and published posts through `wp/v2/posts`. Direct publication bypassed reconciliation and any external approval workflow and was classified as a **PRODUCTION TRUST-BOUNDARY BLOCKER**.

The production bridge remains source-approved for deterministic draft creation and reconciliation. It uses the current WordPress user, performs normal core controller permission checks, forces `post`/`draft`/current author, assigns existing categories, and exposes only:

- `POST /wp-json/newsroom/v1/drafts`
- `GET /wp-json/newsroom/v1/drafts/{draft_key}`

Its `wordpressDraftKey` mapping remains the durable create-idempotency contract. The flaw is the generic credential used to establish that WordPress user, not the bridge's draft contract.

## 3. Mandatory invariants

1. The newsroom backend holds neither a WordPress Application Password nor the service user's WordPress password.
2. Draft credentials are meaningless to core REST, XML-RPC, `wp-login.php`, and Application Password management.
3. Draft credentials authorize only the two approved newsroom operations.
4. The unchanged deterministic `wordpressDraftKey` reconciliation contract remains mandatory.
5. Publication authority is separate and is not implemented in Round 2B.2A.
6. Human administrators, editors, authors, REST clients, and XML-RPC clients remain unaffected unless a later approved policy says otherwise.
7. WordPress enforces scope; client cooperation is never the control.
8. Missing configuration, identity drift, capability drift, ambiguous routing, or authentication conflict fails closed.

## 4. Current authenticated attack surface

The disposable WordPress 7.1 baseline used the same Author model as Round 2B.1. A locally generated Application Password produced:

| Surface | Observed result |
|---|---|
| Core REST draft create | HTTP 201 |
| Core REST update of own post | HTTP 200 |
| Core REST autosave | HTTP 200 |
| Core REST publication | HTTP 200 |
| Revisions read | HTTP 200 |
| Revision deletion | HTTP 403 `rest_cannot_delete` |
| Core REST post deletion | HTTP 200 |
| Core REST media upload | HTTP 201 |
| REST batch containing post create | Outer HTTP 207; inner create HTTP 201 |
| XML-RPC authentication | Allowed |
| XML-RPC draft create/publication | Allowed |
| XML-RPC delete | Allowed; post moved to trash |
| Interactive service-user password login | Allowed before lockdown |

The Application Password is not route-scoped. Batch dispatch also demonstrates that denying only an obvious top-level post URL would be incomplete.

### Reduced-role experiment

A disposable `newsroom_draft_service` role contained only `read` and `edit_posts`. It excluded `publish_posts`, `edit_others_posts`, `edit_published_posts`, `delete_posts`, `upload_files`, and `manage_categories`.

- Core REST draft create still returned HTTP 201.
- Core REST update of the owned draft still returned HTTP 200.
- XML-RPC draft create still succeeded.
- REST/XML-RPC publication, deletion, and media upload were denied as expected.

**REMOVING `publish_posts` ALONE DOES NOT CLOSE THE TRUST BOUNDARY.** `edit_posts` is required by the existing bridge and simultaneously enables generic draft creation when paired with a generic WordPress credential.

## 5. Options considered

| Criterion | Option A: Application Password + custom role | Option B: Application Password + core-route denial | Option C: newsroom HMAC + internal service context |
|---|---|---|---|
| Generic WordPress credential exposed | Yes | Yes | No |
| Core REST bypass resistance | Fails: draft create/update remain | Conditional and enumeration-dependent | Passes by positive route allow-list |
| XML-RPC bypass resistance | Fails for draft create | Requires separate identity controls | Passes with service login/App Password lockdown |
| Least privilege | Partial capability reduction | Better, but credential remains generic | Route scope plus reduced internal capabilities |
| Route scoping | None | Negative deny-list | Positive allow-list bound into signature |
| Replay handling | None beyond operation semantics | None beyond operation semantics | Timestamp plus operation idempotency |
| Key rotation | WordPress credential lifecycle | Same plus denial-policy coordination | Key IDs permit bounded overlap and retirement |
| Implementation complexity | Low | High and open-ended | Moderate and explicit |
| Operational complexity | Low | High: alternate surfaces must stay covered | Moderate: secret, time, and header management |
| Existing bridge compatibility | Works but unsafe | May block internal behavior or miss alternates | Works before unchanged bridge checks/controller |
| Future publication compatibility | Already over-authorized | More route enumeration | Separate key/user can be required |
| Production blast radius | Generic WordPress capabilities | Generic credential plus deny-list gaps | Approved route and internal role only |
| Decision | Reject | Reject as primary design | Recommend subject to implementation audit |

Option B can add defence in depth, but it depends on identifying posts, autosaves, revisions, media, batch/internal dispatch, XML-RPC, login, credential management, plugin routes, and future surfaces. A positive authentication allow-list is smaller and safer.

## 6. Chosen architecture

Choose **Option C: newsroom-scoped HMAC authentication with an internally established, locked-down WordPress service-user context**.

The backend holds a dedicated 256-bit draft HMAC secret and non-secret key identifier. It holds no generic WordPress credential. During top-level REST authentication, WordPress accepts HMAC only for the two approved newsroom method/route pairs. After validation, WordPress establishes the configured draft service user. The unchanged bridge then performs its exact-user and `edit_posts` checks and invokes the core posts controller internally.

For every other HTTP route, the same HMAC headers cause generic authentication failure and never establish a WordPress user. This positive allow-list avoids enumerating every generic mutation endpoint.

## 7. Authentication protocol

### Headers

| Header | Value |
|---|---|
| `X-Newsroom-Auth-Version` | Literal `1` |
| `X-Newsroom-Key-Id` | Non-secret identifier: 1–64 lowercase ASCII letters, digits, dot, underscore, or hyphen; first character alphanumeric |
| `X-Newsroom-Timestamp` | Unix UTC seconds as 10–12 decimal digits |
| `X-Newsroom-Signature` | 64 lowercase hexadecimal characters |

No `Authorization` header is used. A newsroom request with another authentication context or an `Authorization` header fails closed. Each required authentication header must have exactly one non-empty logical value. Values containing commas, whitespace outside the permitted grammar, control characters, or any other application-visible ambiguity are rejected.

The canonical route is the concrete WordPress top-level REST route with exactly one leading slash and without scheme, authority, deployment base path, `/wp-json`, or query string. The concrete UUID sent by the client is part of the signed GET route; a route template or regular expression is never signed. Allowed pairs are exactly:

- `POST /newsroom/v1/drafts`
- `GET /newsroom/v1/drafts/{canonical-lowercase-UUID-v4}`

Version 1 supports only the exact pretty-permalink representation produced by the configured REST root followed by the canonical route. Trailing slashes, duplicate or multiple leading slashes, case variations, percent-encoded alternatives, and `rest_route` query routing are unsupported and fail closed. The request path must exactly equal that constructed representation before authentication. Version 1 permits no query string.

Newsroom HMAC operations must be direct top-level REST requests. They are not authorized through `/batch/v1`, legacy or plugin batch routes, or embedded batch requests. HMAC processing outside the two positive method/route pairs fails before a user is established. The disposable proof requires outer HMAC batch denial with exact HTTP 401 and an explicit embedded response object with exact HTTP 401; a missing inner response or status is a test failure.

WordPress method overrides are forbidden. Presence of `X-HTTP-Method-Override`, query `_method`, or a body override visible through WordPress's form parameters fails before authentication. Form bodies are independently prohibited by the JSON-only media-type rule.

### Content-Type

`POST /newsroom/v1/drafts` requires exactly one JSON media type before user-context establishment. Version 1 accepts `application/json` and `application/json; charset=utf-8`; media type, parameter name, and charset comparisons are case-insensitive, and optional HTTP whitespace around the semicolon/equal sign is permitted. Missing values, other parameters or charsets, quoted/malformed values, comma-joined values, `text/plain`, form data, multipart, and `application/x-www-form-urlencoded` are rejected with the generic HTTP 401 response. Content-Type is not added to the signing string: exact raw-body integrity plus strict JSON-only interpretation is the frozen semantic contract. GET requires no body or Content-Type.

The UTF-8 signing string contains six fields separated by one LF byte and has no trailing LF:

```text
newsroom-hmac-v1
{key_id}
{UPPERCASE_HTTP_METHOD}
{canonical_rest_route}
{unix_timestamp}
{lowercase_hex_sha256_of_exact_raw_body}
```

For GET, the exact raw body is zero bytes. POST signs the exact bytes transmitted by the backend and exposed as `php://input` to the WordPress REST layer, before parsing or reserialization. JSON whitespace and key ordering matter only because they change those bytes. The signature is lowercase hexadecimal `HMAC-SHA-256(canonical_string, decoded_256_bit_secret)`. WordPress uses `hash_equals()` for constant-time comparison.

The maximum accepted absolute clock skew is 300 seconds, inclusive: server time minus 300 and server time plus 300 are accepted, while ±301 are rejected. Timestamp input is 10–12 ASCII decimal digits on a supported 64-bit PHP runtime; negative, decimal, scientific, and overflow-like values fail before integer conversion. Missing/malformed headers, unknown key, malformed configuration, expired time, unsupported media type, query, override, body/method/route alteration, prior auth error, nonzero prior user, or signature mismatch all return the same external HTTP 401 contract. For HMAC isolation, exact HTTP 401 is mandatory: HTTP 403 means the request may have reached a WordPress authorization layer and is not acceptable authentication-boundary evidence. Secrets and validation details are never returned.

PHP/WordPress must reject every duplicate-header ambiguity it can observe. Some ingress stacks may silently choose one duplicate before PHP; plugin code cannot reliably detect information it never receives. Therefore the CDN/reverse proxy must reject duplicate `X-Newsroom-*` and Content-Type headers before PHP, and this behavior must be proven end to end before production writes. Inability to prove it is a production **NO-GO**.

## 8. Replay model

HMAC does not prevent replay. The recommended current balance is a five-minute timestamp window, exact method/route/raw-body binding, and durable operation-level idempotency.

For draft creation, `wordpressDraftKey` binds one canonical payload to one durable post. An identical signed replay inside the window returns the existing mapping; a changed payload cannot reuse the key. Signed GET replay has no mutation. A request outside the window is rejected before route execution.

A separate authentication nonce ledger is **not recommended for current draft POST/GET** because it adds transactional storage, cleanup, and availability risk without improving duplicate-draft safety beyond the existing durable operation key. Rate limiting and replay metrics remain recommended.

This does not generalize to future routes. Media needs its own durable idempotency design. Future publication must require a durable `PublishAttempt` key and state-transition contract in addition to a short-lived signature.

## 9. Service-user model

The non-human draft service user has exactly the required positive capabilities `read` and `edit_posts`. Built-in category assignment remains available because `assign_categories` maps through `edit_posts`; term management remains denied.

The request-time dangerous-capability deny set is: `publish_posts`, `edit_others_posts`, `edit_published_posts`, `delete_posts`, `delete_published_posts`, `delete_others_posts`, `delete_private_posts`, `edit_private_posts`, `upload_files`, `manage_categories`, `manage_options`, `edit_users`, `create_users`, `delete_users`, `promote_users`, `list_users`, `activate_plugins`, `install_plugins`, `update_plugins`, `delete_plugins`, `edit_plugins`, `switch_themes`, `edit_themes`, `install_themes`, `update_themes`, `delete_themes`, `edit_files`, `unfiltered_html`, `manage_network`, `manage_network_users`, `manage_network_plugins`, `manage_network_themes`, `manage_network_options`, and `setup_network`. A multisite super administrator is never a valid draft service identity.

At every HMAC authentication, WordPress verifies that the configured user exists, matches `NEWSROOM_BRIDGE_USER_ID`, has the required capabilities, lacks forbidden capabilities, and remains ineligible for Application Passwords. Any drift fails closed before user context is established.

The account retains a random high-entropy WordPress password hash because WordPress requires one, but neither the backend nor operators use it for integration. Identity-scoped policy rejects password login. No recoverable service password belongs in the backend.

## 10. Credential separation

### Draft authority

- Separate draft key ID and 256-bit secret.
- Accepted only for approved draft POST and reconciliation GET.
- Establishes only the reduced draft service user.
- Does not authorize publication, core REST, XML-RPC, login, credential management, or future publish routes.

### Future publication authority

- Separate HMAC key ID/secret and separately configured internal service user.
- Accepted only by a future explicit publication route.
- Requires a durable `PublishAttempt` idempotency/state-transition record.
- Capabilities require a separate design and audit.

Separate users prevent a draft request context from carrying publication capability. A future publisher may need controlled access to drafts owned by the draft user; Round 2B.2A does not approve broad `edit_others_posts` or publication implementation.

## 11. Core REST controls

Security comes from never treating HMAC as generic WordPress authentication. No user is established for core posts, updates, deletion, publication, autosaves, revisions, media, Application Password management, `/batch/v1`, embedded batch headers, or plugin-added routes. Batch behavior is a normative top-level-only rule, not an inference from current WordPress dispatch behavior.

The proof requires exact HTTP 401 for draft create, publish, update, delete, autosave, media, Application Password creation, and outer batch attempts using valid newsroom HMAC headers. An unauthenticated outer batch must return the explicit WordPress 7.1 outer HTTP 207 and an explicit inner authentication denial with HTTP 401. HTTP 403, a missing inner response, or a missing inner status fails the isolation proof. No post, reconciliation mapping, authentication cookie, or service-user Application Password may be created.

The existing bridge's internal `WP_REST_Posts_Controller` call remains compatible because it runs after approved HMAC authentication under the reduced current user; it is not a second external HTTP route.

The production authenticator must preserve the pre-existing WordPress current-user context before manual switching and restore it through a finally-equivalent path after the approved top-level newsroom dispatch. The service context remains active while Newsroom Bridge invokes `WP_REST_Posts_Controller`, creates the draft, verifies postconditions, and commits reconciliation. It must not issue a cookie/session/Application Password or leak into unrelated nested work after dispatch.

## 12. XML-RPC controls

The HMAC handler is REST-only and never participates in XML-RPC. For the service identity, Application Password availability is disabled, the pre-existing test Application Password failed after lockdown, the correct ordinary password failed, and the HMAC secret used as a password failed to authenticate or create/publish a post.

XML-RPC remains enabled globally. An unrelated Author's Application Password continued to authenticate, proving identity scoping.

## 13. Application Password policy

`wp_is_application_passwords_available_for_user` must return false only for configured newsroom service identities. HMAC authentication must fail if the draft service user unexpectedly appears eligible for Application Passwords.

Disabling availability locally invalidated an existing service-user Application Password for both core REST and XML-RPC. In the disposable WordPress 7.1 proof, a local Administrator's direct REST attempt to create a new Application Password for the locked service user was denied with HTTP 501, while the same Administrator created an Application Password for an unrelated Author with HTTP 201 and that credential authenticated normally. Production must accept only either explicit creation denial or, if a target runtime permits storage despite availability filtering, proof that the stored credential cannot authenticate followed by deletion. In all cases policy requires availability denial, monitoring/enumeration, removal of every stored service-user Application Password, and a final zero count. Unrelated users retain normal behavior.

## 14. Logging policy

Externally, every authentication failure uses one stable response without distinguishing missing, expired, unknown-key, route, or signature errors.

Internal structured logs may record protocol version, key ID, canonical route/method, broad result category, timestamp-skew class, infrastructure correlation ID, and service configuration/capability drift. Never log HMAC secrets, signatures unless separately justified, expected signatures, raw Authorization, WordPress passwords, Application Passwords, cookies, raw bodies, or article bodies.

Logs require access controls, retention limits, alerting for repeated failures, and redaction tests.

## 15. Key storage

HMAC secrets are deployment configuration, not content. They must not be stored in WordPress options, post meta, reconciliation storage, source control, images, logs, or evidence artifacts.

Use a host secret manager or environment-backed `wp-config.php` constants readable only by WordPress. The key ring is an indexed list of exact `{id, secret}` entries so duplicate IDs remain detectable before map construction. It must be non-empty; every entry must be valid or the entire ring fails. IDs use the strict lowercase grammar above and are selected by exact byte-for-byte equality.

Each secret is canonical unpadded base64url: strict alphabet, exactly 43 characters, strict decode to exactly 32 bytes, then re-encode to the identical configured value. Malformed/noncanonical encoding, wrong length, duplicate ID, malformed secondary entry, associative/ambiguous structure, or literal-string fallback is forbidden. Secrets are not exposed through REST, WP-CLI output, diagnostics, or admin UI.

## 16. Key rotation

1. Generate a new 256-bit secret and unique key ID in the secret manager.
2. Add it to the server key ring as accepted but not yet primary.
3. Deploy configuration and confirm fail-closed health.
4. Switch the backend signer to the new key ID.
5. Observe new-key success for at least the skew window plus bounded delivery delay.
6. Remove the old key from the accepted ring.
7. Destroy the old secret and retain only identifier/retirement metadata.

Overlap is bounded. Draft and future publication key rings are separate.

## 17. Deployment and migration order

No production step was executed. Subject to separate approval:

1. Deploy audited hardening code inert/fail-closed.
2. Configure the service-user identity.
3. Enable identity-scoped ordinary-password lockdown.
4. Enable identity-scoped Application Password unavailability.
5. Verify the old service-user password cannot authenticate interactively or through XML-RPC.
6. Verify each existing legacy Application Password cannot authenticate through REST or XML-RPC.
7. Provision the draft HMAC key through protected configuration.
8. Validate production ingress/header/body behavior with only an approved harmless signed GET for a fresh nonexistent UUID; authenticated 404 proves route authentication without content creation.
9. Revoke/delete every legacy service-user Application Password.
10. Enumerate and verify that zero service-user Application Passwords remain.
11. Verify the old Application Password again fails REST and XML-RPC.
12. Verify the service-user password again fails interactive login and XML-RPC.
13. Verify the exact positive and dangerous-negative capability policy.
14. Verify duplicate-header rejection at production ingress.
15. Verify Content-Type and raw-body preservation end to end.
16. Only then seek separate supervisor authorization for a controlled production draft write.

This accepts a brief integration outage instead of allowing generic and route-scoped credentials to overlap.

### CDN and reverse-proxy requirements

Production must verify that the hosting/CDN preserves `X-Newsroom-Auth-Version`, `X-Newsroom-Key-Id`, `X-Newsroom-Timestamp`, and `X-Newsroom-Signature` through to WordPress. It must also preserve the Content-Type, HTTP method, REST path, and exact raw request-body bytes covered by the signature. Ingress must reject duplicate `X-Newsroom-*` and Content-Type headers rather than merge them or silently select one, and it must not cache authenticated responses. Header names are case-insensitive, but values are not rewritten. The protocol deliberately avoids the commonly intercepted `Authorization` header. End-to-end TLS remains mandatory. Header/body/duplicate propagation is a later controlled validation item and was not tested against production; inability to prove it is a production NO-GO.

## 18. Failure modes

| Condition | Required behavior |
|---|---|
| Missing/invalid key configuration | HTTP 401; no user context |
| Empty, duplicate-ID, noncanonical, or partly malformed key ring | HTTP 401; entire ring rejected |
| Missing/wrong service or bridge user | HTTP 401; no execution |
| Required capability absent, dangerous capability present, or multisite super admin | HTTP 401 |
| Service user eligible for Application Passwords | HTTP 401 |
| Unknown/malformed key or secret | HTTP 401 |
| Missing/malformed/expired timestamp | HTTP 401 |
| Invalid/malformed signature | HTTP 401; constant-time comparison when well formed |
| Method, route, query, method override, or raw body differs | HTTP 401 |
| Missing/unsupported/ambiguous POST Content-Type | HTTP 401 |
| Application-visible duplicate/ambiguous authentication header | HTTP 401 |
| Ingress duplicate-header rejection unverified | Production NO-GO |
| Outer or embedded batch use | No HMAC user context; denied |
| Route scope cannot be determined | HTTP 401 |
| Prior auth error, user context, or Authorization header | HTTP 401; no fallback |
| Bridge capability assumptions change | Bridge fails closed |
| Hardening component absent/deactivated | HMAC remains meaningless; service retains no generic credential |

## 19. Threat model

| Attacker case | Can do | Cannot do | Limiting control / remaining scope |
|---|---|---|---|
| Draft HMAC secret stolen | Submit/replay approved draft operations | Use core REST, XML-RPC, login, publication, or credential management | Route/key scope, reduced user, idempotency, rotation; malicious drafts/DoS remain |
| Future publish secret stolen | Use future publication contract | Use draft key or generic WordPress auth | Separate key/user and `PublishAttempt`; future design required |
| Service username known | Identify account name | Authenticate without another secret | Unknown random password, login denial, no App Password |
| Database read compromised | Read content, mappings, hashes | Obtain HMAC from approved storage | Secret stays outside DB; DB breach remains severe |
| Backend compromised | Use draft HMAC | Publish or use generic WP unless another authority is compromised | Compartmentalization; draft abuse remains |
| WordPress administrator compromised | Alter users/plugins/config/content | No protection guarantee is claimed | Full admin/server compromise is out of scope |
| Replay within window | Repeat identical signed operation | Change method, route, body, or create duplicate mapped draft | Signature plus `wordpressDraftKey`; rate abuse remains |
| CDN/proxy strips/modifies data | Cause authentication failure | Forge modified valid request | TLS/signature; production propagation testing required |
| Plugin changes auth/current user | Cause denial or post-auth interference | Is not assumed safe | Prior-user/capability checks; production plugin review remains |

The architecture does not protect against full WordPress administrator, server, filesystem, runtime-memory, or secret-manager compromise.

## 20. Disposable proof results

The complete final-remediation proof ran `2026-09-02T17:01:45.212Z`–`2026-09-02T17:05:28.330Z` with WordPress 7.1, PHP 8.2.33, MariaDB 10.11.19, WP-CLI 2.12.0, and approved immutable image digests. All 18 ordered evidence groups passed.

| Test group | Result | Evidence |
|---|---|---|
| Cleanup failure guards | PASS | Nonzero command status, missing status, and missing stdout were each rejected rather than interpreted as empty successful output |
| Current Author surface | PASS | REST draft create/update, durable parent-draft autosave update, publish/delete/media/batch and XML-RPC auth/create/publish/delete exercised; observed revision delete was HTTP 403 and the revision remained |
| Custom role only | PASS, proves insufficiency | REST draft create/update and XML-RPC draft worked with only `read`/`edit_posts`; durable update changed title and content while preserving author and draft status; publish/delete/media returned authorization-layer HTTP 403 |
| Service lockdown | PASS | Existing App Password REST 401/XML-RPC denied; password login/XML-RPC denied; Administrator recreation for the locked identity denied with 501; unrelated Author recreation 201 and usable; zero retained service App Passwords |
| Valid HMAC POST/GET | PASS | POST 201 and GET 200; independent inspection found exactly one draft with the requested title/content/categories and configured author, plus exactly one matching reconciliation row with null reservation token |
| GET body/Content-Type contract | PASS | Zero-byte/no-Content-Type GET returned 200; nonempty body, Content-Type, and combined variants returned exact 401 with unchanged post/reconciliation state |
| Content-Type contract | PASS | Both approved JSON forms accepted; missing, `text/plain`, form, multipart, malformed, unsupported charset, and comma-joined forms returned exact 401 with zero post/reconciliation state |
| Route/query/override contract | PASS | Concrete UUID substitution, trailing/duplicate/multiple-leading slash, case, percent encoding, query, `rest_route`, header/query/body method overrides all failed closed |
| Duplicate-header stack | PASS | Raw duplicate `X-Newsroom-*` headers were visible and rejected; comma-joined ambiguity returned 401; production ingress rejection remains mandatory |
| Canonical key-ring contract | PASS | Canonical key accepted; empty, malformed base64url, wrong-length, noncanonical, duplicate-ID, and malformed-secondary rings rejected |
| Timestamp boundaries/formats | PASS | Past/future 300 seconds accepted; past/future 301 rejected; negative, decimal, scientific, and oversized values rejected |
| Invalid/tampered HMAC | PASS | No auth, wrong secret, body/method/route tamper, expiry, malformed time, unknown key, and malformed signature all returned 401 |
| Signed replay | PASS | In-window replay 200/`replayed=true` with one durable post; expired replay 401 |
| Core REST/batch/credential bypass | PASS | Core create/publish/update/delete/autosave/media/credential and outer batch returned exact 401 without authentication cookies; embedded batch returned explicit outer 207 and inner 401 `rest_cannot_create`; post, reconciliation, revision/autosave, attachment, and credential state remained unchanged |
| Dangerous capability drift | PASS | Injecting `manage_options` forced HMAC 401; exact policy restoration restored GET 200 |
| Backend XML-RPC bypass | PASS | Service password, legacy App Password, and HMAC secret denied; HMAC secret could not create/publish |
| Ordinary-user non-regression | PASS | REST root 200; Administrator/Author core creates 201; unrelated XML-RPC App Password and password login worked |
| Final service model | PASS | Exact `read`/`edit_posts` positive policy, complete dangerous-negative policy, zero App Passwords, password login denied, and approved newsroom namespace only |

Production bridge hashes were identical before and after. Ephemeral credentials are created inside the harness lifecycle, whose `try`/`finally` path attempts `.env.runtime` removal on all handled source-integrity, provisioning, fixture, test, and cleanup failures. Cleanup command results and project-label-scoped Docker residue queries are checked, and any command uncertainty, detected residue, or env-file removal failure makes validation fail. In the successful final run, Compose teardown and both residue queries exited 0, zero project containers and volumes remained, and `.env.runtime` was absent. Abnormal process termination, host or power failure, Docker daemon failure, or an equivalent out-of-process interruption can prevent cleanup from executing and requires operator residue verification. The sanitized results file is ignored by Git.

## 21. Limitations

- The shim is **TEST ONLY — NEVER DEPLOY** and is not production-reviewed.
- No production/Simbidzebasa request occurred; CDN/header propagation is unverified.
- Production clock synchronization, secret lifecycle, rotation, and incident response are unverified.
- No authentication nonce ledger was tested.
- Media authorization/idempotency remain unresolved; publication and `PublishAttempt` do not exist.
- Production hooks/plugins, persistent cache, transaction interference, and user-context interference remain unreviewed.
- Rate limiting and abuse controls were not implemented.
- This was narrow authorization characterization, not a vulnerability scan.
- Controls depend on the hardening component loading. An unknown random password and zero App Passwords limit accidental-deactivation exposure, but deployment integrity/monitoring remain necessary.
- Normal behavior was proven only in the disposable WordPress 7.1 fixture.

Production remains **NO-GO** until approved implementation, source audit, staging/runtime validation, CDN proof, migration rehearsal, and controlled deployment gates complete.

## 22. Exact Round 2B.2B implementation plan

After design approval, limit Round 2B.2B to production-quality WordPress hardening source and local/staging validation:

1. Implement the exact v1 protocol, positive route/key policy, generic failures, constant-time comparison, and fail-closed identity/capability checks.
2. Implement identity-scoped App Password unavailability and password/XML-RPC login denial without global changes.
3. Implement configuration-only draft key rings/service IDs with no WordPress secret persistence.
4. Implement structured auth-result logging and mandatory redaction tests.
5. Implement and verify the exact draft service role without publish/delete/media/taxonomy/admin capabilities.
6. Add unit tests for canonicalization, raw-body hashing, skew boundaries, malformed input, rotation overlap, scope binding, and configuration drift.
7. Add disposable tests for core REST, autosaves/revisions, media, batch, XML-RPC, login, legacy credential invalidation/revocation, ordinary users, and missing/deactivated hardening.
8. Re-run bridge concurrency, reconciliation, and lost-response behavior under HMAC context.
9. Add migration/rollback and staging CDN header/body-preservation plans.
10. Obtain source/runtime supervisor audits before production access.

Round 2B.2B does not include publication, media operations, backend adapter implementation, or deployment unless later instructions explicitly expand scope.
