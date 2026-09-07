# Simbidzebasa WordPress contract

## 1. Discovery scope

Round 2A performed read-only contract discovery against the production site. Only `HEAD`, `GET`, and `OPTIONS` were used. Public discovery succeeded; an initial Application Password probe failed because of a misconfigured username, then authenticated read-only discovery succeeded after the username was corrected manually. No write request, form submission, administrative login, database synchronization, or security probing was performed.

- **DISCOVERED FACT:** Discovery ran at `2026-08-30T11:43:35Z` (UTC).
- **DISCOVERED FACT:** Target site: `https://simbidzebasa.co.zw/`.
- **DISCOVERED FACT:** The front page returned HTTP 200 without a redirect.
- **DISCOVERED FACT:** Its `Link` header advertised `https://simbidzebasa.co.zw/wp-json/` with relation `https://api.w.org/`.
- **DISCOVERED FACT:** The advertised REST root returned HTTP 200 and identified the site as “Simbidzebasa News”, with description “Authentic & Reliable News”.

The category inventory below is a discovery snapshot, not application seed data or a hardcoded domain enumeration.

## 2. REST root and namespaces

**DISCOVERED FACT:** The canonical REST API root is `https://simbidzebasa.co.zw/wp-json/`. The root exposed 473 routes and included the core `wp/v2` namespace.

Publication-relevant namespaces or extension signals visible through ordinary REST discovery included `wp/v2`, `elementor/v1`, `elementor-pro/v1`, `astra/v1`, `surerank/v1`, `litespeed/v1`, `litespeed/v3`, and several Hostinger namespaces. Other discovered namespaces are omitted because they are not currently relevant to the publishing contract.

- **DISCOVERED FACT:** No non-core top-level field was present in the public post schema.
- **DISCOVERED FACT:** Astra-related and Elementor-related registered post meta fields were visible in the schema.
- **INFERENCE:** Elementor/Astra may affect rendering or editor behavior, and LiteSpeed/Hostinger infrastructure may affect cache or delivery behavior. Their effect on authenticated writes is unverified.

## 3. Article post type and permalink contract

- **DISCOVERED FACT:** Existing news articles returned `type: post`.
- **DISCOVERED FACT:** The type registry identifies internal type `post`, REST namespace `wp/v2`, REST base `posts`, and `hierarchical: false`.
- **DISCOVERED FACT:** The post type is attached to `category` and `post_tag`.
- **DISCOVERED FACT:** A sample of 10 recent public posts exposed `id`, `date`, `modified`, `slug`, `status`, `type`, `link`, `title`, `content`, `excerpt`, `author`, `featured_media`, `template`, `meta`, `categories`, and `tags`.
- **DISCOVERED FACT:** Public examples use root-level links such as `https://simbidzebasa.co.zw/{slug}/`, consistent with the observed frontend article URLs.

Therefore the discovered article contract is core `post` at `wp/v2/posts`, not a custom news post type.

## 4. Advertised post schema

The public `OPTIONS` contract advertised collection methods `GET` and `POST`, and individual-resource methods `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`. Round 2A used only `OPTIONS` and `GET`; advertised methods are not proof of integration-user permission.

The collection create schema advertised these future-write fields: `date`, `date_gmt`, `slug`, `status`, `password`, `title`, `content`, `author`, `excerpt`, `featured_media`, `comment_status`, `ping_status`, `format`, `meta`, `sticky`, `template`, `categories`, and `tags`.

- **ADVERTISED BY SCHEMA:** `title`, `content`, `status`, `categories`, `tags`, `featured_media`, `excerpt`, `slug`, `author`, `meta`, and `template` are request fields.
- **UNVERIFIED UNTIL WRITE TEST:** Whether the future integration user may set any of these fields.
- **UNVERIFIED UNTIL WRITE TEST:** Draft creation, update behavior, category assignment, featured-media assignment, author selection, and publication.

## 5. Taxonomy contract

| Internal taxonomy | REST base | Namespace | Hierarchical | Attached types |
|---|---|---|---:|---|
| `category` | `categories` | `wp/v2` | Yes | `post` |
| `post_tag` | `tags` | `wp/v2` | No | `post` |

