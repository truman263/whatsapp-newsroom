import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../prisma/migrations/20260913190000_round_7b_0_approval_publish_attempt_authority/migration.sql",
  ),
  "utf8",
);

describe("Round 7B.0 migration contract", () => {
  it("guards legacy authority before adding the relation", () => {
    expect(migration).toContain("ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED");
    expect(migration).toContain(
      "ROUND_7B_0_PUBLISH_AUTHORITY_BACKFILL_REQUIRED",
    );
    expect(
      migration.indexOf("ROUND_6B_0_APPROVAL_BACKFILL_REQUIRED"),
    ).toBeLessThan(migration.indexOf('ADD COLUMN "approvalId"'));
    expect(
      migration.indexOf("ROUND_7B_0_PUBLISH_AUTHORITY_BACKFILL_REQUIRED"),
    ).toBeLessThan(migration.indexOf('ADD COLUMN "approvalId"'));
  });

  it("adds the unique restrictive relation and operation check", () => {
    expect(migration).toContain('"PublishAttempt_approvalId_key"');
    expect(migration).toContain('"PublishAttempt_approvalId_fkey"');
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(migration).toContain(
      '"PublishAttempt_operation_approval_authority_check"',
    );
    expect(migration).toContain(
      '"operation" = \'PUBLISH\'::"PublishOperation"',
    );
    expect(migration).toContain('AND "approvalId" IS NOT NULL');
    expect(migration).toContain('AND "approvalId" IS NULL');
  });
});
