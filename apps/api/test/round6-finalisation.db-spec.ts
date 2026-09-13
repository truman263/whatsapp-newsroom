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
  PublishOperation,
  ReporterStatus,
  StoryStatus,
  StoryMediaType,
} from "@prisma/client";
import type { ApplicationConfiguration } from "../src/config/configuration";
import { PrismaService } from "../src/database/prisma.service";
import { DraftPreparationService } from "../src/modules/draft-preparation/draft-preparation.service";
import type { PreparedAuthority } from "../src/modules/draft-preparation/draft-preparation.types";
import { PreviewTokenService } from "../src/modules/newsroom-preview/newsroom-preview-token.service";
import { NewsroomPreviewService } from "../src/modules/newsroom-preview/newsroom-preview.service";
import { MediaStagingService } from "../src/modules/media-staging/media-staging.service";
import type { MediaAuthority, MediaProviderClient } from "../src/modules/media-staging/media-staging.types";
import { mediaObjectKey, type DownloadedMedia, type MediaObjectStore, type StoredObjectHead } from "../src/modules/media-staging/media-staging.types";
import { ConversationProvisioningService } from "../src/modules/reporter-workflow/conversation-provisioning.service";
import { ConversationStateMachineService } from "../src/modules/reporter-workflow/conversation-state-machine.service";
import { InboundEventProcessingService } from "../src/modules/reporter-workflow/inbound-event-processing.service";
import { ReporterAuthorizationService } from "../src/modules/reporter-workflow/reporter-authorization.service";
import { Round6FinalisationService } from "../src/modules/reporter-workflow/round6-finalisation.service";
import { Round6RevisionService } from "../src/modules/reporter-workflow/round6-revision.service";
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
  putIfAbsent(key: string, media: DownloadedMedia): Promise<"CREATED" | "EXISTS"> {
    if (this.objects.has(key)) return Promise.resolve("EXISTS");
    this.objects.set(key, media);
    return Promise.resolve("CREATED");
  }
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

class ProofMediaProvider implements MediaProviderClient {
  readonly calls: MediaAuthority[] = [];
  fetch(authority: MediaAuthority): Promise<DownloadedMedia> {
    this.calls.push(authority);
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(8, 9),
    ]);
    return Promise.resolve({
      bytes,
      mimeType: "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
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

type Integrated = { process: InboundEventProcessingService; preparation: DraftPreparationService; round6: Round6FinalisationService; store: ProofStore; provider: ProofMediaProvider; draft: ProofDraft; media: ProofMedia; sends: string[]; config: ConfigService<ApplicationConfiguration, true> };
function integrated(cutover: Date): Integrated {
  const store = new ProofStore(); const provider = new ProofMediaProvider(); const draft = new ProofDraft(); const media = new ProofMedia(); const sends: string[] = [];
  const config = { get: (key: string) => key === "round6.controlCutoverAt" ? cutover : 86400 } as unknown as ConfigService<ApplicationConfiguration, true>;
  const preparation = new DraftPreparationService(prisma, config, store, draft as unknown as WordPressDraftClient, media as unknown as WordPressMediaClient);
  const machine = new ConversationStateMachineService(prisma);
  const round6 = new Round6FinalisationService(prisma, preparation, new ApprovalPromptService(), { dispatchOne: (id: string) => { sends.push(id); return Promise.resolve("SENT"); } } as never, machine);
  const revisions = new Round6RevisionService(machine);
  return { process: new InboundEventProcessingService(prisma, new ReporterAuthorizationService(), new ConversationProvisioningService(), new StoredWhatsappEventParser(), new StoryEventProcessor(machine), new MediaStagingService(prisma, provider, store), config, preparation, round6, revisions), preparation, round6, store, provider, draft, media, sends, config };
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
  const store = new ProofStore(); const provider = new ProofMediaProvider(); const draft = new ProofDraft(); const media = new ProofMedia(); const sends: string[] = [];
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
  const process = new InboundEventProcessingService(prisma, new ReporterAuthorizationService(), new ConversationProvisioningService(), new StoredWhatsappEventParser(), new StoryEventProcessor(machine), new MediaStagingService(prisma, provider, store), config, preparation, round6, new Round6RevisionService(machine));
  return { process, preparation, round6, store, provider, draft, media, sends, config, dispatcher, transport };
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

async function controlEvent(
  reporterId: string,
  control: string,
  receivedAt = new Date(),
  interactive = false,
  providerOccurredAt = new Date(Math.floor(Date.now() / 1000) * 1000),
): Promise<string> {
  const reporter = await prisma.reporter.findUniqueOrThrow({
    where: { id: reporterId },
  });
  providerOccurredAt = new Date(
    Math.floor(providerOccurredAt.getTime() / 1000) * 1000,
  );
  const providerMessageId = randomUUID();
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: ingest++,
      eventType: interactive
        ? InboundEventType.INTERACTIVE
        : InboundEventType.TEXT,
      receivedAt,
      providerOccurredAt,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: reporter.phoneNumber.slice(1),
          timestamp: String(Math.floor(providerOccurredAt.getTime() / 1000)),
          type: interactive ? "interactive" : "text",
          ...(interactive
            ? {
                interactive: {
                  type: "button_reply",
                  button_reply: { id: control, title: "Revise" },
                },
              }
            : { text: { body: control } }),
        },
      },
    },
  });
  return event.id;
}