**DISCOVERED FACT:** No additional public publishing taxonomy was attached to core posts. Navigation and pattern taxonomies exist for their own WordPress types and are not Story taxonomy.

### Category discovery snapshot

The request used `per_page=100`, `page=1`, `hide_empty=false`, and a minimal `_fields` projection.

- **DISCOVERED FACT:** HTTP status: 200.
- **DISCOVERED FACT:** `X-WP-Total: 10`.
- **DISCOVERED FACT:** `X-WP-TotalPages: 1`.
- **DISCOVERED FACT:** All 10 exposed categories were returned on the single reported page.

| WP ID | Name | Slug | Parent | Count |
|---:|---|---|---:|---:|
| 15 | Agriculture | `agriculture` | 0 | 6 |
| 2 | Arts | `arts` | 0 | 19 |
| 6 | Breaking News | `breaking-news` | 0 | 22 |
| 3 | Business | `business` | 0 | 14 |
| 1 | Development | `development` | 0 | 26 |
| 4 | Health | `health` | 0 | 8 |
| 5 | Politics | `politics` | 0 | 12 |
| 16 | Science | `science-technology` | 0 | 2 |
| 17 | Sports | `sports` | 0 | 7 |
| 8 | World | `world` | 0 | 13 |

- **DISCOVERED FACT:** All exposed categories currently have parent ID 0.
- **DISCOVERED FACT:** The visible label `Science` maps to slug `science-technology`, confirming that names and slugs cannot safely be derived from one another.
- **OBSERVED FRONTEND BEHAVIOR:** Navigation exposes Science and Sports as labels, while the homepage also presents a combined “Arts & Sports” section.
- **INFERENCE:** “Arts & Sports” is presentation grouping, not a taxonomy identity. The REST inventory separately identifies Arts (2) and Sports (17).

WordPress category IDs remain authoritative; names, slugs, counts, and hierarchy are synchronized metadata.

## 6. Multi-category evidence

**DISCOVERED FACT:** Public post ID 1509, slug `mother-africa-international-is-turning-masvingo-youth-into-digital-trailblazers`, returned category IDs `[1, 16]`, resolving to Development and Science.

This confirms that the live WordPress contract supports multiple categories per article and validates the Round 1.2 many-to-many persistence decision. It does not establish a primary category.

## 7. Media and featured-image contract

- **DISCOVERED FACT:** `wp/v2/media` is publicly readable and advertises the standard media schema.
- **DISCOVERED FACT:** The schema includes `id`, `date`, `slug`, `type`, `media_type`, `mime_type`, `source_url`, `caption`, `alt_text`, `media_details`, and `post`.
- **DISCOVERED FACT:** Media ID 1717 is a normal `attachment`, `media_type: image`, MIME type `image/jpeg`, with a WordPress uploads URL and standard image dimensions/sizes.
- **DISCOVERED FACT:** Public post 1729 returned `featured_media: 1717`, and media ID 1717 resolved successfully.
- **INFERENCE:** Standard core WordPress featured-media ID semantics appear usable.
- **UNVERIFIED UNTIL WRITE TEST:** Media upload permission, accepted upload formats/limits, metadata updates, attachment behavior, and featured-media assignment.

No image binary was downloaded for discovery.

## 8. Technical author and editorial byline

- **DISCOVERED FACT:** Public post 1509 references technical WordPress author ID 1, whose displayed name is “Simbidzebasa News”.
- **OBSERVED FRONTEND BEHAVIOR:** The article page renders “Published by Simbidzebasa News” separately from editorial body text beginning “By Godfrey Gusha”.
- **INFERENCE:** Live behavior supports keeping the WordPress publishing account separate from journalist editorial identity.

The approved model remains aligned: `Reporter.displayName` is operational identity, `Reporter.editorialByline` is current preferred editorial identity, `Story.byline` is historical provenance, and the WordPress integration account is technical publishing identity. How the byline will be rendered must be decided and write-validated in Round 2B; Round 2A does not alter article content.

## 9. Custom fields and reconciliation

