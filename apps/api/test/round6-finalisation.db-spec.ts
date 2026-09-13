import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns";
import { ConfigService } from "@nestjs/config";
import {
  ConversationState,
  DraftPreparationStatus,
  EditorialCategoryStatus,
  InboundEventType,
  InboundProcessingStatus,
  MediaProcessingStatus,
  OutboundMessageStatus,
  Provider,
  Prisma,
  ReporterStatus,
  StoryStatus,
  StoryMediaType,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../src/config/configuration";
import { PrismaService } from "../src/database/prisma.service";
import { DraftPreparationService } from "../src/modules/draft-preparation/draft-preparation.service";
import type { PreparedAuthority } from "../src/modules/draft-preparation/draft-preparation.types";
import { PreviewTokenService } from "../src/modules/newsroom-preview/newsroom-preview-token.service";
import { mediaObjectKey, type DownloadedMedia, type MediaObjectStore, type StoredObjectHead } from "../src/modules/media-staging/media-staging.types";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { Round6FinalisationService } from "../src/modules/reporter-workflow/round6-finalisation.service";
import { StoredWhatsappEventParser } from "../src/modules/story-collection/stored-whatsapp-event.parser";
import { StoryEventProcessor } from "../src/modules/story-collection/story-event-processor.service";
import { draftStateFingerprint, type CanonicalDraftState, type WordPressDraftState } from "../src/modules/wordpress-draft/wordpress-draft-state";
import type { WordPressDraftClient } from "../src/modules/wordpress-draft/wordpress-draft.client";
import { WordPressDraftError } from "../src/modules/wordpress-draft/wordpress-draft.errors";
import type { WordPressMediaClient } from "../src/modules/wordpress-media/wordpress-media.client";
import { WordPressMediaError } from "../src/modules/wordpress-media/wordpress-media.errors";
import { ApprovalPromptService } from "../src/modules/whatsapp-outbound/approval-prompt.service";
import { WhatsappOutboundClient } from "../src/modules/whatsapp-outbound/whatsapp-outbound.client";
import { WhatsappOutboundDispatcher } from "../src/modules/whatsapp-outbound/whatsapp-outbound.dispatcher";
import type { MetaOutboundTransport, MetaTransportRequest, MetaTransportResponse } from "../src/modules/whatsapp-outbound/whatsapp-outbound.types";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
jest.setTimeout(120_000);
const prisma = new PrismaService();

class ProofStore implements MediaObjectStore {
  readonly objects = new Map<string, DownloadedMedia>();
  readonly calls: string[] = [];
  putIfAbsent(): Promise<"CREATED"> { return Promise.resolve("CREATED"); }
  head(key: string): Promise<StoredObjectHead | null> {
    this.calls.push(`head:${key}`);
    const item = this.objects.get(key);
    return Promise.resolve(item ? { size: item.size, sha256: item.sha256, mimeType: item.mimeType } : null);
  }
  read(key: string): Promise<Buffer> {
    this.calls.push(`read:${key}`);
    const item = this.objects.get(key);
    return item ? Promise.resolve(item.bytes) : Promise.reject(new Error("missing"));
  }
}

class ProofDraft {
  readonly calls: string[] = [];
  readonly posts = new Map<string, { id: number; state?: CanonicalDraftState }>();
  private next = 9000;
  getDraftByKey(key: string): Promise<{ wordpressDraftKey: string; wordpressPostId: number; status: "draft" }> {
    this.calls.push(`get:${key}`); const post = this.posts.get(key);
    return post ? Promise.resolve({ wordpressDraftKey: key, wordpressPostId: post.id, status: "draft" }) : Promise.reject(new WordPressDraftError("NOT_FOUND", "safe", 404));
  }
  createDraft(input: { wordpressDraftKey: string }): Promise<{ wordpressDraftKey: string; wordpressPostId: number; status: "draft"; outcome: "CREATED" }> {
    this.calls.push(`create:${input.wordpressDraftKey}`); const id = this.next++;
    this.posts.set(input.wordpressDraftKey, { id });
    return Promise.resolve({ wordpressDraftKey: input.wordpressDraftKey, wordpressPostId: id, status: "draft", outcome: "CREATED" });
  }
  syncDraft(input: { wordpressDraftKey: string; headline: string; body: string; excerpt?: string; wordpressCategoryIds: number[]; editorialByline: string; featuredMediaKey: string | null }): Promise<{ draft_key: string; post_id: number; status: "draft"; replayed: false; featured_media_key: string | null; applied_version: string; outcome: "APPLIED" }> {
    this.calls.push(`sync:${input.wordpressDraftKey}`); const post = this.posts.get(input.wordpressDraftKey)!;
    const state: CanonicalDraftState = { title: input.headline, content: input.body, excerpt: input.excerpt ?? "", categories: input.wordpressCategoryIds, editorial_byline: input.editorialByline, featured_media_key: input.featuredMediaKey };
    post.state = state; const applied_version = draftStateFingerprint(state);
    return Promise.resolve({ draft_key: input.wordpressDraftKey, post_id: post.id, status: "draft", replayed: false, featured_media_key: state.featured_media_key, applied_version, outcome: "APPLIED" });
  }
  getDraftState(key: string): Promise<WordPressDraftState> {
    this.calls.push(`state:${key}`); const post = this.posts.get(key)!; const state = post.state ?? { title: "remote", content: "remote", excerpt: "", categories: [1], editorial_byline: "remote", featured_media_key: null };
    return Promise.resolve({ draft_key: key, post_id: post.id, status: "draft", ...state, author_id: 3, applied_version: draftStateFingerprint(state) });
  }
}

class ProofMedia {
  readonly calls: string[] = [];
  readonly attachments = new Map<string, number>();
  private next = 12000;
  getMediaByKey(key: string): Promise<{ mediaKey: string; attachmentId: number; status: "attachment" }> {
    this.calls.push(`get:${key}`); const id = this.attachments.get(key);
    return id ? Promise.resolve({ mediaKey: key, attachmentId: id, status: "attachment" }) : Promise.reject(new WordPressMediaError("NOT_FOUND", "safe", 404));
  }
  uploadMedia(input: { mediaKey: string }): Promise<{ mediaKey: string; attachmentId: number; status: "attachment"; outcome: "CREATED" }> {
    this.calls.push(`upload:${input.mediaKey}`); const attachmentId = this.next++; this.attachments.set(input.mediaKey, attachmentId);
    return Promise.resolve({ mediaKey: input.mediaKey, attachmentId, status: "attachment", outcome: "CREATED" });
  }
}

type Integrated = { process: InboundEventProcessingService; preparation: DraftPreparationService; round6: Round6FinalisationService; store: ProofStore; draft: ProofDraft; media: ProofMedia; sends: string[] };
function integrated(cutover: Date): Integrated {
  const store = new ProofStore(); const draft = new ProofDraft(); const media = new ProofMedia(); const sends: string[] = [];
  const config = { get: (key: string) => key === "round6.controlCutoverAt" ? cutover : 86400 } as unknown as ConfigService<ApplicationConfiguration, true>;
  const preparation = new DraftPreparationService(prisma, config, store, draft as unknown as WordPressDraftClient, media as unknown as WordPressMediaClient);
  const machine = new ConversationStateMachineService(prisma);
  const round6 = new Round6FinalisationService(prisma, preparation, new ApprovalPromptService(), { dispatchOne: (id: string) => { sends.push(id); return Promise.resolve("SENT"); } } as never, machine);
  return { process: new InboundEventProcessingService(prisma, new ReporterAuthorizationService(), new ConversationProvisioningService(), new StoredWhatsappEventParser(), new StoryEventProcessor(machine), undefined, config, preparation, round6), preparation, round6, store, draft, media, sends };
}

class ProofMetaTransport implements MetaOutboundTransport {
  readonly requests: MetaTransportRequest[] = [];
  constructor(private readonly result: MetaTransportResponse | Error) {}
  send(request: MetaTransportRequest): Promise<MetaTransportResponse> {
    this.requests.push(request);
    return this.result instanceof Error ? Promise.reject(this.result) : Promise.resolve(this.result);
  }
}

function integratedMeta(result: MetaTransportResponse | Error): Integrated & { dispatcher: WhatsappOutboundDispatcher; transport: ProofMetaTransport } {
  const store = new ProofStore(); const draft = new ProofDraft(); const media = new ProofMedia(); const sends: string[] = [];
  const config = new ConfigService({
    round6: { controlCutoverAt: new Date(0) },
    preview: { ttlSeconds: 86400, hmacSecret: Buffer.alloc(32, 7).toString("base64url"), publicOrigin: "https://preview.test" },
    whatsapp: { accessToken: "test-only-token", phoneNumberId: "123456789", graphApiVersion: "v99.0", outboundRequestTimeoutMs: 1000 },
  }) as unknown as ConfigService<ApplicationConfiguration, true>;
  const preparation = new DraftPreparationService(prisma, config, store, draft as unknown as WordPressDraftClient, media as unknown as WordPressMediaClient);
  const transport = new ProofMetaTransport(result);
  const client = new WhatsappOutboundClient(config, transport);
  const dispatcher = new WhatsappOutboundDispatcher(prisma, new PreviewTokenService(config, preparation), client, config);
  const machine = new ConversationStateMachineService(prisma);
  const round6 = new Round6FinalisationService(prisma, preparation, new ApprovalPromptService(), dispatcher, machine);
  const process = new InboundEventProcessingService(prisma, new ReporterAuthorizationService(), new ConversationProvisioningService(), new StoredWhatsappEventParser(), new StoryEventProcessor(machine), undefined, config, preparation, round6);
  return { process, preparation, round6, store, draft, media, sends, dispatcher, transport };
}

let ingest = 1n;
let wordpressCategory = BigInt(Date.now()) * 1000n;
async function inboundSeed(receivedAt: Date, providerOccurredAt: Date, mediaCount = 0): Promise<{ eventId: string; storyId: string; conversationId: string; reporterId: string }> {
  providerOccurredAt = new Date(Math.floor(providerOccurredAt.getTime() / 1000) * 1000);
  const reporter = await prisma.reporter.create({ data: { phoneNumber: `+2637${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "1")}`, displayName: "Integrated", editorialByline: "Proof Byline", status: ReporterStatus.ACTIVE } });
  const story = await prisma.story.create({ data: { reporterId: reporter.id, status: StoryStatus.COLLECTING, headline: "Exact headline", body: "Exact body", byline: "Proof Byline", version: 2 } });
  const conversation = await prisma.conversation.create({ data: { reporterId: reporter.id, state: ConversationState.COLLECTING_MEDIA, currentStoryId: story.id, version: 6 } });
  const category = await prisma.editorialCategory.create({ data: { wordpressCategoryId: wordpressCategory++, name: "Proof", slug: `proof-${randomUUID()}`, status: EditorialCategoryStatus.ACTIVE } });
  await prisma.storyCategory.create({ data: { storyId: story.id, categoryId: category.id } });
  for (let position = 0; position < mediaCount; position++) {
    const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(8, position + 1)]); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const row = await prisma.storyMedia.create({ data: { storyId: story.id, providerMediaId: randomUUID(), mediaType: StoryMediaType.IMAGE, status: MediaProcessingStatus.FETCHED, mimeType: "image/png", fileSizeBytes: BigInt(bytes.length), sha256, position } });
    // inserted into the selected runtime by each test
    Reflect.set(row, "proofBytes", { bytes, mimeType: "image/png", size: bytes.length, sha256 });
  }
  const providerMessageId = randomUUID();
  const event = await prisma.inboundEvent.create({ data: { provider: Provider.WHATSAPP, providerMessageId, senderPhone: reporter.phoneNumber, senderIngestSequence: ingest++, eventType: InboundEventType.TEXT, processingStatus: InboundProcessingStatus.RECEIVED, receivedAt, providerOccurredAt, rawPayload: { message: { id: providerMessageId, from: reporter.phoneNumber.slice(1), timestamp: String(Math.floor(providerOccurredAt.getTime()/1000)), type: "text", text: { body: "/done" } } } } });
  return { eventId: event.id, storyId: story.id, conversationId: conversation.id, reporterId: reporter.id };
}

