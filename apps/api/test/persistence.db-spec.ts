import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConversationState,
  type DraftPreparation,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundEventType,
  OutboundMessageType,
  Prisma,
  Provider,
  PublishOperation,
  StoryMediaType,
  StoryStatus,
} from "@prisma/client";
import { PrismaService } from "../src/database/prisma.service";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) {
    return;
  }

  const envFile = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
  const line = envFile
    .split(/\r?\n/u)
    .find((candidate) => /^\s*DATABASE_URL\s*=/u.test(candidate));

  if (!line) {
    throw new Error(
      "DATABASE_URL must be configured for database integration tests",
    );
  }

  let value = line.replace(/^\s*DATABASE_URL\s*=\s*/u, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.env.DATABASE_URL = value;
}

async function expectPrismaError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      expect(error.code).toBe(code);
      return;
    }
    if (
      code === "23514" &&
      error instanceof Prisma.PrismaClientUnknownRequestError &&
      error.message.includes("23514")
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected Prisma error ${code}`);
}

loadDatabaseUrl();
jest.setTimeout(120_000);

describe("PostgreSQL persistence contract", () => {
  const prisma = new PrismaService();
  const runId = randomUUID();
  const marker = `DBTEST ${runId}`;
  const idPart = Date.now().toString().slice(-10);
  const phone = (suffix: number): string => `+1999${idPart}${suffix}`;
  const secondaryPhone = (suffix: number): string => `+1777${idPart}${suffix}`;
  const providerId = (name: string): string => `dbtest:${runId}:${name}`;
  const correlation = (name: string): string => `dbtest:${runId}:${name}`;
  let categorySequence = 0n;
  let inboundSequence = 0n;

  async function createReporter(
    suffix: number,
  ): Promise<{ id: string; phoneNumber: string }> {
    return prisma.reporter.create({
      data: {
        phoneNumber: phone(suffix),
        displayName: `${marker} reporter ${suffix}`,
      },
      select: { id: true, phoneNumber: true },
    });
  }

  async function createInbound(
    name: string,
    reporterId?: string,
  ): Promise<{ id: string }> {
    return prisma.inboundEvent.create({
      data: {
        provider: Provider.WHATSAPP,
        providerMessageId: providerId(name),
        reporterId,
        senderPhone: phone(9),
        senderIngestSequence: inboundSequence++,
        eventType: InboundEventType.TEXT,
        rawPayload: { testRun: runId, name },
      },
      select: { id: true },
    });
  }

  async function createStory(
    reporterId: string,
    name: string,
  ): Promise<{ id: string }> {
    return prisma.story.create({
      data: { reporterId, headline: `${marker} ${name}` },
      select: { id: true },
    });
  }

  async function createCategory(
    name: string,
  ): Promise<{ id: string; wordpressCategoryId: bigint }> {
    categorySequence += 1n;
    return prisma.editorialCategory.create({
      data: {
        wordpressCategoryId: BigInt(Date.now()) * 1000n + categorySequence,
        name: `${marker} ${name}`,
        slug: `dbtest-${runId}-${name}`,
      },
      select: { id: true, wordpressCategoryId: true },
    });
  }

  async function createPreparation(
    storyId: string,
    inboundEventId: string,
    name: string,
    storyVersion = 1,
  ): Promise<DraftPreparation> {
    return prisma.draftPreparation.create({
      data: {
        storyId,
        inboundEventId,
        storyVersion,
        approvalPromptCorrelationKey: correlation(`preparation-${name}`),
        previewExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  async function cleanupFixtures(
    displayPrefix: string,
    keyPrefix: string,
  ): Promise<void> {
    const reporters = await prisma.reporter.findMany({
      where: { displayName: { startsWith: displayPrefix } },
      select: { id: true },
    });
    const reporterIds = reporters.map(({ id }) => id);
    const stories = await prisma.story.findMany({
      where: {
        OR: [
          { reporterId: { in: reporterIds } },
          { headline: { startsWith: displayPrefix } },
        ],
      },
      select: { id: true },
    });
    const storyIds = stories.map(({ id }) => id);
    const inbounds = await prisma.inboundEvent.findMany({
      where: { providerMessageId: { startsWith: keyPrefix } },
      select: { id: true },
    });
    const inboundIds = inbounds.map(({ id }) => id);
    const categories = await prisma.editorialCategory.findMany({
      where: { name: { startsWith: displayPrefix } },
      select: { id: true },
    });
    const categoryIds = categories.map(({ id }) => id);

    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { reporterId: { in: reporterIds } },
          { storyId: { in: storyIds } },
          { inboundEventId: { in: inboundIds } },
        ],
      },
    });
    await prisma.publishAttempt.deleteMany({
      where: { storyId: { in: storyIds } },
    });
    await prisma.approval.deleteMany({
      where: {
        OR: [
          { reporterId: { in: reporterIds } },
          { storyId: { in: storyIds } },
          { inboundEventId: { in: inboundIds } },
        ],
      },
    });
    await prisma.storyCategory.deleteMany({
      where: {
        OR: [
          { storyId: { in: storyIds } },
          { categoryId: { in: categoryIds } },
        ],
      },
    });
    await prisma.storyMedia.deleteMany({
      where: {
        OR: [
          { storyId: { in: storyIds } },
          { providerMediaId: { startsWith: keyPrefix } },
        ],
      },
    });
    await prisma.draftPreparation.deleteMany({
      where: {
        OR: [
          { storyId: { in: storyIds } },
          { inboundEventId: { in: inboundIds } },
          { approvalPromptCorrelationKey: { startsWith: keyPrefix } },
        ],
      },
    });
    await prisma.outboundMessage.deleteMany({
      where: {
        OR: [
          { reporterId: { in: reporterIds } },
          { storyId: { in: storyIds } },
          { correlationKey: { startsWith: keyPrefix } },
        ],
      },
    });
    await prisma.conversation.deleteMany({
      where: { reporterId: { in: reporterIds } },
    });
    await prisma.inboundEvent.deleteMany({
      where: {
        OR: [
          { reporterId: { in: reporterIds } },
          { providerMessageId: { startsWith: keyPrefix } },
        ],
      },
    });
    await prisma.story.deleteMany({ where: { id: { in: storyIds } } });
    await prisma.editorialCategory.deleteMany({
      where: { id: { in: categoryIds } },
    });
    await prisma.reporter.deleteMany({ where: { id: { in: reporterIds } } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanupFixtures("DBTEST ", "dbtest:");
  }, 120_000);

  afterAll(async () => {
    await cleanupFixtures(marker, `dbtest:${runId}:`);
    await prisma.$disconnect();
  }, 120_000);

  it("physically contains the approved PostgreSQL structures and column types", async () => {
    const tables = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name
      FROM pg_catalog.pg_tables
      WHERE schemaname = current_schema()
        AND tablename <> '_prisma_migrations'
      ORDER BY tablename
    `;
    const enums = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT t.typname AS name
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema() AND t.typtype = 'e'
    `;
    const constraints = await prisma.$queryRaw<
      Array<{ type: string; count: bigint }>
    >`
      SELECT contype::text AS type, COUNT(*)::bigint AS count
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = current_schema() AND contype IN ('f', 'c')
      GROUP BY contype
    `;
    const indexes = await prisma.$queryRaw<
      Array<{ unique_index: boolean; count: bigint }>
    >`
      SELECT (indexdef LIKE 'CREATE UNIQUE INDEX%') AS unique_index, COUNT(*)::bigint AS count
      FROM pg_catalog.pg_indexes
      WHERE schemaname = current_schema() AND indexname NOT LIKE '%_pkey'
      GROUP BY unique_index
    `;
    const columnTypes = await prisma.$queryRaw<
      Array<{ data_type: string; count: bigint }>
    >`
      SELECT data_type, COUNT(*)::bigint AS count
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type IN ('timestamp with time zone', 'bigint')
      GROUP BY data_type
    `;
    const publishOperations = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT e.enumlabel AS value
      FROM pg_catalog.pg_enum e
      JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PublishOperation'
      ORDER BY e.enumsortorder
    `;
    const preparationColumns = await prisma.$queryRaw<
      Array<{ name: string; data_type: string; nullable: string }>
    >`
      SELECT column_name AS name, data_type, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'DraftPreparation'
    `;
    const approvalColumns = await prisma.$queryRaw<
      Array<{ name: string; data_type: string; nullable: string }>
    >`
      SELECT column_name AS name, data_type, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Approval'
    `;
    const roundSixForeignKeys = await prisma.$queryRaw<
      Array<{ name: string; delete_action: string; update_action: string }>
    >`
      SELECT c.conname AS name,
             CASE c.confdeltype WHEN 'r' THEN 'RESTRICT' ELSE c.confdeltype::text END AS delete_action,
             CASE c.confupdtype WHEN 'c' THEN 'CASCADE' ELSE c.confupdtype::text END AS update_action
      FROM pg_catalog.pg_constraint c
      WHERE c.contype = 'f'
        AND c.conname IN (
          'DraftPreparation_storyId_fkey',
          'DraftPreparation_inboundEventId_fkey',
          'DraftPreparation_approvalPromptOutboundMessageId_fkey',
          'Approval_draftPreparationId_fkey'
        )
    `;

    expect(tables.map(({ name }) => name).sort()).toEqual(
      [
        "Approval",
        "AuditLog",
        "Conversation",
        "DraftPreparation",
        "EditorialCategory",
        "InboundEvent",
        "InboundSenderSequence",
        "OutboundMessage",
        "PublishAttempt",
        "Reporter",
        "Story",
        "StoryCategory",
        "StoryMedia",
      ].sort(),
    );
    expect(enums).toHaveLength(16);
    expect(publishOperations.map(({ value }) => value)).toEqual([
      "CREATE_DRAFT",
      "SYNC_DRAFT",
      "PUBLISH",
    ]);
    expect(Number(constraints.find(({ type }) => type === "f")?.count)).toBe(
      21,
    );
    expect(Number(constraints.find(({ type }) => type === "c")?.count)).toBe(
      14,
    );
    expect(
      Number(indexes.find(({ unique_index }) => unique_index)?.count),
    ).toBe(23);
    expect(
      Number(indexes.find(({ unique_index }) => !unique_index)?.count),
    ).toBe(32);
    expect(
      Number(
        columnTypes.find(
          ({ data_type }) => data_type === "timestamp with time zone",
        )?.count,
      ),
    ).toBeGreaterThan(0);
    expect(
      Number(
        columnTypes.find(({ data_type }) => data_type === "bigint")?.count,
      ),
    ).toBe(8);
    expect(preparationColumns).toEqual(
      expect.arrayContaining([
        { name: "storyVersion", data_type: "integer", nullable: "NO" },
        { name: "wordpressPostId", data_type: "bigint", nullable: "YES" },
        {
          name: "wordpressAppliedVersion",
          data_type: "character",
          nullable: "YES",
        },
        {
          name: "previewExpiresAt",
          data_type: "timestamp with time zone",
          nullable: "NO",
        },
        {
          name: "approvalPromptOutboundMessageId",
          data_type: "uuid",
          nullable: "YES",
        },
      ]),
    );
    expect(approvalColumns).toEqual(
      expect.arrayContaining([
        { name: "draftPreparationId", data_type: "uuid", nullable: "NO" },
        { name: "storyVersion", data_type: "integer", nullable: "NO" },
        {
          name: "wordpressAppliedVersion",
          data_type: "character",
          nullable: "NO",
        },
      ]),
    );
    expect(roundSixForeignKeys).toHaveLength(4);
    expect(roundSixForeignKeys).toEqual(
      expect.arrayContaining(
        [
          "DraftPreparation_storyId_fkey",
          "DraftPreparation_inboundEventId_fkey",
          "DraftPreparation_approvalPromptOutboundMessageId_fkey",
          "Approval_draftPreparationId_fkey",
        ].map((name) => ({
          name,
          delete_action: "RESTRICT",
          update_action: "CASCADE",
        })),
      ),
    );
  });

  it("persists nullable and non-null Reporter editorial bylines", async () => {
    const nullable = await prisma.reporter.create({
      data: {
        phoneNumber: secondaryPhone(0),
        displayName: `${marker} reporter editorial-null`,
      },
    });
    expect(
      await prisma.reporter.findUnique({
        where: { id: nullable.id },
        select: { editorialByline: true },
      }),
    ).toEqual({ editorialByline: null });

    const bylined = await prisma.reporter.create({
      data: {
        phoneNumber: secondaryPhone(1),
        displayName: `${marker} reporter 11`,
        editorialByline: "Journalist Current Byline",
      },
    });
    expect(bylined.editorialByline).toBe("Journalist Current Byline");
  });

  it("persists Story byline snapshots independently of Reporter changes", async () => {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: secondaryPhone(2),
        displayName: `${marker} reporter 12`,
        editorialByline: "Original Editorial Byline",
      },
    });
    const nullableStory = await createStory(reporter.id, "nullable-byline");
    expect(
      await prisma.story.findUnique({
        where: { id: nullableStory.id },
        select: { byline: true },
      }),
    ).toEqual({ byline: null });

    const historicalStory = await prisma.story.create({
      data: {
        reporterId: reporter.id,
        headline: `${marker} historical-byline`,
        byline: "Original Editorial Byline",
      },
    });
    await prisma.reporter.update({
      where: { id: reporter.id },
      data: { editorialByline: "Changed Editorial Byline" },
    });
    expect(
      await prisma.story.findUnique({
        where: { id: historicalStory.id },
        select: { byline: true },
      }),
    ).toEqual({ byline: "Original Editorial Byline" });
  });

  it("enforces WordPress category identity and many-to-many assignment uniqueness", async () => {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: secondaryPhone(3),
        displayName: `${marker} reporter categories`,
      },
    });
    const storyOne = await createStory(reporter.id, "categories-one");
    const storyTwo = await createStory(reporter.id, "categories-two");
    const categoryOne = await createCategory("category-one");
    const categoryTwo = await createCategory("category-two");

    await expectPrismaError(
      prisma.editorialCategory.create({
        data: {
          wordpressCategoryId: categoryOne.wordpressCategoryId,
          name: `${marker} duplicate external identity`,
          slug: `dbtest-${runId}-duplicate`,
        },
      }),
      "P2002",
    );

    await prisma.storyCategory.createMany({
      data: [
        { storyId: storyOne.id, categoryId: categoryOne.id },
        { storyId: storyOne.id, categoryId: categoryTwo.id },
        { storyId: storyTwo.id, categoryId: categoryOne.id },
      ],
    });
    expect(
      await prisma.storyCategory.count({ where: { storyId: storyOne.id } }),
    ).toBe(2);
    expect(
      await prisma.storyCategory.count({
        where: { categoryId: categoryOne.id },
      }),
    ).toBe(2);
    await expectPrismaError(
      prisma.storyCategory.create({
        data: { storyId: storyOne.id, categoryId: categoryOne.id },
      }),
      "P2002",
    );
  });

  it("restricts category deletion and preserves assignments on deactivation", async () => {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: secondaryPhone(4),
        displayName: `${marker} reporter category-history`,
      },
    });
    const story = await createStory(reporter.id, "category-history");
    const category = await createCategory("category-history");
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });

    await expectPrismaError(
      prisma.editorialCategory.delete({ where: { id: category.id } }),
      "P2003",
    );
    await prisma.editorialCategory.update({
      where: { id: category.id },
      data: { status: EditorialCategoryStatus.INACTIVE },
    });
    expect(
      await prisma.storyCategory.count({ where: { categoryId: category.id } }),
    ).toBe(1);
  });

  it("enforces Reporter and Conversation uniqueness", async () => {
    const reporter = await createReporter(0);
    await expectPrismaError(
      prisma.reporter.create({
        data: { phoneNumber: reporter.phoneNumber, displayName: marker },
      }),
      "P2002",
    );
    await prisma.conversation.create({ data: { reporterId: reporter.id } });
    await expectPrismaError(
      prisma.conversation.create({ data: { reporterId: reporter.id } }),
      "P2002",
    );
  });

  it("enforces inbound idempotency and accepts an unknown sender", async () => {
    const inbound = await createInbound("inbound-unique");
    expect(inbound.id).toBeDefined();
    await expectPrismaError(
      prisma.inboundEvent.create({
        data: {
          provider: Provider.WHATSAPP,
          providerMessageId: providerId("inbound-unique"),
          senderPhone: phone(9),
          senderIngestSequence: inboundSequence++,
          eventType: InboundEventType.TEXT,
          rawPayload: { testRun: runId },
        },
      }),
      "P2002",
    );
  });

  it("enforces outbound nullable and non-null uniqueness semantics", async () => {
    const reporter = await createReporter(1);
    await prisma.outboundMessage.createMany({
      data: [
        {
          reporterId: reporter.id,
          type: OutboundMessageType.TEXT,
          correlationKey: correlation("out-null-1"),
          payload: { text: "one" },
        },
        {
          reporterId: reporter.id,
          type: OutboundMessageType.TEXT,
          correlationKey: correlation("out-null-2"),
          payload: { text: "two" },
        },
      ],
    });
    await prisma.outboundMessage.create({
      data: {
        reporterId: reporter.id,
        type: OutboundMessageType.TEXT,
        correlationKey: correlation("out-provider-1"),
        providerMessageId: providerId("out-provider"),
        payload: { text: "three" },
      },
    });
    await expectPrismaError(
      prisma.outboundMessage.create({
        data: {
          reporterId: reporter.id,
          type: OutboundMessageType.TEXT,
          correlationKey: correlation("out-provider-2"),
          providerMessageId: providerId("out-provider"),
          payload: { text: "four" },
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.outboundMessage.create({
        data: {
          reporterId: reporter.id,
          type: OutboundMessageType.TEXT,
          correlationKey: correlation("out-null-1"),
          payload: { text: "duplicate correlation" },
        },
      }),
      "P2002",
    );
  });

  it("enforces Story nullable and non-null WordPress uniqueness", async () => {
    const reporter = await createReporter(2);
    await createStory(reporter.id, "null-wordpress-1");
    await createStory(reporter.id, "null-wordpress-2");
    const draftKey = randomUUID();
    await prisma.story.create({
      data: {
        reporterId: reporter.id,
        headline: marker,
        wordpressPostId: 9000001n,
        wordpressDraftKey: draftKey,
      },
    });
    await expectPrismaError(
      prisma.story.create({
        data: {
          reporterId: reporter.id,
          headline: marker,
          wordpressPostId: 9000001n,
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.story.create({
        data: {
          reporterId: reporter.id,
          headline: marker,
          wordpressDraftKey: draftKey,
        },
      }),
      "P2002",
    );
  });

  it("enforces StoryMedia identifiers, positions, and nullable uniqueness", async () => {
    const reporter = await createReporter(3);
    const story = await createStory(reporter.id, "media-story");
    await prisma.storyMedia.createMany({
      data: [
        {
          storyId: story.id,
          providerMediaId: providerId("media-1"),
          mediaType: StoryMediaType.IMAGE,
          position: 0,
        },
        {
          storyId: story.id,
          providerMediaId: providerId("media-2"),
          mediaType: StoryMediaType.IMAGE,
          position: 1,
        },
        {
          storyId: story.id,
          providerMediaId: providerId("media-wp"),
          mediaType: StoryMediaType.IMAGE,
          wordpressMediaId: 8000001n,
          position: 2,
        },
      ],
    });
    await expectPrismaError(
      prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: providerId("media-1"),
          mediaType: StoryMediaType.IMAGE,
          position: 3,
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: providerId("media-position"),
          mediaType: StoryMediaType.IMAGE,
          position: 1,
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: providerId("media-wp-duplicate"),
          mediaType: StoryMediaType.IMAGE,
          wordpressMediaId: 8000001n,
          position: 4,
        },
      }),
      "P2002",
    );
  });

  it("enforces DraftPreparation authority, nullable prompt links, and evidence FKs", async () => {
    const reporter = await createReporter(9);
    const story = await createStory(reporter.id, "preparation");
    const inboundOne = await createInbound("preparation-one", reporter.id);
    const first = await createPreparation(story.id, inboundOne.id, "one", 1);
    expect(first).toMatchObject({
      storyId: story.id,
      inboundEventId: inboundOne.id,
      storyVersion: 1,
      status: DraftPreparationStatus.ACTIVE,
      approvalPromptCorrelationKey: correlation("preparation-one"),
    });
    expect(first.startedAt).toBeInstanceOf(Date);
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(first.updatedAt).toBeInstanceOf(Date);
    expect(first.previewExpiresAt.getTime()).toBeGreaterThan(
      first.startedAt.getTime(),
    );

    const inboundTwo = await createInbound("preparation-two", reporter.id);
    await expectPrismaError(
      prisma.draftPreparation.create({
        data: {
          storyId: story.id,
          inboundEventId: inboundOne.id,
          storyVersion: 2,
          approvalPromptCorrelationKey: correlation("preparation-event-dup"),
          previewExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.draftPreparation.create({
        data: {
          storyId: story.id,
          inboundEventId: inboundTwo.id,
          storyVersion: 1,
          approvalPromptCorrelationKey: correlation("preparation-epoch-dup"),
          previewExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
      "P2002",
    );
    const second = await createPreparation(story.id, inboundTwo.id, "two", 2);
    expect(second.storyVersion).toBe(2);

    const otherStory = await createStory(reporter.id, "preparation-other");
    const inboundThree = await createInbound("preparation-three", reporter.id);
    await expectPrismaError(
      prisma.draftPreparation.create({
        data: {
          storyId: otherStory.id,
          inboundEventId: inboundThree.id,
          storyVersion: 1,
          approvalPromptCorrelationKey: first.approvalPromptCorrelationKey,
          previewExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
      "P2002",
    );

    const prompt = await prisma.outboundMessage.create({
      data: {
        reporterId: reporter.id,
        storyId: story.id,
        type: OutboundMessageType.INTERACTIVE,
        correlationKey: correlation("preparation-prompt"),
        payload: { draftPreparationId: first.id },
      },
    });
    await prisma.draftPreparation.update({
      where: { id: first.id },
      data: { approvalPromptOutboundMessageId: prompt.id },
    });
    await expectPrismaError(
      prisma.draftPreparation.update({
        where: { id: second.id },
        data: { approvalPromptOutboundMessageId: prompt.id },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.story.delete({ where: { id: story.id } }),
      "P2003",
    );
    await expectPrismaError(
      prisma.inboundEvent.delete({ where: { id: inboundOne.id } }),
      "P2003",
    );
    await expectPrismaError(
      prisma.outboundMessage.delete({ where: { id: prompt.id } }),
      "P2003",
    );
  });

  it("enforces Approval provenance and epoch-binding uniqueness", async () => {
    const reporter = await createReporter(4);
    const storyOne = await createStory(reporter.id, "approval-one");
    const storyTwo = await createStory(reporter.id, "approval-two");
    const inboundOne = await createInbound("approval-one", reporter.id);
    const inboundTwo = await createInbound("approval-two", reporter.id);
    const preparationOne = await createPreparation(
      storyOne.id,
      inboundOne.id,
      "approval-one",
    );
    const preparationTwo = await createPreparation(
      storyTwo.id,
      inboundTwo.id,
      "approval-two",
    );
    const appliedVersion = "a".repeat(64);
    await prisma.approval.create({
      data: {
        storyId: storyOne.id,
        reporterId: reporter.id,
        inboundEventId: inboundOne.id,
        draftPreparationId: preparationOne.id,
        storyVersion: preparationOne.storyVersion,
        wordpressAppliedVersion: appliedVersion,
      },
    });
    await expectPrismaError(
      prisma.approval.create({
        data: {
          storyId: storyOne.id,
          reporterId: reporter.id,
          inboundEventId: inboundTwo.id,
          draftPreparationId: preparationTwo.id,
          storyVersion: preparationTwo.storyVersion,
          wordpressAppliedVersion: appliedVersion,
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.approval.create({
        data: {
          storyId: storyTwo.id,
          reporterId: reporter.id,
          inboundEventId: inboundOne.id,
          draftPreparationId: preparationTwo.id,
          storyVersion: preparationTwo.storyVersion,
          wordpressAppliedVersion: appliedVersion,
        },
      }),
      "P2002",
    );
    const inboundThree = await createInbound("approval-three", reporter.id);
    await expectPrismaError(
      prisma.approval.create({
        data: {
          storyId: storyTwo.id,
          reporterId: reporter.id,
          inboundEventId: inboundThree.id,
          draftPreparationId: preparationOne.id,
          storyVersion: preparationOne.storyVersion,
          wordpressAppliedVersion: appliedVersion,
        },
      }),
      "P2002",
    );
  });

  it("enforces PublishAttempt uniqueness and positive attempt numbers", async () => {
    const reporter = await createReporter(5);
    const story = await createStory(reporter.id, "publish-attempt");
    for (const operation of [
      PublishOperation.CREATE_DRAFT,
      PublishOperation.SYNC_DRAFT,
    ]) {
      await prisma.publishAttempt.create({
        data: {
          storyId: story.id,
          operation,
          attemptNumber: 1,
          idempotencyKey: correlation(`publish-${operation}`),
        },
      });
    }
    const inbound = await createInbound("publish-authority", reporter.id);
    const preparation = await createPreparation(
      story.id,
      inbound.id,
      "publish-authority",
    );
    const approval = await prisma.approval.create({
      data: {
        storyId: story.id,
        reporterId: reporter.id,
        inboundEventId: inbound.id,
        draftPreparationId: preparation.id,
        storyVersion: preparation.storyVersion,
        wordpressAppliedVersion: "d".repeat(64),
      },
    });
    await prisma.publishAttempt.create({
      data: {
        storyId: story.id,
        operation: PublishOperation.PUBLISH,
        attemptNumber: 1,
        idempotencyKey: correlation("publish-PUBLISH"),
        approvalId: approval.id,
      },
    });
    await expectPrismaError(
      prisma.publishAttempt.create({
        data: {
          storyId: story.id,
          operation: PublishOperation.PUBLISH,
          attemptNumber: 1,
          idempotencyKey: correlation("publish-CREATE_DRAFT"),
          approvalId: approval.id,
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.publishAttempt.create({
        data: {
          storyId: story.id,
          operation: PublishOperation.CREATE_DRAFT,
          attemptNumber: 1,
          idempotencyKey: correlation("publish-composite"),
        },
      }),
      "P2002",
    );
    await expectPrismaError(
      prisma.publishAttempt.create({
        data: {
          storyId: story.id,
          operation: PublishOperation.CREATE_DRAFT,
          attemptNumber: 0,
          idempotencyKey: correlation("publish-invalid"),
        },
      }),
      "23514",
    );
  });

  it("enforces representative non-negative CHECK constraints", async () => {
    const reporter = await createReporter(6);
    const story = await createStory(reporter.id, "checks");
    await expectPrismaError(
      prisma.conversation.create({
        data: { reporterId: reporter.id, version: -1 },
      }),
      "23514",
    );
    await expectPrismaError(
      prisma.story.create({
        data: { reporterId: reporter.id, headline: marker, version: -1 },
      }),
      "23514",
    );
    await expectPrismaError(
      prisma.inboundEvent.create({
        data: {
          provider: Provider.WHATSAPP,
          providerMessageId: providerId("negative-inbound"),
          senderPhone: phone(9),
          senderIngestSequence: inboundSequence++,
          eventType: InboundEventType.TEXT,
          rawPayload: { testRun: runId },
          processingAttempts: -1,
        },
      }),
      "23514",
    );
    await expectPrismaError(
      prisma.outboundMessage.create({
        data: {
          reporterId: reporter.id,
          type: OutboundMessageType.TEXT,
          correlationKey: correlation("negative-outbound"),
          payload: { text: "invalid" },
          sendAttempts: -1,
        },
      }),
      "23514",
    );
    await expectPrismaError(
      prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: providerId("negative-size"),
          mediaType: StoryMediaType.IMAGE,
          fileSizeBytes: -1n,
          position: 0,
        },
      }),
      "23514",
    );
    await expectPrismaError(
      prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: providerId("negative-position"),
          mediaType: StoryMediaType.IMAGE,
          position: -1,
        },
      }),
      "23514",
    );

    const preparationInbound = await createInbound(
      "checks-preparation",
      reporter.id,
    );
    const preparationBase = {
      storyId: story.id,
      inboundEventId: preparationInbound.id,
      storyVersion: 1,
      approvalPromptCorrelationKey: correlation("checks-preparation"),
      previewExpiresAt: new Date("2040-01-02T00:00:00.000Z"),
      startedAt: new Date("2040-01-01T00:00:00.000Z"),
    };
    for (const data of [
      { ...preparationBase, storyVersion: -1 },
      { ...preparationBase, wordpressPostId: 0n },
      { ...preparationBase, wordpressPostId: -1n },
      { ...preparationBase, wordpressAppliedVersion: "A".repeat(64) },
      { ...preparationBase, wordpressAppliedVersion: "a".repeat(63) },
      { ...preparationBase, wordpressAppliedVersion: "g".repeat(64) },
      {
        ...preparationBase,
        previewExpiresAt: preparationBase.startedAt,
      },
      {
        ...preparationBase,
        previewExpiresAt: new Date("2039-12-31T23:59:59.999Z"),
      },
    ]) {
      await expectPrismaError(
        prisma.draftPreparation.create({ data }),
        "23514",
      );
    }
    const validPreparation = await prisma.draftPreparation.create({
      data: {
        ...preparationBase,
        wordpressPostId: 1n,
        wordpressAppliedVersion: "a".repeat(64),
      },
    });
    const approvalInbound = await createInbound("checks-approval", reporter.id);
    const approvalBase = {
      storyId: story.id,
      reporterId: reporter.id,
      inboundEventId: approvalInbound.id,
      draftPreparationId: validPreparation.id,
      storyVersion: 1,
      wordpressAppliedVersion: "b".repeat(64),
    };
    for (const data of [
      { ...approvalBase, storyVersion: -1 },
      { ...approvalBase, wordpressAppliedVersion: "B".repeat(64) },
      { ...approvalBase, wordpressAppliedVersion: "b".repeat(63) },
      { ...approvalBase, wordpressAppliedVersion: "z".repeat(64) },
    ]) {
      await expectPrismaError(prisma.approval.create({ data }), "23514");
    }
    const validApproval = await prisma.approval.create({ data: approvalBase });
    expect(validApproval.wordpressAppliedVersion).toBe("b".repeat(64));
  });

  it("restricts deletion of approval, publish, media, and audit provenance", async () => {
    const reporter = await createReporter(7);
    const approvalStory = await createStory(reporter.id, "restrict-approval");
    const approvalInbound = await createInbound(
      "restrict-approval",
      reporter.id,
    );
    const approvalPreparation = await createPreparation(
      approvalStory.id,
      approvalInbound.id,
      "restrict-approval",
    );
    const approval = await prisma.approval.create({
      data: {
        storyId: approvalStory.id,
        reporterId: reporter.id,
        inboundEventId: approvalInbound.id,
        draftPreparationId: approvalPreparation.id,
        storyVersion: approvalPreparation.storyVersion,
        wordpressAppliedVersion: "c".repeat(64),
      },
    });
    await expectPrismaError(
      prisma.reporter.delete({ where: { id: reporter.id } }),
      "P2003",
    );
    await expectPrismaError(
      prisma.story.delete({ where: { id: approvalStory.id } }),
      "P2003",
    );

    const publishStory = await createStory(reporter.id, "restrict-publish");
    await prisma.publishAttempt.create({
      data: {
        storyId: publishStory.id,
        operation: PublishOperation.PUBLISH,
        attemptNumber: 1,
        idempotencyKey: correlation("restrict-publish"),
        approvalId: approval.id,
      },
    });
    await expectPrismaError(
      prisma.story.delete({ where: { id: publishStory.id } }),
      "P2003",
    );

    const mediaStory = await createStory(reporter.id, "restrict-media");
    await prisma.storyMedia.create({
      data: {
        storyId: mediaStory.id,
        providerMediaId: providerId("restrict-media"),
        mediaType: StoryMediaType.IMAGE,
        position: 0,
      },
    });
    await expectPrismaError(
      prisma.story.delete({ where: { id: mediaStory.id } }),
      "P2003",
    );

    const auditStory = await createStory(reporter.id, "restrict-audit");
    await prisma.auditLog.create({
      data: {
        eventType: "DB_TEST",
        actorType: "SYSTEM",
        storyId: auditStory.id,
        metadata: { testRun: runId },
      },
    });
    await expectPrismaError(
      prisma.story.delete({ where: { id: auditStory.id } }),
      "P2003",
    );
  });

  it("applies SET NULL for current Story and optional inbound Reporter", async () => {
    const currentReporter = await createReporter(8);
    const currentStory = await createStory(
      currentReporter.id,
      "set-null-current",
    );
    const conversation = await prisma.conversation.create({
      data: { reporterId: currentReporter.id, currentStoryId: currentStory.id },
    });
    await prisma.story.delete({ where: { id: currentStory.id } });
    expect(
      await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { currentStoryId: true },
      }),
    ).toEqual({ currentStoryId: null });

    const inboundReporter = await prisma.reporter.create({
      data: {
        phoneNumber: "+188800000000001",
        displayName: `${marker} inbound set-null`,
      },
    });
    const inbound = await createInbound(
      "set-null-reporter",
      inboundReporter.id,
    );
    await prisma.reporter.delete({ where: { id: inboundReporter.id } });
    expect(
      await prisma.inboundEvent.findUnique({
        where: { id: inbound.id },
        select: { reporterId: true },
      }),
    ).toEqual({ reporterId: null });
  });

  it("atomically creates Reporter and Conversation and rolls back on failure", async () => {
    const successPhone = "+188800000000002";
    const success = await prisma.$transaction(async (transaction) => {
      const reporter = await transaction.reporter.create({
        data: {
          phoneNumber: successPhone,
          displayName: `${marker} tx success`,
        },
      });
      const conversation = await transaction.conversation.create({
        data: { reporterId: reporter.id },
      });
      return { reporter, conversation };
    });
    expect(success.conversation.reporterId).toBe(success.reporter.id);

    const rollbackPhone = "+188800000000003";
    await expectPrismaError(
      prisma.$transaction(async (transaction) => {
        const reporter = await transaction.reporter.create({
          data: {
            phoneNumber: rollbackPhone,
            displayName: `${marker} tx rollback`,
          },
        });
        await transaction.conversation.create({
          data: { reporterId: reporter.id, version: -1 },
        });
      }),
      "23514",
    );
    expect(
      await prisma.reporter.count({ where: { phoneNumber: rollbackPhone } }),
    ).toBe(0);
  });

  it("supports optimistic compare-and-set for Story and Conversation", async () => {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: "+188800000000004",
        displayName: `${marker} compare-and-set`,
      },
    });
    const story = await createStory(reporter.id, "compare-and-set");
    const conversation = await prisma.conversation.create({
      data: { reporterId: reporter.id },
    });

    const firstStory = await prisma.story.updateMany({
      where: { id: story.id, status: StoryStatus.COLLECTING, version: 0 },
      data: { status: StoryStatus.READY, version: { increment: 1 } },
    });
    const staleStory = await prisma.story.updateMany({
      where: { id: story.id, status: StoryStatus.COLLECTING, version: 0 },
      data: { status: StoryStatus.READY, version: { increment: 1 } },
    });
    const firstConversation = await prisma.conversation.updateMany({
      where: { id: conversation.id, state: ConversationState.IDLE, version: 0 },
      data: {
        state: ConversationState.AWAITING_HEADLINE,
        version: { increment: 1 },
      },
    });
    const staleConversation = await prisma.conversation.updateMany({
      where: { id: conversation.id, state: ConversationState.IDLE, version: 0 },
      data: {
        state: ConversationState.AWAITING_HEADLINE,
        version: { increment: 1 },
      },
    });

    expect(firstStory.count).toBe(1);
    expect(staleStory.count).toBe(0);
    expect(firstConversation.count).toBe(1);
    expect(staleConversation.count).toBe(0);
  });

  it("allows exactly one concurrent inbound insert for one provider message", async () => {
    const duplicateId = providerId("concurrent-race");
    const insert = (variant: string): Promise<unknown> =>
      prisma.inboundEvent.create({
        data: {
          provider: Provider.WHATSAPP,
          providerMessageId: duplicateId,
          senderPhone: phone(9),
          senderIngestSequence: variant === "one" ? 900000n : 900001n,
          eventType: InboundEventType.TEXT,
          rawPayload: { testRun: runId, variant },
        },
      });

    const results = await Promise.allSettled([insert("one"), insert("two")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await prisma.inboundEvent.count({
        where: { provider: Provider.WHATSAPP, providerMessageId: duplicateId },
      }),
    ).toBe(1);
  });
});
