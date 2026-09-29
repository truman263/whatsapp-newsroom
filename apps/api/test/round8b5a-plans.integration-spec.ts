import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/database/prisma.service";
import { BacklogMetricsService } from "../src/worker/backlog-metrics.service";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(600_000);

const prisma = new PrismaService();
type PlanRow = { "QUERY PLAN": unknown };

function planSummary(value: unknown): Record<string, unknown> {
  const document = (value as Array<Record<string, unknown>>)[0];
  if (!document) throw new Error("EMPTY_QUERY_PLAN");
  const root = document.Plan as Record<string, unknown>;
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>): void => {
    nodes.push(node);
    for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? [])
      visit(child);
  };
  visit(root);
  return {
    executionMs: document["Execution Time"],
    planningMs: document["Planning Time"],
    rows: root["Actual Rows"],
    nodes: nodes.map((node) => ({
      type: node["Node Type"],
      relation: node["Relation Name"],
      index: node["Index Name"],
      actualRows: node["Actual Rows"],
      removed: node["Rows Removed by Filter"],
      sort: node["Sort Method"],
      sharedHits: node["Shared Hit Blocks"],
      sharedReads: node["Shared Read Blocks"],
    })),
  };
}

async function explain(name: string, sql: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<PlanRow[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const summary = planSummary(rows[0]?.["QUERY PLAN"]);
  console.info(JSON.stringify({ proof: "round8b5a_query_plan", name, ...summary }));
  return summary;
}

describe("Round 8B.5A production selector plans at scale", () => {
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it("measures every worker selector and backlog query against 10,000 rows per table", async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE');
    const reporterId = randomUUID();
    await prisma.reporter.create({
      data: {
        id: reporterId,
        phoneNumber: "+263770000000",
        displayName: "8B5A plan proof",
      },
    });
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Story" ("id", "reporterId", "wordpressDraftKey", "createdAt", "updatedAt")
      SELECT md5('story-' || n)::uuid, '${reporterId}'::uuid,
             md5('draft-key-' || n)::uuid, NOW(), NOW()
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "InboundEvent" ("id", "provider", "providerMessageId", "senderPhone",
        "senderIngestSequence", "eventType", "processingStatus", "rawPayload",
        "processingStartedAt", "receivedAt", "createdAt", "updatedAt")
      SELECT md5('event-' || n)::uuid, 'WHATSAPP'::"Provider", 'plan-' || n,
             '+263770000000', n, 'TEXT'::"InboundEventType",
             (CASE n % 4 WHEN 0 THEN 'RECEIVED' WHEN 1 THEN 'PROCESSING'
               WHEN 2 THEN 'PROCESSED' ELSE 'FAILED' END)::"InboundProcessingStatus",
             '{}'::jsonb, CASE WHEN n % 4 = 1 THEN NOW() - INTERVAL '10 minutes' ELSE NULL END,
             NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond', NOW(), NOW()
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "StoryMedia" ("id", "storyId", "providerMediaId", "mediaType",
        "status", "position", "createdAt", "updatedAt")
      SELECT md5('media-' || n)::uuid, md5('story-' || n)::uuid,
             'plan-media-' || n, 'IMAGE'::"StoryMediaType",
             (CASE n % 6 WHEN 0 THEN 'RECEIVED' WHEN 1 THEN 'FETCHING'
               WHEN 2 THEN 'FETCHED' WHEN 3 THEN 'UPLOADING'
               WHEN 4 THEN 'UPLOADED' ELSE 'FAILED' END)::"MediaProcessingStatus",
             0, NOW(), NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond'
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "OutboundMessage" ("id", "reporterId", "storyId", "type",
        "status", "correlationKey", "payload", "requestedAt", "createdAt", "updatedAt")
      SELECT md5('outbound-' || n)::uuid, '${reporterId}'::uuid,
             md5('story-' || n)::uuid, 'TEXT'::"OutboundMessageType",
             (CASE n % 4 WHEN 0 THEN 'PENDING' WHEN 1 THEN 'SENDING'
               WHEN 2 THEN 'SENT' ELSE 'FAILED' END)::"OutboundMessageStatus",
             'plan-outbound-' || n, '{}'::jsonb,
             NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond', NOW(),
             NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond'
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "DraftPreparation" ("id", "storyId", "inboundEventId", "storyVersion",
        "status", "approvalPromptCorrelationKey", "previewExpiresAt",
        "startedAt", "createdAt", "updatedAt")
      SELECT md5('preparation-' || n)::uuid, md5('story-' || n)::uuid,
             md5('event-' || n)::uuid, 0,
             (CASE n % 4 WHEN 0 THEN 'ACTIVE' WHEN 1 THEN 'RECONCILIATION_REQUIRED'
               WHEN 2 THEN 'READY_FOR_APPROVAL' ELSE 'FAILED' END)::"DraftPreparationStatus",
             'plan-preparation-' || n, NOW() + INTERVAL '1 hour', NOW(), NOW(),
             NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond'
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Approval" ("id", "storyId", "reporterId", "inboundEventId",
        "draftPreparationId", "storyVersion", "wordpressAppliedVersion", "createdAt")
      SELECT md5('approval-' || n)::uuid, md5('story-' || n)::uuid,
             '${reporterId}'::uuid, md5('event-' || n)::uuid,
             md5('preparation-' || n)::uuid, 0, repeat('a', 64), NOW()
      FROM generate_series(1, 10000) n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "PublishAttempt" ("id", "storyId", "operation", "status",
        "attemptNumber", "idempotencyKey", "approvalId", "createdAt", "updatedAt")
      SELECT md5('publish-' || n)::uuid, md5('story-' || n)::uuid,
             'PUBLISH'::"PublishOperation",
             (CASE n % 4 WHEN 0 THEN 'PENDING' WHEN 1 THEN 'IN_PROGRESS'
               WHEN 2 THEN 'SUCCEEDED' ELSE 'RECONCILIATION_REQUIRED' END)::"PublishAttemptStatus",
             1, 'plan-publish-' || n, md5('approval-' || n)::uuid,
             NOW() - INTERVAL '10 minutes' + n * INTERVAL '1 millisecond', NOW()
      FROM generate_series(1, 10000) n
    `);
    for (const table of [
      "InboundEvent", "StoryMedia", "DraftPreparation", "OutboundMessage", "PublishAttempt",
    ]) {
      await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
      const count = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint count FROM "${table}"`,
      );
      expect(count[0]?.count).toBe(10000n);
    }
    const ordinaryReceivedSql = `SELECT candidate."id" FROM "InboundEvent" candidate
        WHERE candidate."processingStatus"='RECEIVED'::"InboundProcessingStatus"
        AND NOT EXISTS (SELECT 1 FROM LATERAL (SELECT earlier."id" FROM "InboundEvent" earlier
          WHERE earlier."senderPhone"=candidate."senderPhone"
          AND earlier."senderIngestSequence"<candidate."senderIngestSequence"
          AND earlier."processingStatus" IN ('RECEIVED'::"InboundProcessingStatus",'PROCESSING'::"InboundProcessingStatus")
          LIMIT 1) predecessor)
        ORDER BY candidate."receivedAt",candidate."id" LIMIT 25`;
    const plans = await Promise.all([
      explain("ordinary_received_many_blocked", ordinaryReceivedSql),
      explain("stale_inbound", `SELECT "id" FROM "InboundEvent"
        WHERE "processingStatus"='PROCESSING'::"InboundProcessingStatus"
        AND "processingStartedAt"<NOW() - INTERVAL '5 minutes'
        ORDER BY "processingStartedAt","id" LIMIT 25`),
      explain("media", `SELECT "id" FROM "StoryMedia"
        WHERE "status" IN ('RECEIVED'::"MediaProcessingStatus",'FETCHING'::"MediaProcessingStatus")
        ORDER BY "updatedAt","id" LIMIT 25`),
      explain("draft", `SELECT "id" FROM "DraftPreparation"
        WHERE "status" IN ('ACTIVE'::"DraftPreparationStatus",'RECONCILIATION_REQUIRED'::"DraftPreparationStatus")
        ORDER BY "updatedAt","id" LIMIT 25`),
      explain("outbound_pending", `SELECT "id" FROM "OutboundMessage"
        WHERE "status"='PENDING'::"OutboundMessageStatus"
        ORDER BY "requestedAt","id" LIMIT 25`),
      explain("stale_sending", `SELECT "id" FROM "OutboundMessage"
        WHERE "status"='SENDING'::"OutboundMessageStatus"
        AND "updatedAt"<NOW() - INTERVAL '5 minutes'
        ORDER BY "updatedAt","id" LIMIT 25`),
      explain("publication", `SELECT "id" FROM "PublishAttempt"
        WHERE "operation"='PUBLISH'::"PublishOperation"
        AND "status" IN ('PENDING'::"PublishAttemptStatus",'IN_PROGRESS'::"PublishAttemptStatus")
        ORDER BY "createdAt","id" LIMIT 25`),
      explain("backlog_aggregation", `SELECT subsystem,status,COUNT(*)::bigint,MIN(oldest) FROM (
        SELECT 'inbound' subsystem,"processingStatus"::text status,"receivedAt" oldest FROM "InboundEvent"
          WHERE "processingStatus" IN ('RECEIVED','PROCESSING','FAILED','IGNORED')
        UNION ALL SELECT 'media',"status"::text,"updatedAt" FROM "StoryMedia"
          WHERE "status" IN ('RECEIVED','FETCHING','UPLOADING','FAILED')
        UNION ALL SELECT 'draft',"status"::text,"updatedAt" FROM "DraftPreparation"
          WHERE "status" IN ('ACTIVE','RECONCILIATION_REQUIRED','BLOCKED','FAILED')
        UNION ALL SELECT 'outbound',"status"::text,"updatedAt" FROM "OutboundMessage"
          WHERE "status" IN ('PENDING','SENDING','FAILED')
        UNION ALL SELECT 'publish',"status"::text,"updatedAt" FROM "PublishAttempt"
          WHERE "operation"='PUBLISH' AND "status" IN ('PENDING','IN_PROGRESS','RECONCILIATION_REQUIRED','FAILED')
      ) rows GROUP BY subsystem,status ORDER BY subsystem,status`),
    ]);
    expect(plans).toHaveLength(8);
    await prisma.$executeRawUnsafe(`UPDATE "InboundEvent"
      SET "senderPhone" = '+263' || lpad("senderIngestSequence"::text, 9, '0')
      WHERE "processingStatus"='RECEIVED'::"InboundProcessingStatus"`);
    await prisma.$executeRawUnsafe('ANALYZE "InboundEvent"');
    await explain("ordinary_received_many_eligible", ordinaryReceivedSql);
    await prisma.$executeRawUnsafe(`UPDATE "InboundEvent"
      SET "senderPhone" = CASE WHEN "senderIngestSequence" % 8 = 0
        THEN '+263770000000' ELSE '+263' || lpad("senderIngestSequence"::text, 9, '0') END
      WHERE "processingStatus"='RECEIVED'::"InboundProcessingStatus"`);
    await prisma.$executeRawUnsafe('ANALYZE "InboundEvent"');
    await explain("ordinary_received_mixed", ordinaryReceivedSql);
    await prisma.$executeRawUnsafe(`UPDATE "InboundEvent"
      SET "processingStatus"='PROCESSED'::"InboundProcessingStatus"
      WHERE "processingStatus" IN ('RECEIVED'::"InboundProcessingStatus",'PROCESSING'::"InboundProcessingStatus")
        AND "senderIngestSequence" > 100`);
    await prisma.$executeRawUnsafe('ANALYZE "InboundEvent"');
    await explain("ordinary_received_terminal_heavy", ordinaryReceivedSql);
    const started = performance.now();
    const rendered = await new BacklogMetricsService(prisma).render();
    const renderMs = performance.now() - started;
    expect(rendered).toContain("newsroom_worker_backlog");
    console.info(JSON.stringify({ proof: "round8b5a_backlog_render", rowsPerTable: 10000, renderMs }));
  });
});