async function imageEvent(reporterId: string): Promise<string> {
  const reporter = await prisma.reporter.findUniqueOrThrow({ where: { id: reporterId } });
  const providerMessageId = randomUUID();
  const providerMediaId = `opaque.media:${randomUUID()}`;
  const occurredAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const event = await prisma.inboundEvent.create({
    data: {
      provider: Provider.WHATSAPP,
      providerMessageId,
      senderPhone: reporter.phoneNumber,
      senderIngestSequence: ingest++,
      eventType: InboundEventType.IMAGE,
      receivedAt: new Date(),
      providerOccurredAt: occurredAt,
      rawPayload: {
        message: {
          id: providerMessageId,
          from: reporter.phoneNumber.slice(1),
          timestamp: String(Math.floor(occurredAt.getTime() / 1000)),
          type: "image",
          image: { id: providerMediaId, mime_type: "image/png", caption: "New image" },
        },
      },
    },
  });
  return event.id;
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

describe("Round 6B.5 /revise revision", () => {
  beforeEach(async () =>
    prisma.$executeRawUnsafe('TRUNCATE TABLE "Reporter" CASCADE'),
  );

  async function posture(
    runtime: Integrated,
    mediaCount = 0,
  ): Promise<{
    eventId: string;
    storyId: string;
    conversationId: string;
    reporterId: string;
    storyVersion: number;
    conversationVersion: number;
    preparation: Awaited<ReturnType<typeof prisma.draftPreparation.findFirstOrThrow>>;
  }> {
    const value = await inboundSeed(new Date(), new Date(), mediaCount);
    if (mediaCount > 0) await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: {
        activeInConversation: true,
        draftPreparations: true,
        media: true,
      },
    });
    return {
      ...value,
      storyVersion: story.version,
      conversationVersion: story.activeInConversation!.version,
      preparation: story.draftPreparations[0]!,
    };
  }

  it.each([
    ["cutover - 1ms", -1, false],
    ["exactly at cutover", 0, true],
    ["cutover + 1ms", 1, true],
  ] as const)(
    "%s resolves revision eligibility from receivedAt only",
    async (_name, delta, eligible) => {
      const cutover = new Date("2030-01-01T00:00:00.000Z");
      const runtime = integrated(cutover);
      const value = await inboundSeed(
        new Date(cutover.getTime()),
        new Date(cutover.getTime() - 60_000),
      );
      await expect(runtime.process.process(value.eventId)).resolves.toMatchObject(
        { outcome: "PROCESSED" },
      );
      const first = await prisma.story.findUniqueOrThrow({
        where: { id: value.storyId },
        include: { activeInConversation: true, draftPreparations: true },
      });
      const draftCallsBefore = runtime.draft.calls.length;
      const mediaCallsBefore = runtime.media.calls.length;
      const storeCallsBefore = runtime.store.calls.length;
      const reviseId = await controlEvent(
        value.reporterId,
        "/revise",
        new Date(cutover.getTime() + delta),
      );
      const result = await runtime.process.process(reviseId);
      const revisionEvent = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: reviseId },
      });
      const after = await prisma.story.findUniqueOrThrow({
        where: { id: value.storyId },
        include: { activeInConversation: true, draftPreparations: true },
      });
      if (eligible) {
        expect(result).toMatchObject({
          outcome: "PROCESSED",
          reporterId: value.reporterId,
          conversationId: value.conversationId,
        });
        expect(revisionEvent.processingStatus).toBe(
          InboundProcessingStatus.PROCESSED,
        );
        expect(after).toMatchObject({
          status: StoryStatus.COLLECTING,
          version: first.version + 1,
        });
        expect(after.draftPreparations[0]).toMatchObject({
          status: DraftPreparationStatus.SUPERSEDED,
        });
        expect(after.draftPreparations[0]!.supersededAt).not.toBeNull();
        expect(after.activeInConversation).toMatchObject({
          state: ConversationState.COLLECTING_MEDIA,
          version: first.activeInConversation!.version + 1,
        });
        expect(runtime.sends).toHaveLength(1);
      } else {
        expect(result).toEqual({
          outcome: "IGNORED",
          reason: "CONTROL_NOT_ENABLED",
        });
        expect(revisionEvent.processingStatus).toBe(
          InboundProcessingStatus.IGNORED,
        );
        expect(after).toMatchObject({
          status: StoryStatus.AWAITING_APPROVAL,
          version: first.version,
        });
        expect(after.draftPreparations[0]).toMatchObject({
          status: DraftPreparationStatus.READY_FOR_APPROVAL,
          supersededAt: null,
        });
        expect(after.activeInConversation).toMatchObject({
          state: ConversationState.AWAITING_APPROVAL,
          version: first.activeInConversation!.version,
        });
        expect(await prisma.draftPreparation.count()).toBe(1);
        expect(runtime.sends).toHaveLength(1);
      }
      expect(runtime.draft.calls).toHaveLength(draftCallsBefore);
      expect(runtime.media.calls).toHaveLength(mediaCallsBefore);
      expect(runtime.store.calls).toHaveLength(storeCallsBefore);
    },
  );

  it.each([
    ["IDLE", ConversationState.IDLE],
    ["AWAITING_HEADLINE", ConversationState.AWAITING_HEADLINE],
    ["AWAITING_BODY", ConversationState.AWAITING_BODY],
    ["COLLECTING_MEDIA", ConversationState.COLLECTING_MEDIA],
  ] as const)(
    "rejects /revise while the conversation is in %s",
    async (_name, state) => {
      const runtime = integrated(new Date(0));
      const reporter = await prisma.reporter.create({
        data: {
          phoneNumber: `+263${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "3")}`,
          displayName: "State",
          status: ReporterStatus.ACTIVE,
        },
      });
      const story = await prisma.story.create({
        data: {
          reporterId: reporter.id,
          status: StoryStatus.COLLECTING,
          headline: "Exact headline",
          body: "Exact body",
          byline: "Proof Byline",
          version: 2,
        },
      });
      await prisma.conversation.create({
        data: {
          reporterId: reporter.id,
          state,
          currentStoryId: story.id,
          version: 1,
        },
      });
      const reviseId = await controlEvent(reporter.id, "/revise");
      await expect(runtime.process.process(reviseId)).resolves.toEqual({
        outcome: "IGNORED",
        reason: "TEXT_NOT_ACCEPTED_IN_STATE",
      });
      const event = await prisma.inboundEvent.findUniqueOrThrow({
        where: { id: reviseId },
      });
      expect(event.processingStatus).toBe(InboundProcessingStatus.IGNORED);
      expect(
        (await prisma.story.findUniqueOrThrow({ where: { id: story.id } }))
          .version,
      ).toBe(2);
      expect(await prisma.draftPreparation.count()).toBe(0);
      expect(runtime.draft.calls).toHaveLength(0);
      expect(runtime.sends).toHaveLength(0);
    },
  );

  it("fails closed when the story has left the awaiting posture toward publishing", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    await prisma.story.update({
      where: { id: value.storyId },
      data: { status: StoryStatus.PUBLISHING },
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "STORY_REVISION_CONFLICT",
    });
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { activeInConversation: true, draftPreparations: true },
    });
    expect(after.status).toBe(StoryStatus.PUBLISHING);
    expect(after.version).toBe(value.storyVersion);
    expect(after.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      supersededAt: null,
    });
    expect(after.activeInConversation).toMatchObject({
      state: ConversationState.AWAITING_APPROVAL,
      version: value.conversationVersion,
    });
  });

  it("fails closed when the approval prompt link on the preparation is gone", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    await prisma.draftPreparation.updateMany({
      data: { approvalPromptOutboundMessageId: null },
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "STORY_REVISION_CONFLICT",
    });
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(after.version).toBe(value.storyVersion);
    expect(after.draftPreparations[0]!.status).toBe(
      DraftPreparationStatus.READY_FOR_APPROVAL,
    );
    expect(await prisma.outboundMessage.count()).toBe(1);
  });

  it("fails closed when the story epoch no longer matches the prepared version", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
    });
    await prisma.story.update({
      where: { id: story.id },
      data: { version: story.version + 1 },
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "STORY_REVISION_CONFLICT",
    });
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(after.version).toBe(story.version + 1);
    expect(after.draftPreparations).toHaveLength(1);
    expect(after.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
    });
  });

  it("fails closed against cross-reporter ownership of the conversation story", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const other = await prisma.reporter.create({
      data: {
        phoneNumber: `+263${randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "2")}`,
        displayName: "Other",
        status: ReporterStatus.ACTIVE,
      },
    });
    await prisma.conversation.update({
      where: { id: value.conversationId },
      data: { reporterId: other.id },
    });
    const reviseId = await controlEvent(other.id, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "STORY_REVISION_CONFLICT",
    });
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(story.version).toBe(value.storyVersion);
    expect(story.draftPreparations[0]!.status).toBe(
      DraftPreparationStatus.READY_FOR_APPROVAL,
    );
  });

  it("converges 20 concurrent /revise calls on exactly one supersession and one bump", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const reviseId = await controlEvent(value.reporterId, "/revise");
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => runtime.process.process(reviseId)),
    );
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    const outcomes = settled.map((row) =>
      (row as PromiseFulfilledResult<Awaited<ReturnType<InboundEventProcessingService["process"]>>>)
        .value,
    );
    expect(
      outcomes.filter((row) => row.outcome === "PROCESSED"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((row) => row.outcome === "NOT_CLAIMED"),
    ).toHaveLength(19);
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { activeInConversation: true, draftPreparations: true },
    });
    expect(after.status).toBe(StoryStatus.COLLECTING);
    expect(after.version).toBe(value.storyVersion + 1);
    expect(after.draftPreparations).toHaveLength(1);
    expect(after.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.SUPERSEDED,
      storyVersion: value.storyVersion,
    });
    expect(after.activeInConversation).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      version: value.conversationVersion + 1,
    });
    const event = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: reviseId },
    });
    expect(event).toMatchObject({
      processingStatus: InboundProcessingStatus.PROCESSED,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    expect(event.processedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { storyId: value.storyId, eventType: "story_revision_requested" },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          storyId: value.storyId,
          eventType: "draft_preparation_superseded",
        },
      }),
    ).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
  });

  it("does not bump the epoch again for a distinct duplicate /revise", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const first = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(first)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const second = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(second)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "TEXT_NOT_ACCEPTED_IN_STATE",
    });
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { activeInConversation: true, draftPreparations: true },
    });
    expect(after.version).toBe(value.storyVersion + 1);
    expect(after.status).toBe(StoryStatus.COLLECTING);
    expect(after.draftPreparations).toHaveLength(1);
    expect(after.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.SUPERSEDED,
    });
    expect(after.activeInConversation).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      version: value.conversationVersion + 1,
    });
  });

  it("rolls back every revision mutation when the enclosing transaction fails", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const revisions = new Round6RevisionService(
      new ConversationStateMachineService(prisma),
    );
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await prisma.inboundEvent.update({
      where: { id: reviseId },
      data: {
        processingStatus: InboundProcessingStatus.PROCESSING,
        reporterId: value.reporterId,
      },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await revisions.reviseInTransaction(tx, {
          inboundEventId: reviseId,
          reporterId: value.reporterId,
          conversationId: value.conversationId,
          storyId: value.storyId,
          expectedStoryVersion: value.storyVersion,
        });
        throw new Error("injected rollback");
      }),
    ).rejects.toThrow("injected rollback");
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { activeInConversation: true, draftPreparations: true },
    });
    expect(after.status).toBe(StoryStatus.AWAITING_APPROVAL);
    expect(after.version).toBe(value.storyVersion);
    expect(after.draftPreparations[0]).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      supersededAt: null,
    });
    expect(after.activeInConversation).toMatchObject({
      state: ConversationState.AWAITING_APPROVAL,
      version: value.conversationVersion,
    });
    const event = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: reviseId },
    });
    expect(event.processingStatus).toBe(InboundProcessingStatus.PROCESSING);
    expect(
      await prisma.auditLog.count({ where: { inboundEventId: reviseId } }),
    ).toBe(0);
  });

  it("reuses the same WordPress post across the full no-edit /done -> /revise -> /done cycle", async () => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date(), 1);
    await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const first = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { activeInConversation: true, draftPreparations: true },
    });
    const p1 = first.draftPreparations[0]!;
    const firstMessage = await prisma.outboundMessage.findFirstOrThrow({
      where: { storyId: first.id },
    });
    const draftCallsBefore = runtime.draft.calls.length;
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const revised = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: {
        activeInConversation: true,
        draftPreparations: true,
        media: true,
      },
    });
    expect(revised.status).toBe(StoryStatus.COLLECTING);
    expect(revised.version).toBe(first.version + 1);
    expect(revised.activeInConversation).toMatchObject({
      state: ConversationState.COLLECTING_MEDIA,
      version: first.activeInConversation!.version + 1,
    });
    const p1After = revised.draftPreparations.find((row) => row.id === p1.id)!;
    expect(p1After).toMatchObject({
      status: DraftPreparationStatus.SUPERSEDED,
      wordpressPostId: p1.wordpressPostId,
      wordpressAppliedVersion: p1.wordpressAppliedVersion,
      previewExpiresAt: p1.previewExpiresAt,
      readyAt: p1.readyAt,
      approvalPromptOutboundMessageId: firstMessage.id,
      approvalPromptCorrelationKey: p1.approvalPromptCorrelationKey,
    });
    expect(p1After.supersededAt).not.toBeNull();
    expect(p1After.wordpressAppliedVersion).toMatch(/^[0-9a-f]{64}$/u);
    expect(revised.media).toHaveLength(1);
    expect(revised.media[0]).toMatchObject({
      status: MediaProcessingStatus.UPLOADED,
    });
    expect(await prisma.outboundMessage.count()).toBe(1);
    expect(runtime.draft.calls).toHaveLength(draftCallsBefore);
    expect(runtime.sends).toHaveLength(1);
    const secondDone = await controlEvent(value.reporterId, "/done");
    await expect(runtime.process.process(secondDone)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const second = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: {
        activeInConversation: true,
        draftPreparations: true,
        media: true,
      },
    });
    expect(second.status).toBe(StoryStatus.AWAITING_APPROVAL);
    expect(second.version).toBe(first.version + 2);
    expect(second.wordpressPostId).toEqual(first.wordpressPostId);
    expect(second.wordpressDraftKey).toEqual(first.wordpressDraftKey);
    expect(second.activeInConversation).toMatchObject({
      state: ConversationState.AWAITING_APPROVAL,
      version: first.activeInConversation!.version + 2,
    });
    expect(second.draftPreparations).toHaveLength(2);
    const p2 = second.draftPreparations.find((row) => row.id !== p1After.id)!;
    expect(p2).toMatchObject({
      status: DraftPreparationStatus.READY_FOR_APPROVAL,
      storyVersion: second.version,
      wordpressPostId: first.wordpressPostId,
    });
    expect(p2.id).not.toBe(p1After.id);
    expect(p2.readyAt).not.toBeNull();
    expect(p2.approvalPromptOutboundMessageId).not.toBeNull();
    expect(p2.approvalPromptOutboundMessageId).not.toBe(firstMessage.id);
    expect(await prisma.outboundMessage.count()).toBe(2);
    expect(runtime.sends).toHaveLength(2);
    expect(runtime.media.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(1);
    expect(runtime.draft.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(runtime.draft.posts.size).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { operation: PublishOperation.PUBLISH },
      }),
    ).toBe(0);
  });

  it("replaces categories exactly B over A on revision and keeps the same post count", async () => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date());
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const first = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { categories: { include: { category: true } } },
    });
    const categoryA = first.categories[0]!.category;
    const categoryB = await prisma.editorialCategory.create({
      data: {
        wordpressCategoryId: wordpressCategory++,
        name: "Proof B",
        slug: `proof-b-${randomUUID()}`,
        status: EditorialCategoryStatus.ACTIVE,
      },
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const categoryEvent = await controlEvent(
      value.reporterId,
      `/categories ${categoryB.slug}`,
    );
    await expect(runtime.process.process(categoryEvent)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const mid = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { categories: { include: { category: true } } },
    });
    expect(mid.categories.map((row) => row.category.slug)).toEqual([
      categoryB.slug,
    ]);
    expect(mid.categories.some((row) => row.category.id === categoryA.id)).toBe(
      false,
    );
    const createCalls = runtime.draft.calls.filter((call) =>
      call.startsWith("create:"),
    ).length;
    const secondDone = await controlEvent(value.reporterId, "/done");
    await expect(runtime.process.process(secondDone)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const second = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { categories: { include: { category: true } } },
    });
    expect(second.wordpressPostId).toEqual(first.wordpressPostId);
    expect(second.categories.map((row) => row.category.slug)).toEqual([
      categoryB.slug,
    ]);
    expect(runtime.draft.calls.filter((call) => call.startsWith("create:"))).toHaveLength(createCalls);
    expect(runtime.draft.posts.size).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { operation: PublishOperation.PUBLISH },
      }),
    ).toBe(0);
  });

  it("reuses retained media and stages a new image exactly once", async () => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date(), 1);
    await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const pos0 = (
      await prisma.storyMedia.findMany({
        where: { storyId: value.storyId },
        orderBy: { position: "asc" },
      })
    )[0]!;
    const pos0UploadsAtFirstDone = runtime.media.calls.filter(
      (call) => call === `upload:${pos0.id}`,
    ).length;
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const imageEventId = await imageEvent(value.reporterId);
    await expect(runtime.process.process(imageEventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const mid = await prisma.storyMedia.findMany({
      where: { storyId: value.storyId },
      orderBy: { position: "asc" },
    });
    expect(mid.map((row) => row.position)).toEqual([0, 1]);
    expect(mid[0]).toMatchObject({
      status: MediaProcessingStatus.UPLOADED,
      id: pos0.id,
    });
    expect(mid[1]).toMatchObject({ status: MediaProcessingStatus.FETCHED });
    const secondDone = await controlEvent(value.reporterId, "/done");
    await expect(runtime.process.process(secondDone)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const after = await prisma.storyMedia.findMany({
      where: { storyId: value.storyId },
      orderBy: { position: "asc" },
    });
    expect(after.map((row) => row.position)).toEqual([0, 1]);
    expect(after[0]).toMatchObject({
      id: pos0.id,
      status: MediaProcessingStatus.UPLOADED,
      wordpressMediaId: pos0.wordpressMediaId,
    });
    expect(after[1]).toMatchObject({ status: MediaProcessingStatus.UPLOADED });
    expect(
      runtime.media.calls.filter((call) => call === `get:${pos0.id}`),
    ).toHaveLength(1);
    expect(
      runtime.media.calls.filter((call) => call === `upload:${pos0.id}`),
    ).toHaveLength(pos0UploadsAtFirstDone);
    expect(
      runtime.media.calls.filter((call) => call === `upload:${mid[1]!.id}`),
    ).toHaveLength(1);
    expect(
      runtime.provider.calls.filter(
        (authority) =>
          authority.providerMediaId === mid[1]!.providerMediaId,
      ),
    ).toHaveLength(1);
    expect(runtime.sends).toHaveLength(2);
    expect(await prisma.approval.count()).toBe(0);
    expect(
      await prisma.publishAttempt.count({
        where: { operation: PublishOperation.PUBLISH },
      }),
    ).toBe(0);
  });

  it("issues a fresh preview token for the second epoch and keeps the first stale", async () => {
    const runtime = integrated(new Date(0));
    const value = await posture(runtime);
    const config = new ConfigService({
      preview: {
        ttlSeconds: 86400,
        hmacSecret: Buffer.alloc(32, 7).toString("base64url"),
        publicOrigin: "https://preview.test",
      },
    }) as unknown as ConfigService<ApplicationConfiguration, true>;
    const tokens = new PreviewTokenService(config, runtime.preparation);
    const newsroom = new NewsroomPreviewService(
      prisma,
      tokens,
      runtime.preparation,
      runtime.store,
    );
    const firstToken = await tokens.issue(value.preparation.id);
    expect(firstToken).toContain(".");
    await expect(newsroom.render(firstToken)).resolves.toMatchObject({
      headline: "Exact headline",
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    await expect(tokens.issue(value.preparation.id)).rejects.toThrow();
    await expect(newsroom.render(firstToken)).rejects.toThrow();
    const secondDone = await controlEvent(value.reporterId, "/done");
    await expect(runtime.process.process(secondDone)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const p2 = await prisma.draftPreparation.findFirstOrThrow({
      where: {
        storyId: value.storyId,
        status: DraftPreparationStatus.READY_FOR_APPROVAL,
      },
    });
    const secondToken = await tokens.issue(p2.id);
    expect(secondToken).not.toBe(firstToken);
    await expect(newsroom.render(secondToken)).resolves.toMatchObject({
      headline: "Exact headline",
    });
  });

  it("never dispatches a stale prompt once the revision has superseded it", async () => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date());
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const message = await prisma.outboundMessage.findFirstOrThrow({
      where: { storyId: value.storyId },
    });
    expect(message.status).toBe(OutboundMessageStatus.PENDING);
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const config = new ConfigService({
      preview: {
        ttlSeconds: 86400,
        hmacSecret: Buffer.alloc(32, 7).toString("base64url"),
        publicOrigin: "https://preview.test",
      },
      whatsapp: {
        accessToken: "test-only-token",
        phoneNumberId: "123456789",
        graphApiVersion: "v99.0",
        outboundRequestTimeoutMs: 1000,
      },
    }) as unknown as ConfigService<ApplicationConfiguration, true>;
    const proofTransport = new ProofMetaTransport({
      status: 200,
      body: { messages: [{ id: "wamid.race-a" }] },
    });
    const dispatcher = new WhatsappOutboundDispatcher(
      prisma,
      new PreviewTokenService(config, runtime.preparation),
      new WhatsappOutboundClient(config, proofTransport),
      config,
    );
    await expect(dispatcher.dispatchOne(message.id)).resolves.toBe(
      "NOT_CLAIMED",
    );
    await expect(dispatcher.dispatchPending(10)).resolves.toEqual([
      "NOT_CLAIMED",
    ]);
    const after = await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: message.id },
    });
    expect(after.status).toBe(OutboundMessageStatus.PENDING);
    expect(after.sendAttempts).toBe(0);
    expect(proofTransport.requests).toHaveLength(0);
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
    });
    expect(story.status).toBe(StoryStatus.COLLECTING);
  });

  it("leaves a dispatched prompt historical when revision arrives after delivery", async () => {
    const runtime = integratedMeta({
      status: 200,
      body: { messages: [{ id: "wamid.race-b" }] },
    });
    const value = await inboundSeed(new Date(), new Date());
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const message = await prisma.outboundMessage.findFirstOrThrow({
      where: { storyId: value.storyId },
    });
    expect(message.status).toBe(OutboundMessageStatus.SENT);
    expect(message.providerMessageId).toBe("wamid.race-b");
    expect(runtime.transport.requests).toHaveLength(1);
    const reviseId = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const historical = await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: message.id },
    });
    expect(historical.status).toBe(OutboundMessageStatus.SENT);
    expect(historical.providerMessageId).toBe("wamid.race-b");
    expect(runtime.transport.requests).toHaveLength(1);
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(story.status).toBe(StoryStatus.COLLECTING);
    expect(story.draftPreparations[0]!.status).toBe(
      DraftPreparationStatus.SUPERSEDED,
    );
    expect(await prisma.outboundMessage.count()).toBe(1);
    expect(await prisma.approval.count()).toBe(0);
  });

  it("fails the second /done closed when retained media lacks supersession authority", async () => {
    const runtime = integrated(new Date(0));
    const value = await inboundSeed(new Date(), new Date(), 1);
    await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const revision = await controlEvent(value.reporterId, "/revise");
    await expect(runtime.process.process(revision)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const story = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    await prisma.draftPreparation.update({
      where: { id: story.draftPreparations[0]!.id },
      data: { status: DraftPreparationStatus.ACTIVE, supersededAt: null },
    });
    const secondDone = await controlEvent(value.reporterId, "/done");
    await expect(runtime.process.process(secondDone)).resolves.toEqual({
      outcome: "IGNORED",
      reason: "COMPLETENESS_NOT_SATISFIED",
    });
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(after.status).toBe(StoryStatus.COLLECTING);
    expect(after.version).toBe(story.version);
    expect(after.draftPreparations).toHaveLength(1);
    expect(runtime.draft.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(runtime.media.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(1);
    expect(await prisma.approval.count()).toBe(0);
  });

  it.each([
    ["wordpressMediaId null", { wordpressMediaId: null }],
    ["wordpressMediaId zero", { wordpressMediaId: 0n }],
    ["zero bytes", { fileSizeBytes: 0n }],
    ["invalid sha256", { sha256: "invalid" }],
    ["unsupported mime", { mimeType: "text/plain" }],
    ["downgraded status", { status: MediaProcessingStatus.RECEIVED }],
  ] as const)(
    "rejects unsafe retained media %# on second /done",
    async (_name, mutation) => {
      const runtime = integrated(new Date(0));
      const value = await inboundSeed(new Date(), new Date(), 1);
      await loadMedia(runtime, value.storyId);
      await expect(runtime.process.process(value.eventId)).resolves.toMatchObject(
        { outcome: "PROCESSED" },
      );
      const revision = await controlEvent(value.reporterId, "/revise");
      await expect(runtime.process.process(revision)).resolves.toMatchObject({
        outcome: "PROCESSED",
      });
      const story = await prisma.story.findUniqueOrThrow({
        where: { id: value.storyId },
      });
      await prisma.storyMedia.updateMany({
        where: { storyId: value.storyId },
        data: mutation,
      });
      const secondDone = await controlEvent(value.reporterId, "/done");
      await expect(runtime.process.process(secondDone)).resolves.toEqual({
        outcome: "IGNORED",
        reason: "COMPLETENESS_NOT_SATISFIED",
      });
      const after = await prisma.story.findUniqueOrThrow({
        where: { id: value.storyId },
        include: { draftPreparations: true },
      });
      expect(after.version).toBe(story.version);
      expect(after.status).toBe(StoryStatus.COLLECTING);
      expect(after.draftPreparations).toHaveLength(1);
      expect(runtime.draft.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
      expect(runtime.media.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(1);
      expect(await prisma.approval.count()).toBe(0);
    },
  );

  it("proves the /revise transaction performs zero external I/O", async () => {
    const runtime = integratedMeta({
      status: 200,
      body: { messages: [{ id: "wamid.io-revise" }] },
    });
    const value = await inboundSeed(new Date(), new Date(), 1);
    await loadMedia(runtime, value.storyId);
    await expect(runtime.process.process(value.eventId)).resolves.toMatchObject({
      outcome: "PROCESSED",
    });
    const reviseId = await controlEvent(value.reporterId, "/revise");
    let transactionDepth = 0;
    const trace: string[] = [];
    type TxCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
    type TxInvoker = (
      callback: TxCallback,
      options?: {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      },
    ) => Promise<unknown>;
    const holder = prisma as unknown as { $transaction: TxInvoker };
    const originalTransaction = holder.$transaction.bind(prisma);
    holder.$transaction = async (callback, options): Promise<unknown> =>
      originalTransaction(async (tx): Promise<unknown> => {
        transactionDepth += 1;
        trace.push("transaction:open");
        try {
          return await callback(tx);
        } finally {
          trace.push("transaction:commit");
          transactionDepth -= 1;
        }
      }, options);
    const guard = (name: string): void => {
      expect(transactionDepth).toBe(0);
      trace.push(name);
    };
    const oldHead = runtime.store.head.bind(runtime.store);
    runtime.store.head = (key): ReturnType<typeof oldHead> =>
      oldHead(key).then((value) => (guard("object:head"), value));
    const oldRead = runtime.store.read.bind(runtime.store);
    runtime.store.read = (key): ReturnType<typeof oldRead> =>
      oldRead(key).then((value) => (guard("object:read"), value));
    const oldMediaGet = runtime.media.getMediaByKey.bind(runtime.media);
    runtime.media.getMediaByKey = (key): ReturnType<typeof oldMediaGet> =>
      oldMediaGet(key).then((value) => (guard("wordpress-media:get"), value));
    const oldMediaUpload = runtime.media.uploadMedia.bind(runtime.media);
    runtime.media.uploadMedia = (input): ReturnType<typeof oldMediaUpload> =>
      oldMediaUpload(input).then((value) => (guard("wordpress-media:upload"), value));
    const oldDraftGet = runtime.draft.getDraftByKey.bind(runtime.draft);
    runtime.draft.getDraftByKey = (key): ReturnType<typeof oldDraftGet> =>
      oldDraftGet(key).then((value) => (guard("wordpress-draft:get"), value));
    const oldDraftCreate = runtime.draft.createDraft.bind(runtime.draft);
    runtime.draft.createDraft = (input): ReturnType<typeof oldDraftCreate> =>
      oldDraftCreate(input).then((value) => (guard("wordpress-draft:create"), value));
    const oldDraftState = runtime.draft.getDraftState.bind(runtime.draft);
    runtime.draft.getDraftState = (key): ReturnType<typeof oldDraftState> =>
      oldDraftState(key).then((value) => (guard("wordpress-draft:state"), value));
    const oldDraftSync = runtime.draft.syncDraft.bind(runtime.draft);
    runtime.draft.syncDraft = (input): ReturnType<typeof oldDraftSync> =>
      oldDraftSync(input).then((value) => (guard("wordpress-draft:sync"), value));
    const oldMeta = runtime.transport.send.bind(runtime.transport);
    runtime.transport.send = (request): ReturnType<typeof oldMeta> =>
      oldMeta(request).then((value) => (guard("meta:send"), value));
    const dnsLookup = jest.spyOn(dns, "lookup");
    try {
      await expect(runtime.process.process(reviseId)).resolves.toMatchObject({
        outcome: "PROCESSED",
      });
      expect(transactionDepth).toBe(0);
      expect(dnsLookup).not.toHaveBeenCalled();
      expect(
        trace.filter((entry) => !entry.startsWith("transaction:")),
      ).toEqual([]);
    } finally {
      holder.$transaction = originalTransaction;
      dnsLookup.mockRestore();
    }
    const after = await prisma.story.findUniqueOrThrow({
      where: { id: value.storyId },
      include: { draftPreparations: true },
    });
    expect(after.draftPreparations[0]!.status).toBe(
      DraftPreparationStatus.SUPERSEDED,
    );
    expect(await prisma.approval.count()).toBe(0);
  });
});
