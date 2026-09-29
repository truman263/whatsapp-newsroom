import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { InboundEventType, InboundProcessingStatus, Provider } from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";
import { InboundEventDriverService } from "../src/modules/reporter-workflow/inbound-event-driver.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { InboundEventRecoveryService } from "../src/modules/reporter-workflow/inbound-event-recovery.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(900_000);

const prisma = new PrismaService();
type Activity = { total: bigint; active: bigint; idle: bigint; lockWaits: bigint };

function driver(database: PrismaService): InboundEventDriverService {
  const processing = new InboundEventProcessingService(
    database,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
    new StoredWhatsappEventParser(),
    new StoryEventProcessor(new ConversationStateMachineService(database)),
  );
  return new InboundEventDriverService(
    database,
    processing,
    new InboundEventRecoveryService(database, processing),
  );
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function poolUrl(connectionLimit: number): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("connection_limit", String(connectionLimit));
  return url.toString();
}

async function activity(): Promise<Activity> {
  const rows = await prisma.$queryRaw<Activity[]>`
    SELECT COUNT(*)::bigint total,
      COUNT(*) FILTER (WHERE state = 'active')::bigint active,
      COUNT(*) FILTER (WHERE state = 'idle')::bigint idle,
      COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::bigint "lockWaits"
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
  `;
  if (!rows[0]) throw new Error("PG_ACTIVITY_UNAVAILABLE");
  return rows[0];
}

async function deadlocks(): Promise<bigint> {
  const rows = await prisma.$queryRaw<Array<{ deadlocks: bigint }>>`
    SELECT deadlocks::bigint FROM pg_stat_database WHERE datname = current_database()
  `;
  return rows[0]?.deadlocks ?? 0n;
}

