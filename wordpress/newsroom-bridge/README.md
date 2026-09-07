# Newsroom Bridge

Local source for the WordPress-side idempotent draft-creation, reconciliation, and route-scoped authentication boundary. The reconciliation core has passed supervisor source and disposable-runtime audits. Version 1.1.0 adds the Round 2B.2B production-quality trust-boundary implementation, which remains under supervisor review. Nothing here is deployed, installed, activated, or tested on Simbidzebasa.

## Configuration

Define security configuration outside WordPress database storage, for example in protected deployment configuration:

```php
define( 'NEWSROOM_BRIDGE_USER_ID', 2 );
define( 'NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED', true );
define( 'NEWSROOM_BRIDGE_HMAC_ENABLED', true );
define( 'NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON', '[{"id":"draft-key-id","secret":"<canonical-43-character-base64url-secret>"}]' );
define( 'NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED', false );
```

The example shows shape only and contains no usable secret. The service identity requires exactly the approved reduced capability policy. HMAC enablement requires explicit lockdown enablement; malformed configuration fails closed. HMAC enablement also makes lockdown effective so a configuration mismatch cannot create simultaneous generic and route-scoped authority. The plugin validates policy and does not alter users, roles, capabilities, passwords, or Application Password records.

## Routes

- `POST /wp-json/newsroom/v1/drafts`
- `GET /wp-json/newsroom/v1/drafts/{draft_key}`

There is no publish, delete, update, media, category-management, user, settings, admin UI, or debug route.

HMAC version 1 accepts only direct top-level requests for these two method/route pairs. Authentication creates a request-bound proof without establishing a service user. Only the frozen permission and route callbacks receive temporary service authority, and each invocation restores the previous user in `finally`. Every nested REST dispatch is denied while that authority is active. Its password and Application Password authentication are denied while lockdown is effective; malformed security flags retain identity-scoped lockdown, and unrelated users remain governed by ordinary WordPress behavior.

Activation installs only the private reconciliation table. Authentication secrets are never written to WordPress storage. Deactivation and uninstall intentionally retain reconciliation history. Production installation, activation, ingress duplicate-header proof, migration, and controlled request validation remain pending supervisor approval.
