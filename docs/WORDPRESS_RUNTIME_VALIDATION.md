# WordPress Newsroom Bridge runtime validation

## Status and decision

**Round 2B.1 result: PASS.** The supervisor-approved Round 2B.0 source was exercised successfully in a disposable local WordPress runtime. Round 2B.1 remains **CURRENT** pending supervisor review; overall Round 2B remains **PENDING**.

**Recommendation beyond Round 2B.1: NO-GO until the direct core REST trust boundary is hardened and separately approved.** The local integration Author could create both draft and published posts through core `wp/v2/posts`, bypassing Newsroom Bridge reconciliation and any external publication-approval workflow.

This is disposable runtime evidence, not production validation. Newsroom Bridge remains **NOT DEPLOYED**, **NOT INSTALLED**, and **NOT ACTIVATED** on Simbidzebasa. No production request or production credential was used. Production active-hook review, production cache validation, media idempotency, and controlled security hardening remain outstanding.

## Evidence provenance

- Tested commit: `c12d17916825cdae724d940be1ad3be0b845b621`
- Branch: `feat/round-2b-wordpress-reconciliation`
- Remediation suite start: `2026-08-30T18:29:11.293Z`
- Remediation suite finish: `2026-08-30T18:32:04.785Z`
- Runtime URL: `http://127.0.0.1:18081`
- MariaDB was not published to the Windows host.
- The generated runtime credential file was ignored, never printed, and removed during cleanup.
- The harness rejects non-loopback runtime hostnames and does not read the repository-root `.env`.

## Runtime versions and images

| Component | Version/tag | Resolved image ID/digest |
|---|---|---|
| Docker client/server | 29.7.2 / 29.7.2 | Docker Desktop 4.88.1 |
| Docker Compose | 5.4.0 | Local Docker plugin |
| WordPress | 7.1 | `wordpress:7.1-php8.2-apache@sha256:75c755113d8644a08519270d77e0c8bd14b7bea23910e3d165056870093869a2` |
| PHP in WordPress | 8.2.33 | Included in the digest-pinned WordPress image |
| MariaDB | 10.11.19-MariaDB-ubu2204 | `mariadb:10.11@sha256:ce66c7be32a03aabe7241d0a10993a2db827ef652a35d25727d92a832ac8ef73` |
| WP-CLI | 2.12.0 | `wordpress:cli@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586` |

## PHP compatibility

All four approved plugin PHP files passed `php -l` in official `php:7.4-cli` and `php:8.2-cli` containers before runtime work. All four passed again after the complete suite. No production plugin PHP file was modified.

## Disposable fixture

| Identity/category | Local ID | Role/details |
|---|---:|---|
| `runtime_admin` | 1 | Administrator |
| `runtime_unrelated` | 2 | Author |
| `runtime_integration` | 3 | Configured Newsroom Bridge Author |
| Runtime Category A | 2 | Existing category |
| Runtime Category B | 3 | Existing category |
| Runtime Category C | 4 | Existing category |

Application Passwords were generated locally for the HTTP tests and were neither logged nor retained.

## Activation and actual schema

Newsroom Bridge 1.0.0 activated successfully. The runtime schema-version option was `2`. The actual `wp_newsroom_reconciliation` table used InnoDB and contained:

| Column | Actual contract |
|---|---|
| `draft_key` | `char(36) NOT NULL` |
| `post_id` | `bigint(20) unsigned NULL` |
| `payload_hash` | `char(64) NOT NULL` |
| `actor_user_id` | `bigint(20) unsigned NOT NULL` |
| `reservation_token` | `char(36) NULL` |
| `created_at` | `datetime NOT NULL` |
| `updated_at` | `datetime NOT NULL` |

Indexes were exactly `PRIMARY KEY (draft_key)` and a single-column unique `post_id` index. Deactivation/reactivation later preserved both the table and a historical mapping.

## Routes and authorization

REST discovery contained the normal WordPress namespace index plus exactly these bridge resource routes:

- `POST /wp-json/newsroom/v1/drafts`
- `GET /wp-json/newsroom/v1/drafts/{draft_key}`

No bridge publish, update, delete, media, category-management, user, settings, debug, or arbitrary mapping-list route was present.

| Caller | POST result |
|---|---|
| Unauthenticated | HTTP 403 denied |
| Unrelated Author | HTTP 403 `newsroom_bridge_forbidden` |
| Administrator | HTTP 403 `newsroom_bridge_forbidden` |
| Configured integration Author | HTTP 201 for a valid create |

The configured identity therefore requires both exact user-ID matching and `edit_posts`; administrator capability alone does not bypass the identity check.