async function candidateLatency(batch: number): Promise<{ latencies: number[]; candidates: number }> {
  const latencies: number[] = [];
  let candidates = 0;
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now();
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT candidate."id" FROM "InboundEvent" candidate
      WHERE candidate."processingStatus" = 'RECEIVED'::"InboundProcessingStatus"
        AND NOT EXISTS (SELECT 1 FROM LATERAL (
          SELECT earlier."id" FROM "InboundEvent" earlier
          WHERE earlier."senderPhone" = candidate."senderPhone"
            AND earlier."senderIngestSequence" < candidate."senderIngestSequence"
            AND earlier."processingStatus" IN ('RECEIVED'::"InboundProcessingStatus", 'PROCESSING'::"InboundProcessingStatus")
          LIMIT 1
        ) predecessor)
      ORDER BY candidate."receivedAt", candidate."id" LIMIT ${batch}
    `;
    latencies.push(performance.now() - start);
    candidates = rows.length;
  }
  return { latencies, candidates };
}

type Case = { batch: number; contenders: number; pool: number; mode: "many_senders" | "single_sender"; cycles?: number };

async function runCase(input: Case): Promise<Record<string, unknown>> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "InboundEvent" CASCADE');
  await prisma.inboundEvent.createMany({
    data: Array.from({ length: 50 }, (_, index) => {
      const senderPhone = input.mode === "single_sender"
        ? "+263778000001"
        : `+263778${String(index).padStart(6, "0")}`;
      return {
        provider: Provider.WHATSAPP,
        providerMessageId: randomUUID(),
        senderPhone,
        senderIngestSequence: input.mode === "single_sender" ? BigInt(index * 2 + 1) : 1n,
        eventType: InboundEventType.TEXT,
        rawPayload: {
          message: {
            id: `capacity-${index}`,
            from: senderPhone.slice(1),
            timestamp: "1760000000",
            type: "text",
            text: { body: "capacity proof" },
          },
        },
      };
    }),
  });
  const query = await candidateLatency(input.batch);
  const clients = await Promise.all(
    Array.from({ length: input.contenders }, async () => {
      const client = new PrismaService({ datasources: { db: { url: poolUrl(input.pool) } } });
      await client.$connect();
      return client;
    }),
  );
  const beforeDeadlocks = await deadlocks();
  let monitoring = true;
  let peakConnections = 0;
  let peakActive = 0;
  let peakIdle = 0;
  let peakLockWaits = 0;
  const monitor = (async (): Promise<void> => {
    while (monitoring) {
      const row = await activity();
      peakConnections = Math.max(peakConnections, Number(row.total));
      peakActive = Math.max(peakActive, Number(row.active));
      peakIdle = Math.max(peakIdle, Number(row.idle));
      peakLockWaits = Math.max(peakLockWaits, Number(row.lockWaits));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const cycleMs: number[] = [];
  const started = performance.now();
  const outcomes: PromiseSettledResult<unknown>[] = [];
  try {
    for (let cycle = 0; cycle < (input.cycles ?? 1); cycle++) {
      const cycleOutcomes = await Promise.allSettled(
        clients.map(async (client) => {
          const cycleStarted = performance.now();
          try {
            return await driver(client).processReceived(input.batch);
          } finally {
            cycleMs.push(performance.now() - cycleStarted);
          }
        }),
      );
      outcomes.push(...cycleOutcomes);
      if (input.cycles && (await prisma.inboundEvent.count({
        where: { processingStatus: InboundProcessingStatus.RECEIVED },
      })) === 0) break;
    }
  } finally {
    monitoring = false;
    await monitor;
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
  const durationMs = performance.now() - started;
  const failed = outcomes.filter((outcome) => outcome.status === "rejected");
  const transactionTimeouts = failed.filter((outcome) =>
    /P2028|expired transaction|Transaction already closed/i.test(String(outcome.reason)),
  ).length;
  const poolTimeouts = failed.filter((outcome) =>
    /P2024|connection pool|pool timeout/i.test(String(outcome.reason)),
  ).length;
  const statuses = await prisma.inboundEvent.groupBy({
    by: ["processingStatus"],
    _count: { id: true },
  });
  const completed = statuses.find((row) => row.processingStatus === InboundProcessingStatus.IGNORED)?._count.id ?? 0;
  const audits = await prisma.auditLog.count({ where: { eventType: "inbound_event_ignored" } });
  const maxAttempts = await prisma.inboundEvent.aggregate({ _max: { processingAttempts: true } });
  expect(audits).toBe(completed);
  expect(maxAttempts._max.processingAttempts).toBeLessThanOrEqual(1);
  expect(await prisma.inboundEvent.count()).toBe(50);
  const result = {
    proof: "round8b5a_capacity_case",
    ...input,
    candidates: query.candidates,
    completed,
    remaining: 50 - completed,
    durationMs,
    queryP50Ms: percentile(query.latencies, 0.5),
    queryP95Ms: percentile(query.latencies, 0.95),
    queryP99Ms: percentile(query.latencies, 0.99),
    cycleP50Ms: percentile(cycleMs, 0.5),
    cycleP95Ms: percentile(cycleMs, 0.95),
    cycleP99Ms: percentile(cycleMs, 0.99),
    transactionTimeouts,
    poolTimeouts,
    databaseErrors: failed.length - transactionTimeouts - poolTimeouts,
    peakConnections,
    peakActive,
    peakIdle,
    peakLockWaits,
    deadlocks: Number((await deadlocks()) - beforeDeadlocks),
    duplicateDurableEffects: 0,
  };
  console.info(JSON.stringify(result));
  return result;
}

describe("Round 8B.5A same-sender batch and connection envelope", () => {
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it("measures batch 1 through 100 at twenty contenders and representative connection pools", async () => {
    const cases: Case[] = [
      ...[1, 5, 10, 25, 50, 100].map((batch) => ({ batch, contenders: 20, pool: 1, mode: "many_senders" as const })),
      ...[1, 2, 4, 8].map((contenders) => ({ batch: 25, contenders, pool: 1, mode: "many_senders" as const })),
      { batch: 25, contenders: 4, pool: 2, mode: "many_senders" },
      { batch: 25, contenders: 4, pool: 4, mode: "many_senders" },
      { batch: 100, contenders: 20, pool: 1, mode: "single_sender", cycles: 55 },
    ];
    const results: Record<string, unknown>[] = [];
    for (const input of cases) results.push(await runCase(input));
    expect(results).toHaveLength(13);
    expect(results.every((result) => Number(result.peakConnections) >= 1)).toBe(true);
  });

  it("reads server-side connection peaks across bounded pool-pressure combinations", async () => {
    const combinations = [
      ...[1, 2, 4, 8].flatMap((contenders) =>
        [1, 2, 4].map((pool) => ({ contenders, pool })),
      ),
      { contenders: 20, pool: 1 },
      { contenders: 20, pool: 2 },
    ];
    for (const input of combinations) {
      const clients = await Promise.all(
        Array.from({ length: input.contenders }, async () => {
          const client = new PrismaService({ datasources: { db: { url: poolUrl(input.pool) } } });
          await client.$connect();
          return client;
        }),
      );
      let monitoring = true;
      let peakConnections = 0;
      let peakActive = 0;
      let peakIdle = 0;
      let peakLockWaits = 0;
      const monitor = (async (): Promise<void> => {
        while (monitoring) {
          const row = await activity();
          peakConnections = Math.max(peakConnections, Number(row.total));
          peakActive = Math.max(peakActive, Number(row.active));
          peakIdle = Math.max(peakIdle, Number(row.idle));
          peakLockWaits = Math.max(peakLockWaits, Number(row.lockWaits));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      const queryMs: number[] = [];
      const started = performance.now();
      let outcomes: PromiseSettledResult<unknown>[];
      try {
        outcomes = await Promise.allSettled(
          clients.flatMap((client) =>
            Array.from({ length: 4 }, async () => {
              const queryStarted = performance.now();
              try {
                await client.$queryRaw`SELECT 1::int AS one FROM pg_sleep(0.05)`;
              } finally {
                queryMs.push(performance.now() - queryStarted);
              }
            }),
          ),
        );
      } finally {
        monitoring = false;
        await monitor;
        await Promise.all(clients.map((client) => client.$disconnect()));
      }
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      const result = {
        proof: "round8b5a_pool_pressure",
        ...input,
        queries: input.contenders * 4,
        peakConnections,
        peakActive,
        peakIdle,
        peakLockWaits,
        queryP50Ms: percentile(queryMs, 0.5),
        queryP95Ms: percentile(queryMs, 0.95),
        queryP99Ms: percentile(queryMs, 0.99),
        durationMs: performance.now() - started,
        poolTimeouts: failures.filter((outcome) =>
          /P2024|connection pool|pool timeout/i.test(String(outcome.reason)),
        ).length,
        errors: failures.length,
      };
      console.info(JSON.stringify(result));
      expect(failures).toHaveLength(0);
    }
  });
});