async function loadMedia(runtime: Integrated, storyId: string): Promise<void> {
  const rows = await prisma.storyMedia.findMany({ where: { storyId }, orderBy: { position: "asc" } });
  for (const row of rows) { const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(8, row.position + 1)]); runtime.store.objects.set(mediaObjectKey(row.id), { bytes, mimeType: "image/png", size: Number(row.fileSizeBytes), sha256: row.sha256! }); }
}

async function seed(): Promise<PreparedAuthority> {
  const reporter = await prisma.reporter.create({
    data: {
      phoneNumber: `+263${Date.now().toString().slice(-9)}`,
      displayName: "Round 6",
      status: ReporterStatus.ACTIVE,
    },
  });
  const story = await prisma.story.create({
    data: {
      reporterId: reporter.id,
      status: StoryStatus.DRAFT_CREATED,
      headline: "Headline",
      body: "Body",
      byline: "Byline",
      version: 7,
      wordpressPostId: BigInt(Date.now()),
      draftCreatedAt: new Date(),
    },
  });
  await prisma.conversation.create({
    data: {
      reporterId: reporter.id,
      state: ConversationState.COLLECTING_MEDIA,
      currentStoryId: story.id,
      version: 4,
    },
  });
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId: randomUUID(),
      reporterId: reporter.id,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: BigInt(Date.now()),
      eventType: InboundEventType.TEXT,
      processingStatus: InboundProcessingStatus.PROCESSING,
      rawPayload: {},
      receivedAt: new Date(),
    },
  });
  const category = await prisma.editorialCategory.create({
    data: {
      wordpressCategoryId: BigInt(Date.now()),
      name: "News",
      slug: `news-${randomUUID()}`,
      status: EditorialCategoryStatus.ACTIVE,
    },
  });
  await prisma.storyCategory.create({
    data: { storyId: story.id, categoryId: category.id },
  });
  const preparation = await prisma.draftPreparation.create({
    data: {
      storyId: story.id,
      inboundEventId: event.id,
      storyVersion: story.version,
      status: DraftPreparationStatus.ACTIVE,
      wordpressPostId: story.wordpressPostId,
      wordpressAppliedVersion: "a".repeat(64),
      approvalPromptCorrelationKey: `round6:approval-prompt:${randomUUID()}`,
      previewExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  return {
    preparationId: preparation.id,
    storyId: story.id,
    storyVersion: story.version,
    wordpressPostId: Number(story.wordpressPostId),
    wordpressAppliedVersion: "a".repeat(64),
    previewExpiresAt: preparation.previewExpiresAt,
    state: {
      title: "Headline",
      content: "Body",
      excerpt: "",
      categories: [Number(category.wordpressCategoryId)],
      editorial_byline: "Byline",
      featured_media_key: null,
    },
  };
}

describe("Round 6 Phase E", () => {
  beforeEach(async () =>
    prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'),
  );
  afterAll(async () => prisma.$disconnect());

  it("serializes 20 completions into one atomic approval posture", async () => {
    const authority = await seed();
    const service = new Round6FinalisationService(
      prisma,
      {} as never,
      new ApprovalPromptService(),
      {} as never,
      new ConversationStateMachineService(prisma),
    );
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        prisma.$transaction(
          (tx) => service.completeApprovalPostureInTransaction(tx, authority),
          { maxWait: 30_000, timeout: 30_000 },
        ),
      ),
    );
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(
      20,
    );
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: authority.storyId },
      include: {
        activeInConversation: true,
        draftPreparations: true,
        outboundMessages: true,
      },
    });
    expect(story.status).toBe(StoryStatus.AWAITING_APPROVAL);
    expect(story.version).toBe(authority.storyVersion);
    expect(story.activeInConversation).toMatchObject({
      state: ConversationState.AWAITING_APPROVAL,
      version: 5,
    });
    expect(story.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
    });
    expect(story.outboundMessages).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { storyId: story.id, eventType: "story_ready_for_approval" },
      }),
    ).toBe(1);
    expect(await prisma.approval.count({ where: { storyId: story.id } })).toBe(
      0,
    );
  });

  it("rolls back prompt and every posture mutation when the outer transaction fails", async () => {
    const authority = await seed();
    const service = new Round6FinalisationService(
      prisma,
      {} as never,
      new ApprovalPromptService(),
      {} as never,
      new ConversationStateMachineService(prisma),
    );
    await expect(
      prisma.$transaction(async (tx) => {
        await service.completeApprovalPostureInTransaction(tx, authority);
        throw new Error("injected rollback");
      }),
    ).rejects.toThrow("injected rollback");
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: authority.storyId },
      include: {
        activeInConversation: true,
        draftPreparations: true,
        outboundMessages: true,
      },
    });
    expect(story.status).toBe(StoryStatus.DRAFT_CREATED);
    expect(story.activeInConversation).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      version: 4,
    });
    expect(story.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.ACTIVE,
      approvalPromptOutboundMessageId: null,
    });
    expect(story.outboundMessages).toHaveLength(0);
  });

  it("uses persisted receivedAt exclusively for the complete six-case cutover matrix", async () => {
    const cutover = new Date("2030-01-01T00:00:00.000Z");
    const cases = [
      { received: -1, provider: -10_000, eligible: false },
      { received: 0, provider: -10_000, eligible: true },
      { received: 1, provider: -10_000, eligible: true },
      { received: 1, provider: -86_400_000, eligible: true },
      { received: -1, provider: 86_400_000, eligible: false },
      { received: -86_400_000, provider: 86_400_000, eligible: false },
    ];
    for (const item of cases) {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE');
      const runtime = integrated(cutover);
      const value = await inboundSeed(new Date(cutover.getTime() + item.received), new Date(cutover.getTime() + item.provider));
      const result = await runtime.process.process(value.eventId);
      if (item.eligible) {
        expect(result.outcome).toBe("PROCESSED");
        expect(await prisma.draftPreparation.count()).toBe(1);
      } else {
        expect(result).toEqual({ outcome: "IGNORED", reason: "CONTROL_NOT_ENABLED" });
        expect(await prisma.draftPreparation.count()).toBe(0);
        expect((await prisma.story.findUniqueOrThrow({ where: { id: value.storyId } })).version).toBe(2);
        expect(runtime.draft.calls).toHaveLength(0);
      }
    }
  });

  it.each([0, 1, 3])("runs the full inbound /done path with %i media", async (mediaCount) => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date(), mediaCount);
    await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toEqual({ outcome: "PROCESSED", reporterId: value.reporterId, conversationId: value.conversationId });
    const story = await prisma.story.findUniqueOrThrow({ where: { id: value.storyId }, include: { activeInConversation: true, draftPreparations: true, outboundMessages: true, media: { orderBy: { position: "asc" } } } });
    expect(story).toMatchObject({ status: StoryStatus.AWAITING_APPROVAL, version: 3 });
    expect(story.activeInConversation).toMatchObject({ state: ConversationState.AWAITING_APPROVAL, version: 7, currentStoryId: story.id });
    expect(story.draftPreparations).toHaveLength(1); expect(story.outboundMessages).toHaveLength(1); expect(runtime.sends).toHaveLength(1);
    expect(story.media.map((row) => row.position)).toEqual(Array.from({ length: mediaCount }, (_, index) => index));
    expect(runtime.media.attachments.size).toBe(mediaCount);
    expect(await prisma.approval.count()).toBe(0);
  });

  it("converges 20 full process calls on one epoch, preparation, prompt and dispatch", async () => {
    const runtime = integrated(new Date(0)); const value = await inboundSeed(new Date(), new Date());
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => runtime.process.process(value.eventId)));
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(20);
    const story = await prisma.story.findUniqueOrThrow({ where: { id: value.storyId }, include: { draftPreparations: true, outboundMessages: true, activeInConversation: true } });
    expect(story.version).toBe(3); expect(story.draftPreparations).toHaveLength(1); expect(story.outboundMessages).toHaveLength(1); expect(runtime.sends).toHaveLength(1);
    expect(story.activeInConversation).toMatchObject({ state: ConversationState.AWAITING_APPROVAL, version: 7 });
  });

  it("resumes a stranded PROCESSING event only through its matching preparation FK", async () => {
    const runtime = integrated(new Date(0)); const value = await inboundSeed(new Date(), new Date());
    await prisma.inboundEvent.update({ where: { id: value.eventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, reporterId: value.reporterId } });
    const phaseA = await prisma.$transaction((tx) => runtime.preparation.finalizeInTransaction(tx, { inboundEventId: value.eventId, reporterId: value.reporterId, conversationId: value.conversationId, storyId: value.storyId, expectedStoryVersion: 2 }));
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect((await prisma.story.findUniqueOrThrow({ where: { id: value.storyId } })).version).toBe(3);
    expect(await prisma.draftPreparation.count({ where: { inboundEventId: value.eventId } })).toBe(1);

    const other = await inboundSeed(new Date(), new Date());
    await prisma.inboundEvent.update({ where: { id: other.eventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING } });
    await expect(runtime.process.process(other.eventId)).resolves.toEqual({ outcome: "NOT_CLAIMED" });
    expect(phaseA.preparationId).toBeDefined();
  });

  it.each([
    ["headline", null, "COMPLETENESS_NOT_SATISFIED"],
    ["body", " ", "COMPLETENESS_NOT_SATISFIED"],
    ["byline", "", "COMPLETENESS_NOT_SATISFIED"],
  ])("terminalises incomplete %s through real inbound processing", async (field, value, code) => {
    const runtime = integrated(new Date(0)); const seeded = await inboundSeed(new Date(), new Date());
    await prisma.story.update({ where: { id: seeded.storyId }, data: { [field]: value } });
    await expect(runtime.process.process(seeded.eventId)).resolves.toEqual({ outcome: "IGNORED", reason: code });
    const event = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: seeded.eventId } });
    expect(event).toMatchObject({ processingStatus: InboundProcessingStatus.IGNORED, lastErrorCode: code, lastErrorMessage: null }); expect(event.processedAt).not.toBeNull();
    expect((await prisma.story.findUniqueOrThrow({ where: { id: seeded.storyId } })).version).toBe(2);
    expect(await prisma.draftPreparation.count()).toBe(0); expect(await prisma.outboundMessage.count()).toBe(0);
    expect(runtime.store.calls).toHaveLength(0); expect(runtime.draft.calls).toHaveLength(0); expect(runtime.media.calls).toHaveLength(0); expect(runtime.sends).toHaveLength(0);
  });

  it("rejects zero categories and inactive categories before any remote work", async () => {
    for (const inactive of [false, true]) {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'); const runtime = integrated(new Date(0)); const seeded = await inboundSeed(new Date(), new Date());
      if (inactive) await prisma.editorialCategory.updateMany({ data: { status: EditorialCategoryStatus.INACTIVE } });
      else await prisma.storyCategory.deleteMany({ where: { storyId: seeded.storyId } });
      const result = await runtime.process.process(seeded.eventId);
      expect(result).toEqual({ outcome: "IGNORED", reason: inactive ? "CATEGORY_SELECTION_NO_LONGER_ACTIVE" : "COMPLETENESS_NOT_SATISFIED" });
      expect(await prisma.draftPreparation.count()).toBe(0); expect(runtime.draft.calls).toHaveLength(0); expect(runtime.sends).toHaveLength(0);
    }
  });

  it.each([
    { status: MediaProcessingStatus.FETCHING },
    { mimeType: "text/plain" },
    { fileSizeBytes: 0n },
    { sha256: "invalid" },
  ])("rejects invalid media authority %# through real inbound processing", async (mutation) => {
    const runtime = integrated(new Date(0)); const seeded = await inboundSeed(new Date(), new Date(), 1); await prisma.storyMedia.updateMany({ where: { storyId: seeded.storyId }, data: mutation });
    await expect(runtime.process.process(seeded.eventId)).resolves.toEqual({ outcome: "IGNORED", reason: "COMPLETENESS_NOT_SATISFIED" });
    expect(await prisma.draftPreparation.count()).toBe(0); expect(runtime.store.calls).toHaveLength(0); expect(runtime.draft.calls).toHaveLength(0); expect(runtime.sends).toHaveLength(0);
  });

  it("preserves same-sender ordering and unblocks the next event after terminal rejection", async () => {
    const runtime = integrated(new Date(0)); const first = await inboundSeed(new Date(), new Date());
    const base = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: first.eventId } });
    await prisma.story.update({ where: { id: first.storyId }, data: { headline: null } });
    const second = await prisma.inboundEvent.create({ data: { provider: Provider.WHATSAPP, providerMessageId: randomUUID(), senderPhone: base.senderPhone, senderIngestSequence: ingest++, eventType: InboundEventType.TEXT, rawPayload: base.rawPayload as Prisma.InputJsonValue, receivedAt: new Date(), providerOccurredAt: base.providerOccurredAt } });
    await expect(runtime.process.process(second.id)).resolves.toEqual({ outcome: "ORDER_BLOCKED" });
    await expect(runtime.process.process(first.eventId)).resolves.toMatchObject({ outcome: "IGNORED" });
    await expect(runtime.process.claim(second.id)).resolves.toEqual({ outcome: "CLAIMED" });
  });

  it("deterministically blocks when the selected category deactivates after Phase A commits", async () => {
    const runtime = integrated(new Date(0));
    const seeded = await inboundSeed(new Date(), new Date());
    let release!: () => void;
    let phaseACommitted!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const committed = new Promise<void>((resolve) => { phaseACommitted = resolve; });
    const originalPrepare = runtime.preparation.prepare.bind(runtime.preparation);
    runtime.preparation.prepare = async (id: string): ReturnType<DraftPreparationService["prepare"]> => {
      phaseACommitted();
      await barrier;
      return originalPrepare(id);
    };
    const processing = runtime.process.process(seeded.eventId);
    await committed;
    await prisma.editorialCategory.updateMany({ data: { status: EditorialCategoryStatus.INACTIVE } });
    release();
    await expect(processing).resolves.toEqual({ outcome: "RETRY_REQUIRED", reason: "CATEGORY_SELECTION_NO_LONGER_ACTIVE" });
    const story = await prisma.story.findUniqueOrThrow({ where: { id: seeded.storyId }, include: { activeInConversation: true, draftPreparations: true, outboundMessages: true } });
    expect(story).toMatchObject({ status: StoryStatus.READY, version: 3 });
    expect(story.activeInConversation).toMatchObject({ state: ConversationState.COLLECTING_MEDIA, version: 6 });
    expect(story.draftPreparations).toHaveLength(1);
    expect(story.draftPreparations[0]).toMatchObject({ status: DraftPreparationStatus.BLOCKED, lastErrorCode: "CATEGORY_SELECTION_NO_LONGER_ACTIVE" });
    expect(story.outboundMessages).toHaveLength(0);
    expect(runtime.draft.calls).toHaveLength(0);
    expect(runtime.sends).toHaveLength(0);
  });

  it("recovers partial media authority through the public process entry without duplicating remote identities", async () => {
    const runtime = integrated(new Date(0)); const seeded = await inboundSeed(new Date(), new Date(), 2); await loadMedia(runtime, seeded.storyId);
    await prisma.inboundEvent.update({ where: { id: seeded.eventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, reporterId: seeded.reporterId } });
    const phaseA = await prisma.$transaction((tx) => runtime.preparation.finalizeInTransaction(tx, { inboundEventId: seeded.eventId, reporterId: seeded.reporterId, conversationId: seeded.conversationId, storyId: seeded.storyId, expectedStoryVersion: 2 }));
    const rows = await prisma.storyMedia.findMany({ where: { storyId: seeded.storyId }, orderBy: { position: "asc" } });
    runtime.media.attachments.set(rows[0]!.id, 12050);
    await prisma.storyMedia.update({ where: { id: rows[0]!.id }, data: { status: MediaProcessingStatus.UPLOADED, wordpressMediaId: 12050n } });
    await expect(runtime.process.process(seeded.eventId)).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(await prisma.draftPreparation.count({ where: { id: phaseA.preparationId } })).toBe(1);
    expect((await prisma.story.findUniqueOrThrow({ where: { id: seeded.storyId } })).version).toBe(3);
    expect(runtime.media.calls.filter((call) => call === `get:${rows[0]!.id}`)).toHaveLength(1);
    expect(runtime.media.calls.filter((call) => call === `upload:${rows[0]!.id}`)).toHaveLength(0);
    expect(runtime.media.calls.filter((call) => call === `upload:${rows[1]!.id}`)).toHaveLength(1);
    expect(runtime.draft.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  it("recovers an applied WordPress version through public process and performs Phase E once", async () => {
    const runtime = integrated(new Date(0)); const seeded = await inboundSeed(new Date(), new Date());
    await prisma.inboundEvent.update({ where: { id: seeded.eventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, reporterId: seeded.reporterId } });
    const phaseA = await prisma.$transaction((tx) => runtime.preparation.finalizeInTransaction(tx, { inboundEventId: seeded.eventId, reporterId: seeded.reporterId, conversationId: seeded.conversationId, storyId: seeded.storyId, expectedStoryVersion: 2 }));
    await expect(runtime.preparation.prepare(phaseA.preparationId)).resolves.toMatchObject({ outcome: "PREPARED" });
    const callsBefore = runtime.draft.calls.filter((call) => call.startsWith("create:")).length;
    await expect(runtime.process.process(seeded.eventId)).resolves.toMatchObject({ outcome: "PROCESSED" });
    const story = await prisma.story.findUniqueOrThrow({ where: { id: seeded.storyId }, include: { draftPreparations: true, outboundMessages: true } });
    expect(story).toMatchObject({ status: StoryStatus.AWAITING_APPROVAL, version: 3 });
    expect(story.draftPreparations).toHaveLength(1); expect(story.draftPreparations[0]).toMatchObject({ id: phaseA.preparationId, status: DraftPreparationStatus.READY_FOR_APPROVAL });
    expect(story.outboundMessages).toHaveLength(1); expect(runtime.draft.calls.filter((call) => call.startsWith("create:")).length).toBe(callsBefore);
  });

  it("dispatches a post-Phase-E PENDING prompt explicitly without replaying /done", async () => {
    const runtime = integratedMeta({ status: 200, body: { messages: [{ id: "wamid.recovery-d" }] } }); const seeded = await inboundSeed(new Date(), new Date());
    await prisma.inboundEvent.update({ where: { id: seeded.eventId }, data: { processingStatus: InboundProcessingStatus.PROCESSING, reporterId: seeded.reporterId } });
    const phaseA = await prisma.$transaction((tx) => runtime.preparation.finalizeInTransaction(tx, { inboundEventId: seeded.eventId, reporterId: seeded.reporterId, conversationId: seeded.conversationId, storyId: seeded.storyId, expectedStoryVersion: 2 }));
    await runtime.preparation.prepare(phaseA.preparationId); const authority = await runtime.preparation.verifyPreparedAuthority(phaseA.preparationId);
    const completed = await prisma.$transaction((tx) => runtime.round6.completeApprovalPostureInTransaction(tx, authority));
    await expect(runtime.process.process(seeded.eventId)).resolves.toEqual({ outcome: "NOT_CLAIMED" });
    expect(await prisma.draftPreparation.count()).toBe(1); expect(await prisma.outboundMessage.count()).toBe(1); expect(runtime.transport.requests).toHaveLength(0);
    await expect(runtime.dispatcher.dispatchPending(10)).resolves.toEqual(["SENT"]);
    await expect(runtime.dispatcher.dispatchOne(completed.promptId)).resolves.toBe("NOT_CLAIMED");
    expect(runtime.transport.requests).toHaveLength(1);
  });

  it.each([
    ["success", { status: 200, body: { messages: [{ id: "wamid.integrated" }] } }, OutboundMessageStatus.SENT, null, "SENT"],
    ["definitive", { status: 400, body: { error: "controlled" } }, OutboundMessageStatus.FAILED, "WHATSAPP_REQUEST_REJECTED", "FAILED"],
    ["uncertain", new Error("response lost"), OutboundMessageStatus.SENDING, "WHATSAPP_SEND_OUTCOME_UNCERTAIN", "OUTCOME_UNCERTAIN"],
  ] as const)("runs full /done through real dispatcher and fake Meta: %s", async (_name, response, status, errorCode, _dispatchResult) => {
    const runtime = integratedMeta(response); const seeded = await inboundSeed(new Date(), new Date());
    await expect(runtime.process.process(seeded.eventId)).resolves.toMatchObject({ outcome: "PROCESSED" });
    const message = await prisma.outboundMessage.findFirstOrThrow({ where: { storyId: seeded.storyId } });
    expect(message).toMatchObject({ status, sendAttempts: 1, lastErrorCode: errorCode, lastErrorMessage: null });
    expect(message.providerMessageId).toBe(status === OutboundMessageStatus.SENT ? "wamid.integrated" : null);
    expect(runtime.transport.requests).toHaveLength(1);
    expect(JSON.stringify(message.payload)).not.toMatch(/token|preview/i);
    const story = await prisma.story.findUniqueOrThrow({ where: { id: seeded.storyId }, include: { activeInConversation: true, draftPreparations: true } });
    expect(story).toMatchObject({ status: StoryStatus.AWAITING_APPROVAL, version: 3 }); expect(story.activeInConversation).toMatchObject({ state: ConversationState.AWAITING_APPROVAL, version: 7 }); expect(story.draftPreparations[0]).toMatchObject({ status: DraftPreparationStatus.READY_FOR_APPROVAL });
    if (status === OutboundMessageStatus.SENDING) {
      await expect(runtime.dispatcher.dispatchPending(10)).resolves.toEqual([]);
      await expect(runtime.dispatcher.recoverUncertainSend(message.id)).resolves.toBe("MANUAL_RECONCILIATION_REQUIRED");
      expect(runtime.transport.requests).toHaveLength(1);
    }
  });

  it("dynamically proves every external and DNS boundary is outside all integrated /done transactions", async () => {
    const runtime = integratedMeta({ status: 200, body: { messages: [{ id: "wamid.io-boundary" }] } });
    const seeded = await inboundSeed(new Date(), new Date(), 1); await loadMedia(runtime, seeded.storyId);
    let transactionDepth = 0; const trace: string[] = [];
    type TxCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
    type TxInvoker = (callback: TxCallback, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => Promise<unknown>;
    const holder = prisma as unknown as { $transaction: TxInvoker };
    const originalTransaction = holder.$transaction.bind(prisma);
    holder.$transaction = async (callback, options): Promise<unknown> => originalTransaction(async (tx): Promise<unknown> => {
      transactionDepth += 1; trace.push("transaction:open");
      try { return await callback(tx); }
      finally { trace.push("transaction:commit"); transactionDepth -= 1; }
    }, options);
    const guard = (name: string): void => { expect(transactionDepth).toBe(0); trace.push(name); };
    const oldHead = runtime.store.head.bind(runtime.store); runtime.store.head = (key): ReturnType<typeof oldHead> => { guard("object:head"); return oldHead(key); };
    const oldRead = runtime.store.read.bind(runtime.store); runtime.store.read = (key): ReturnType<typeof oldRead> => { guard("object:read"); return oldRead(key); };
    const oldMediaGet = runtime.media.getMediaByKey.bind(runtime.media); runtime.media.getMediaByKey = (key): ReturnType<typeof oldMediaGet> => { guard("wordpress-media:get"); return oldMediaGet(key); };
    const oldMediaUpload = runtime.media.uploadMedia.bind(runtime.media); runtime.media.uploadMedia = (input): ReturnType<typeof oldMediaUpload> => { guard("wordpress-media:upload"); return oldMediaUpload(input); };
    const oldDraftGet = runtime.draft.getDraftByKey.bind(runtime.draft); runtime.draft.getDraftByKey = (key): ReturnType<typeof oldDraftGet> => { guard("wordpress-draft:get"); return oldDraftGet(key); };
    const oldDraftCreate = runtime.draft.createDraft.bind(runtime.draft); runtime.draft.createDraft = (input): ReturnType<typeof oldDraftCreate> => { guard("wordpress-draft:create"); return oldDraftCreate(input); };
    const oldDraftState = runtime.draft.getDraftState.bind(runtime.draft); runtime.draft.getDraftState = (key): ReturnType<typeof oldDraftState> => { guard("wordpress-draft:state"); return oldDraftState(key); };
    const oldDraftSync = runtime.draft.syncDraft.bind(runtime.draft); runtime.draft.syncDraft = (input): ReturnType<typeof oldDraftSync> => { guard("wordpress-draft:sync"); return oldDraftSync(input); };
    const oldMeta = runtime.transport.send.bind(runtime.transport); runtime.transport.send = (request): ReturnType<typeof oldMeta> => { guard("meta:send"); return oldMeta(request); };
    const dnsLookup = jest.spyOn(dns, "lookup");
    try {
      await expect(runtime.process.process(seeded.eventId)).resolves.toMatchObject({ outcome: "PROCESSED" });
      expect(transactionDepth).toBe(0); expect(dnsLookup).not.toHaveBeenCalled();
      expect(trace.indexOf("object:head")).toBeGreaterThan(trace.indexOf("transaction:commit"));
      const metaIndex = trace.lastIndexOf("meta:send");
      expect(metaIndex).toBeGreaterThan(trace.indexOf("transaction:commit"));
      expect(trace.slice(0, metaIndex)).toContain("transaction:commit");
    } finally {
      holder.$transaction = originalTransaction; dnsLookup.mockRestore();
    }
  });
});
