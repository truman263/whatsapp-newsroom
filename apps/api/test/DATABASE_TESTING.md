# PostgreSQL constraint testing

Run the database integration suite separately:

```bash
pnpm test:db
```

The command requires an ignored local `.env` or process environment containing `DATABASE_URL` for a dedicated development/test PostgreSQL schema. It is intentionally separate from unit and HTTP e2e tests.

The suite physically verifies the nine domain tables, fourteen enums, foreign keys, unique and ordinary indexes, seven manual checks, intended temporal/WordPress identifier types, nullable unique semantics, referential actions, short transaction rollback, optimistic compare-and-set, and the concurrent inbound provider-message uniqueness boundary.

Fixtures use generated `DBTEST`/`dbtest:` markers. Before and after execution, cleanup selects only that test namespace and deletes it in dependency order. It never truncates the schema or unrelated tables. Successful cleanup leaves every domain table empty when the schema began empty.

SQLite and mocked Prisma clients are not acceptable substitutes for this suite.
