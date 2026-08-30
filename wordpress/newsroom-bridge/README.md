# Newsroom Bridge

Local source for the WordPress-side idempotent draft-creation and reconciliation primitive. The local source has passed supervisor source audit; it is not deployed, installed, activated, WordPress-integration-tested, or production-validated.

## Configuration

Define the dedicated integration user ID outside this plugin, for example in the target site's protected configuration:

```php
define( 'NEWSROOM_BRIDGE_USER_ID', 2 );
```

The value is deployment configuration, not plugin business logic. Both custom routes fail closed unless the authenticated REST user matches it and has `edit_posts`.

## Routes

- `POST /wp-json/newsroom/v1/drafts`
- `GET /wp-json/newsroom/v1/drafts/{draft_key}`

There is no publish, delete, update, media, category-management, user, settings, admin UI, or debug route.

Activation installs the private reconciliation table. Deactivation and uninstall intentionally retain it. Production installation, activation, table-engine verification, and controlled request validation are pending supervisor approval.