## Normal and validation test matrix

| Test | Result | Runtime evidence |
|---|---|---|
| First create | PASS | HTTP 201, `replayed=false`, one draft post, one mapping, correct Author/category, 64-character hash, token cleared |
| GET reconciliation | PASS | HTTP 200, same post ID and `draft` status |
| Sequential identical replay | PASS | HTTP 200, `replayed=true`, same post; counts remained one post/one mapping |
| Category canonicalization | PASS | `[B,A,B]` create followed by `[A,B]` replay returned the same post; stored categories were exactly A+B |
| Material conflict | PASS | HTTP 409 `newsroom_idempotency_conflict`; original mapping unchanged and no duplicate |
| Uppercase UUID | PASS | HTTP 400 `newsroom_invalid_draft_key` |
| Empty title | PASS | HTTP 400 `newsroom_invalid_payload` |
| Empty categories | PASS | HTTP 400 `newsroom_invalid_payload` |
| Nonexistent category | PASS | HTTP 400 `newsroom_category_not_found` |
| Unsupported `status=publish` | PASS | HTTP 400 `newsroom_invalid_payload`; no bridge publication |

## Concurrency

### Twenty identical requests

- HTTP outcomes: one `201`, nineteen `200`
- Unique successful post IDs: one
- Durable matching posts: one
- Durable reconciliation rows: one
- Final `reservation_token`: null
- Orphan or duplicate drafts: zero

### Twenty conflicting requests

- HTTP outcomes: one `201`, nine `200`, ten `409`
- The harness retained request metadata and identified variant X from the unique HTTP 201 response; it did not infer the winner from ordering.
- The winning payload was independently canonicalized as contract version 1, title, content, excerpt with empty-string default semantics, and de-duplicated/numerically sorted categories, then SHA-256 hashed in Node without reading the plugin-computed value.
- Expected winning hash: `59a217437bbe6823aada3d2e6bbe146b04863bba1650ebd5a60a4b1f8728623f`.
- Durable mapping hash: `59a217437bbe6823aada3d2e6bbe146b04863bba1650ebd5a60a4b1f8728623f`.
- All ten incompatible requests returned HTTP 409 `newsroom_idempotency_conflict`.
- Every HTTP 200/201 response referenced durable mapped post ID 8.
- Durable matching posts across both variants: one
- Durable reconciliation rows: one
- A further deterministic conflicting POST returned HTTP 409; the hash remained byte-for-byte identical, post ID remained 8, and counts remained one post/one mapping.
- Final `reservation_token`: null.

## Fault injection

The fault injector was mounted as a separate test-only plugin and did not alter the approved bridge source. Fault activation required the Compose-only `NEWSROOM_BRIDGE_TEST_FAULTS_ENABLED=1` gate, WordPress local environment type, the existing source-network restriction, and an explicit per-request fault header.

| Fault | Result | HTTP and durable outcome |
|---|---|---|
| Throw after `rest_insert_post` | PASS | HTTP 422 `newsroom_draft_creation_failed`; zero posts and zero mappings |
| Mapping attachment SQL failure | PASS | HTTP 503 `newsroom_reconciliation_storage_error`; zero posts and zero mappings |
| Category postcondition corruption | PASS | HTTP 409 `newsroom_draft_creation_failed`; zero posts and zero mappings |
| COMMIT-only failure | PASS | HTTP 503 `newsroom_reconciliation_outcome_uncertain`; GET then confirmed 404; retry returned 201 with one post/one mapping |
| Mapping GET database failure | PASS | HTTP 503 `newsroom_reconciliation_storage_error`, never 404; normal GET recovered to 200 after removing the fault |
| Third-party transaction tamper | PASS as expected external limitation | Hook committed then threw; initial request returned 422, and lookup/replay both failed closed at 409 `newsroom_reconciliation_corrupt`; disposable objects were cleaned |

The transaction-tampering test demonstrates that Newsroom Bridge cannot roll back a transaction already committed by another hook. Production approval requires review for hook/plugin `COMMIT`, `ROLLBACK`, `START TRANSACTION`, DDL, nontransactional writes, outbound calls, and other external side effects.

## Corruption, recovery, and storage defences

