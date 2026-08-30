# Security and data minimisation

- Secrets are deployment configuration and must never be committed or persisted in domain tables.
- The database must never contain WhatsApp access tokens/app secrets, WordPress Application Passwords, or authorization headers.
- Configuration objects and secret values must never be passed to application logging.
- `InboundEvent.rawPayload` stores only the normalised provider event needed for evidence/debugging, not a raw HTTP request object.
- Outbound payloads contain intended provider-neutral content, not provider credentials or secret headers.
- Audit metadata is minimal, sanitised, and excludes unnecessary personal data.
- Error codes/messages contain sanitised operational information only.
- Reporter and sender phone numbers are operational identity data. They are canonicalised as E.164 at the application boundary and are not duplicated outside fields required for authorization, ingestion, relations, or investigation.
- WhatsApp webhook authenticity verification remains mandatory in Round 3.
- All external communications use HTTPS.
- WordPress will use a dedicated least-privilege integration account and Application Password.
- Database uniqueness makes inbound processing idempotent at the normalised provider-message boundary.
- Publication requires durable, explicit positive approval.
- Security-sensitive and publication actions are auditable.
- Text, metadata, file types, sizes, and media content require validation before use.
- AI must not make or bypass publication-control decisions.

Database referential actions preserve approval, publish-attempt, and inbound evidence. There are no routine domain deletion APIs or cascading deletes.