The post schema exposes a `meta` object. Registered public keys are primarily Astra layout settings, Elementor editor data/settings, and core `footnotes`. No dedicated newsroom idempotency field was discovered. The posts collection supports filtering by fields such as slug, author, status, categories, and tags, but the advertised public query contract exposes no deterministic filter for an arbitrary registered meta value.

- **DISCOVERED FACT:** No dedicated `wordpressDraftKey`-like top-level REST field exists in the public post schema.
- **DISCOVERED FACT:** No discovered registered meta field is semantically suitable for a private newsroom reconciliation UUID.
- **DISCOVERED FACT:** The public post collection schema does not advertise search/filter by arbitrary post meta.
- **UNVERIFIED UNTIL WRITE TEST:** Whether authenticated edit context exposes another suitable custom field or plugin contract.

**RECONCILIATION CONTRACT: UNRESOLVED.**

Headline, body, excerpt, slug, comments, categories, public permalink, and existing theme/plugin meta must not be repurposed as hidden idempotency storage.

## 10. Authentication and capabilities

- `WORDPRESS_USERNAME`: configured and non-placeholder at pre-flight.
- `WORDPRESS_APPLICATION_PASSWORD`: configured and non-placeholder at pre-flight.
- **DISCOVERED FACT:** The earlier HTTP 401 was resolved after the configured WordPress username was corrected manually.
- **DISCOVERED FACT:** An Application Password `GET` to `/wp-json/wp/v2/users/me?context=edit` returned HTTP 200.
- **DISCOVERED FACT:** Authenticated identity is dedicated integration user ID 2, display name “SDB News”, role `author`.
- **AUTHENTICATION: SUCCEEDED.**
- **DISCOVERED FACT:** The response passed through `hcdn` without a redirect, bot challenge, or `Retry-After`.

The dedicated Author credential was used only for read-only contract discovery. No user, role, password, Application Password, or WordPress state was changed.

**CONFIRMED FROM AUTHENTICATED CAPABILITY DATA:** `edit_posts`, `publish_posts`, `upload_files`, `edit_published_posts`, and `delete_posts` are true.

**CONFIRMED FROM AUTHENTICATED CAPABILITY DATA:** `edit_others_posts`, `delete_others_posts`, `manage_categories`, `manage_options`, user administration, plugin administration, and theme administration are false. The newsroom does not require these broader capabilities.

**CONFIRMED FROM AUTHENTICATED CAPABILITY DATA AND WORDPRESS CORE CAPABILITY MAPPING:** `edit_posts` is true. For the built-in category taxonomy, `assign_terms` uses `assign_categories`, and WordPress core `map_meta_cap()` resolves `assign_categories` to `edit_posts`. The dedicated Author account therefore supports assigning existing categories while remaining unable to manage the taxonomy. A serialized `assign_categories` value is not, by itself, the effective-capability result because this meta capability is resolved through `edit_posts`.

- **ADVERTISED BY SCHEMA:** Posts, categories, and media collection routes advertise `POST`; individual posts advertise update and delete methods.
- **UNVERIFIED UNTIL ROUND 2B WRITE TEST:** Actual draft creation/editing, publication, media upload, assignment of existing categories, featured-media assignment, and registered-meta writes.

### Authenticated post edit context

**DISCOVERED FACT:** An authenticated `context=edit` collection query restricted to author ID 2 returned HTTP 200 and zero posts. The dedicated integration user currently owns no post that can be sampled in edit context without accessing another author’s content.

The authenticated `OPTIONS` post schema exposed the same core top-level fields as public discovery and no plugin-added top-level field. It advertises title, content, excerpt, slug, status, author, categories, tags, `featured_media`, meta, template, `generated_slug`, and `permalink_template`. Availability in schema and Author capability data does not prove future write behavior.

### Authenticated category contract

**DISCOVERED FACT:** The taxonomy schema remained readable and confirms that assignment uses `assign_categories`, while create/edit/delete taxonomy operations use separate management capabilities. A category collection request with `context=edit` returned HTTP 403 `rest_forbidden_context` for the Author account; the terms REST controller requires the taxonomy `edit_terms` capability for edit context. This tested taxonomy-term editing, not assignment of existing terms to a post. Public category reads remain available from the approved public discovery.