| Test | Result | Evidence |
|---|---|---|
| Committed incomplete mapping | PASS | POST and GET returned 409 `newsroom_reconciliation_corrupt`; no replacement post |
| Missing target | PASS | GET and replay returned 409 `newsroom_reconciliation_target_missing`; mapping remained and no replacement post |
| Later status change | PASS | Admin changed local draft to `publish`; GET retained the same post ID and reflected `publish` |
| Missing unique `post_id` index | PASS | HTTP 503 `newsroom_reconciliation_storage_error`; no post; index restored |
| `wp_postmeta` changed to MyISAM | PASS | HTTP 503 `newsroom_storage_not_transactional`; no post; InnoDB restored |
| Schema-version mismatch | PASS | HTTP 503 `newsroom_bridge_not_configured`; version 2 restored |
| Deactivate/reactivate with history | PASS | Mapping remained while inactive; reactivation succeeded; GET returned the original post |
| Final healthy create after restoration | PASS | HTTP 201 confirmed normal operation resumed |

## Lost-response recovery

A loopback-only Node proxy forwarded the complete authenticated create request, allowed WordPress to finish, and then destroyed the downstream response. The client received no usable response. Subsequent GET by `draft_key` returned HTTP 200 and recovered the post ID. A replay returned HTTP 200 with `replayed=true`; durable state remained exactly one post and one mapping.

This directly validates the intended recovery sequence: completed WordPress create, lost response, deterministic reconciliation, and no blind duplicate create.

## Direct core REST security characterization

Using the same local integration Author Application Password:

- Direct `POST /wp-json/wp/v2/posts` with `status=draft`: HTTP 201 with a positive ID; before cleanup, the durable `wp_posts` row was asserted as type `post`, Author ID 3, status `draft`.
- Direct `POST /wp-json/wp/v2/posts` with `status=publish`: HTTP 201 with a positive ID; before cleanup, the durable `wp_posts` row was asserted as type `post`, Author ID 3, status `publish`.
- Runtime capabilities: `edit_posts=true`, `publish_posts=true`, `upload_files=true`, `manage_categories=false`.
- Both local characterization posts were deleted afterward.

**Classification: PRODUCTION TRUST-BOUNDARY BLOCKER.** Possession of the Author Application Password permits article creation outside Newsroom Bridge and permits direct publication, bypassing reconciliation and an external approval workflow. No bridge source change was made in response. A separate supervisor-approved security-hardening design is required before production integration.

No broad security scan, exploit test, production probe, or XML-RPC bypass test was performed. Core REST alone proves an additional article-write surface outside the custom bridge contract.

## Cache and hook characterization

No `object-cache.php` drop-in or persistent external object cache was present. Rollback tests proved that the next request and direct database checks saw no durable post after the exercised failures. **PERSISTENT OBJECT CACHE NOT TESTED.** Production cache behavior remains a separate requirement.

The clean local snapshot reported:

- `rest_insert_post`: test-only fault-injector closure at priority 20
- `rest_after_insert_post`: test-only fault-injector closure at priority 20
- `save_post`: core `delete_get_calendar_cache` at priority 10
- `wp_after_insert_post`: core `wp_save_post_revision_on_insert` at priority 9

Newsroom Bridge's candidate-capture callback is temporary and exists only during its controller call; the throw-after-insert test exercised that path successfully. This inventory describes only the disposable runtime. **PRODUCTION ACTIVE-HOOK INVENTORY STILL REQUIRED.**

## Approved source integrity

| Approved PHP file | SHA-256 before and after |
|---|---|
| `includes/class-newsroom-bridge-db.php` | `1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa` |
| `includes/class-newsroom-bridge-reconciliation.php` | `6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a` |
| `includes/class-newsroom-bridge-rest.php` | `965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a` |
| `newsroom-bridge.php` | `04d08c7ea2bcc48f3bfc145fe0975683deae2fd71fcdb12ad2575f4e95aae5dc` |

Every before/after hash was identical.

## Repository validation

- `pnpm lint`: passed
- `pnpm typecheck`: passed
- `pnpm test`: passed, 3 suites and 26 tests
- `pnpm test:e2e`: passed, 1 suite and 1 test
- `pnpm build`: passed
- Final PHP 7.4 lint: all four files passed
- Final PHP 8.2 lint: all four files passed
- `git diff --check`: passed

## Cleanup and remaining limitations

`docker compose down -v --remove-orphans` removed the disposable containers and both project volumes. A label-based check found zero remaining project containers and zero remaining project volumes. The ignored `.env.runtime` credential file was removed.

Remaining production risks and unknowns:

- Direct core REST draft/publication bypass must be hardened before production use.
- Production active hooks/plugins may manipulate transactions, perform DDL, write nontransactional storage, or create irreversible external side effects.
- Persistent production object-cache behavior has not been tested.
- Media upload and media idempotency remain unresolved.
- Production installation, activation, database engine/schema verification, and Simbidzebasa-specific runtime validation have not occurred.
- Backend adapter implementation has not begun.
