# Simbidzebasa WordPress contract

## 1. Discovery scope

Round 2A performed read-only contract discovery against the production public site. Only `HEAD`, `GET`, and `OPTIONS` were used. No authenticated request, write request, form submission, administrative login, database synchronization, or security probing was performed.

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

- `WORDPRESS_USERNAME`: absent.
- `WORDPRESS_APPLICATION_PASSWORD`: absent.
- **AUTHENTICATED DISCOVERY: BLOCKED — CREDENTIALS NOT CONFIGURED.**

No alternative authentication was attempted. Before authenticated discovery can be completed, an administrator must manually provide a least-privilege WordPress integration username and its Application Password through ignored environment configuration. Round 2A did not create credentials or access `wp-admin`.

- **ADVERTISED BY SCHEMA:** Posts, categories, and media collection routes advertise `POST`; individual posts advertise update and delete methods.
- **UNCONFIRMED UNTIL ROUND 2B WRITE TEST:** Integration-user identity; ability to edit posts, create drafts, publish, upload files, assign categories, set featured media, or use post meta.
- **UNCONFIRMED UNTIL ROUND 2B WRITE TEST:** Application Password authentication and any WAF/security-middleware interaction with authenticated requests.

Publishing timezone/date settings were not requested because authenticated configuration was unavailable.

## 11. HTTP, proxy, and security behavior

- **DISCOVERED FACT:** HTTPS front-page and REST requests succeeded.
- **DISCOVERED FACT:** The canonical front page returned 200 with no redirect.
- **DISCOVERED FACT:** The server header reported `hcdn`, indicating an intermediary at the HTTP delivery layer.
- **DISCOVERED FACT:** No bot challenge, REST block, `Retry-After`, or rate-limit header was observed in the small sequential request set.
- **DISCOVERED FACT:** One initial PowerShell HTTP client attempt timed out before receiving a response; subsequent controlled curl requests succeeded.
- **INFERENCE:** Future client timeouts and retries should tolerate intermittent transport behavior without assuming a failed request means no WordPress side effect.

No bypass, scan, brute force, load test, or unrelated administration request was attempted.

## 12. Unknowns requiring controlled Round 2B validation

1. Application Password authentication and integration-user identity.
2. Exact least-privilege capabilities for draft creation, editing, publication, media upload, category assignment, featured media, and meta.
3. Accepted draft fields and sanitization/rendering behavior.
4. Whether a private, durable, REST-retrievable and deterministically searchable reconciliation field can be registered.
5. Idempotent recovery after an uncertain draft-create response.
6. Media size/MIME limits, upload response, metadata updates, and attachment behavior.
7. Category synchronization permissions and retirement behavior.
8. Theme/plugin behavior when creating a controlled draft, including byline presentation and any Astra, Elementor, SureRank, LiteSpeed, or Hostinger effects.
9. Timezone/date behavior in authenticated edit context.

## 13. Round 2B recommendation

**CONDITIONAL GO.**

Public discovery supports core `post`, standard categories/tags, multiple category IDs, normal media attachments, and standard featured-media references. Round 2B may begin only after supervisor approval and manual least-privilege Application Password configuration.

Before any controlled draft creation, Round 2B should:

1. Authenticate with a least-privilege integration account and confirm capabilities through read-only requests first.
2. Resolve the reconciliation contract. Preferred option: a minimal dedicated WordPress extension that registers a private UUID meta field for posts, exposes it in authenticated REST edit context, enforces uniqueness or deterministic lookup, and prevents editorial/theme display. Confirm search/retrieval before relying on it.
3. Implement an isolated WordPress adapter with strict redaction, bounded timeouts, and reconciliation-first retry behavior.
4. Synchronize categories by authoritative WordPress ID without seeding or deriving names/slugs.
5. Perform only the explicitly approved controlled DRAFT and media tests; do not publicly publish during Round 2B.

The recommendation is not a claim that any write capability has been proven.