The resulting least-privilege contract is: category creation/edit/delete and broader taxonomy management are denied; assignment of existing categories is supported by WordPress core capability mapping because the account has `edit_posts`. No role or capability change is required. Actual REST assignment remains **UNVERIFIED UNTIL ROUND 2B WRITE TEST**.

### Authenticated media and featured media

**DISCOVERED FACT:** An authenticated media collection query restricted to author ID 2 returned HTTP 200 and zero attachments. The media OPTIONS schema remained accessible and advertises title, caption, description, alt text, parent post, author, date, slug, status, template, and meta. `upload_files` is true in authenticated capability data. The post schema continues to expose standard attachment-ID `featured_media`.

**UNVERIFIED UNTIL ROUND 2B WRITE TEST:** Upload acceptance, file limits, attachment behavior, media metadata changes, and featured-media assignment. No material authenticated plugin/security difference was observed in the media schema.

### Authenticated meta and plugin/theme fields

**DISCOVERED FACT:** Authenticated post schema exposes registered Astra layout/display meta, Elementor edit mode/template/data/page settings/conditions, and core `footnotes`. No newsroom-specific top-level field or registered reconciliation meta was exposed. No publishing-relevant SureRank, LiteSpeed, or Hostinger post field appeared in the authenticated core post schema.

The post collection GET contract still advertises no arbitrary-meta query parameter. Astra, Elementor, SureRank, and unrelated plugin fields are not suitable idempotency storage.

**LIVE PRODUCTION STATE — RECONCILIATION CONTRACT: UNRESOLVED.** Round 2A discovered no suitable newsroom reconciliation mechanism on the live Simbidzebasa WordPress site. That historical finding remains accurate because Newsroom Bridge has not been deployed, installed, or activated.

**LOCAL APPROVED ARCHITECTURE:** Round 2B.0 provides supervisor-approved local Newsroom Bridge source using a private plugin-owned reconciliation table with `PRIMARY KEY (draft_key)`, `UNIQUE (post_id)`, and reservation-token transaction ownership. Its REST contract provides `POST /newsroom/v1/drafts` and `GET /newsroom/v1/drafts/{draft_key}`; after an uncertain outcome, reconciliation by GET is mandatory before any create retry. Ordinary or private post meta is not the primary idempotency mechanism.

The local bridge is **NOT DEPLOYED**, **NOT INSTALLED**, **NOT ACTIVATED**, **NOT WORDPRESS-INTEGRATION-TESTED**, and **NOT PRODUCTION-VALIDATED**.

### Timezone and date contract

**DISCOVERED FACT:** The dedicated Author account received HTTP 403 `rest_forbidden` from the filtered settings endpoint. A prior read-only administrator discovery established WordPress timezone `Africa/Harare`, date format `F j, Y`, and time format `g:i a`; these settings are not exposed to the production-oriented Author credential. A separate GMT offset was not returned. Post schema exposes both `date` and `date_gmt`; later integration must validate their write behavior against the named timezone.

## 11. HTTP, proxy, and security behavior

- **DISCOVERED FACT:** HTTPS front-page and REST requests succeeded.
- **DISCOVERED FACT:** The canonical front page returned 200 with no redirect.
- **DISCOVERED FACT:** The server header reported `hcdn`, indicating an intermediary at the HTTP delivery layer.
- **DISCOVERED FACT:** No bot challenge, REST block, `Retry-After`, or rate-limit header was observed in the small sequential request set.
- **DISCOVERED FACT:** One initial PowerShell HTTP client attempt timed out before receiving a response; subsequent controlled curl requests succeeded.
- **DISCOVERED FACT:** After correcting the configured username, authenticated Application Password requests returned HTTP 200 through `hcdn` without a redirect, bot challenge, or explicit WAF error.
- **INFERENCE:** Authorization currently reaches WordPress through the observed Hostinger/hCDN path.
- **INFERENCE:** Future client timeouts and retries should tolerate intermittent transport behavior without assuming a failed request means no WordPress side effect.

No bypass, scan, brute force, load test, or unrelated administration request was attempted.

## 12. Unknowns requiring controlled Round 2B validation

