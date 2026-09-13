import { randomUUID } from "node:crypto";
import {
  type Approval,
  type DraftPreparation,
  type InboundEvent,
  InboundEventType,
  Provider,
  PublishOperation,
  type Reporter,
  type Story,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";

jest.setTimeout(120_000);

describe("Round 7B.0 Approval publication authority", () => {
  const prisma = new PrismaService();
  const runId = randomUUID();
  const marker = `round7b0:${runId}`;

  async function expectRejected(operation: Promise<unknown>): Promise<void> {
    await expect(operation).rejects.toBeDefined();
  }

  async function seedAuthority(name: string): Promise<{
    reporter: Reporter;
    story: Story;
    inbound: InboundEvent;
    preparation: DraftPreparation;
    approval: Approval;
  }> {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
        displayName: `${marker}:${name}`,
      },
    });
    const story = await prisma.story.create({
      data: { reporterId: reporter.id, headline: `${marker}:${name}` },
    });
    const inbound = await prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: `${marker}:${name}`,
        reporterId: reporter.id,
        senderPhone: reporter.phoneNumber,
        senderIngestSequence: BigInt(Date.now()),
        eventType: InboundEventType.TEXT,
        rawPayload: { round7b0: true },
      },
    });
    const preparation = await prisma.draftPreparation.create({
      data: {
        storyId: story.id,
        inboundEventId: inbound.id,
        storyVersion: story.version,
        approvalPromptCorrelationKey: `${marker}:${name}`,
        previewExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const approval = await prisma.approval.create({
      data: {
        storyId: story.id,
        reporterId: reporter.id,
        inboundEventId: inbound.id,
        draftPreparationId: preparation.id,
        storyVersion: story.version,
        wordpressAppliedVersion: "a".repeat(64),
      },
    });
    return { reporter, story, inbound, preparation, approval };
  }

  beforeAll(async () => prisma.$connect());

  afterAll(async () => {
    const reporters = await prisma.reporter.findMany({
      where: { displayName: { startsWith: marker } },
      select: { id: true },
    });
    const reporterIds = reporters.map(({ id }) => id);
    const stories = await prisma.story.findMany({
      where: { reporterId: { in: reporterIds } },
      select: { id: true },
    });
    const storyIds = stories.map(({ id }) => id);
    await prisma.publishAttempt.deleteMany({
      where: { storyId: { in: storyIds } },
    });
    await prisma.approval.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.draftPreparation.deleteMany({
      where: { storyId: { in: storyIds } },
    });
    await prisma.conversation.deleteMany({
      where: { reporterId: { in: reporterIds } },
    });
    await prisma.inboundEvent.deleteMany({
      where: { reporterId: { in: reporterIds } },
    });
    await prisma.story.deleteMany({ where: { id: { in: storyIds } } });
    await prisma.reporter.deleteMany({ where: { id: { in: reporterIds } } });
    await prisma.$disconnect();
  });

  it("exposes the nullable unique FK and exact CHECK metadata", async () => {
    const columns = await prisma.$queryRaw<
      Array<{ nullable: string; data_type: string }>
    >`SELECT is_nullable AS nullable, data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='PublishAttempt' AND column_name='approvalId'`;
    expect(columns).toEqual([{ nullable: "YES", data_type: "uuid" }]);

    const constraints = await prisma.$queryRaw<
      Array<{
        name: string;
        definition: string;
        delete_action: string;
        update_action: string;
      }>
    >`SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS definition, c.confdeltype::text AS delete_action, c.confupdtype::text AS update_action FROM pg_constraint c WHERE c.conname IN ('PublishAttempt_approvalId_fkey', 'PublishAttempt_operation_approval_authority_check') ORDER BY c.conname`;
    expect(constraints).toHaveLength(2);
    expect(
      constraints.find(({ name }) => name.endsWith("_fkey")),
    ).toMatchObject({
      delete_action: "r",
      update_action: "c",
    });
    expect(
      constraints.find(({ name }) => name.endsWith("_check"))?.definition,
    ).toContain('"approvalId" IS NOT NULL');
  });

  it("permits Round 6 operations only with null approvalId", async () => {
    const { story, approval } = await seedAuthority("round6-operations");
    for (const operation of [
      PublishOperation.CREATE_DRAFT,
      PublishOperation.SYNC_DRAFT,
    ]) {
      await expect(
        prisma.publishAttempt.create({
          data: {
            storyId: story.id,
            operation,
            attemptNumber: operation === PublishOperation.CREATE_DRAFT ? 1 : 2,
            idempotencyKey: `${marker}:${operation}`,
          },
        }),
      ).resolves.toMatchObject({ approvalId: null });
      await expectRejected(
        prisma.publishAttempt.create({
          data: {
            storyId: story.id,
            operation,
            attemptNumber: operation === PublishOperation.CREATE_DRAFT ? 3 : 4,
            idempotencyKey: `${marker}:${operation}:invalid`,
            approvalId: approval.id,
          },
        }),
      );
    }
  });

  it("requires valid Approval authority for PUBLISH and enforces one-to-one", async () => {
    const first = await seedAuthority("publish-one");
    await expectRejected(
      prisma.publishAttempt.create({
        data: {
          storyId: first.story.id,
          operation: PublishOperation.PUBLISH,
          attemptNumber: 1,
          idempotencyKey: `${marker}:publish-null`,
        },
      }),
    );
    await expectRejected(
      prisma.$executeRawUnsafe(
        `INSERT INTO "PublishAttempt" ("id","storyId","operation","status","attemptNumber","idempotencyKey","approvalId","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'PUBLISH','PENDING',2,$3,$4::uuid,now(),now())`,
        randomUUID(),
        first.story.id,
        `${marker}:bad-fk`,
        randomUUID(),
      ),
    );

    const contenders = await Promise.allSettled(
      [1, 2].map((attemptNumber) =>
        prisma.publishAttempt.create({
          data: {
            storyId: first.story.id,
            operation: PublishOperation.PUBLISH,
            attemptNumber,
            idempotencyKey: `${marker}:concurrent:${attemptNumber}`,
            approvalId: first.approval.id,
          },
        }),
      ),
    );
    expect(
      contenders.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      contenders.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
  });
});