1. Actual draft creation/editing, publication, category assignment, featured-media assignment, and registered-meta writes.
2. Accepted draft fields and sanitization/rendering behavior.
3. Installation, schema, transaction ownership, uniqueness, deterministic lookup, and runtime behavior of the approved local Newsroom Bridge.
4. Idempotent recovery after an uncertain draft-create response.
5. Media size/MIME limits, upload response, metadata updates, and attachment behavior.
6. Category synchronization and retirement behavior.
7. Theme/plugin behavior for a controlled draft, including byline presentation and Astra, Elementor, SureRank, LiteSpeed, or Hostinger effects.
8. Exact `date`/`date_gmt` write behavior under `Africa/Harare`.

## 13. Round 2B recommendation

**CONDITIONAL GO.**

Public and authenticated read-only discovery support core `post`, standard categories/tags, normal media/featured-media structures, Application Password authentication, and a dedicated Author integration identity. WordPress core capability mapping supports assignment of existing categories through the account's confirmed `edit_posts` capability while taxonomy management remains denied. Round 2A remains the historical record that the live site has no discovered reconciliation primitive. Round 2B.0 has now satisfied the local source/design gate with the supervisor-approved Newsroom Bridge architecture, but controlled runtime and production integration are not approved.

Before any controlled draft creation, Round 2B should:

1. Complete and obtain approval for Round 2B.1 runtime and fault-injection validation of the Newsroom Bridge in a disposable or staging WordPress environment.
2. Only after that approval, implement an isolated WordPress adapter with strict redaction, bounded timeouts, and reconciliation-first retry behavior.
3. Synchronize categories by authoritative WordPress ID without seeding or deriving names/slugs.
4. Perform only the explicitly approved controlled DRAFT, category-assignment, and media tests; do not publicly publish during Round 2B.

The recommendation is not a claim that any write capability has been proven.

## 14. Local Round 2B trust-boundary contract

Round 2B.2A approved replacing the generic backend WordPress credential with a newsroom-scoped HMAC boundary. Round 2B.2B now provides local production-quality Newsroom Bridge 1.1.0 source for that contract, under supervisor review. This does not change the historical Round 2A live-site findings and has not been installed, activated, or validated on Simbidzebasa.

Deployment configuration supplies `NEWSROOM_BRIDGE_USER_ID`, literal boolean lockdown/HMAC flags, and a JSON draft-key ring outside WordPress database storage. A configured key is a canonical 256-bit base64url secret and strict non-secret key ID. No repository or WordPress database value contains a production key.

When enabled, HMAC authority is recognized only for direct top-level `POST /newsroom/v1/drafts` and `GET /newsroom/v1/drafts/{canonical-lowercase-UUID-v4}`. Version 1 binds key ID, uppercase method, concrete canonical REST route, Unix timestamp, and the SHA-256 hash of the exact raw body. POST requires the frozen JSON Content-Type policy; GET requires zero bytes and no Content-Type. Queries, method overrides, ambiguous route/header representations, prior WordPress authentication, and every non-approved route receive the same HTTP 401 authentication failure.

After complete validation, WordPress retains a request-bound proof without service authority. Narrow wrappers temporarily establish the configured reduced service user only while invoking the unchanged bridge permission and route callbacks; required capabilities are `read` and `edit_posts`, and the approved dangerous-capability set must remain absent. Each authority period restores the previous user in `finally`. Any nested REST server dispatch while authority is active returns the generic 401, including recursive or mutated reuse of the top-level request object. No cookie, login session, nonce, or Application Password is created.

Effective service lockdown denies ordinary-password and Application Password authentication only for that identity. It remains enabled if either security flag is malformed. Unrelated WordPress users remain unaffected. The plugin does not mutate roles, capabilities, passwords, or stored Application Passwords. HMAC enabled without valid explicit lockdown configuration fails closed while lockdown remains effective, preventing simultaneous generic and HMAC service authority.

Publication, media authority, backend adapter work, production ingress validation, credential migration, and deployment remain outside this local implementation round. Production remains **NO-GO** pending supervisor source/runtime review and the separately authorized migration and production gates.
