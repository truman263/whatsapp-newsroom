import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(runtimeDir, "..", "..", "..");
const require = createRequire(resolve(repo, "apps/api/package.json"));
require("ts-node").register({
  project: resolve(repo, "apps/api/tsconfig.json"),
});
const composeFile = resolve(
  runtimeDir,
  "..",
  "draft-sync-implementation",
  "compose.yaml",
);
const envFile = resolve(runtimeDir, ".env.runtime");
const resultFile = resolve(runtimeDir, "runtime-results.json");
const project = "newsroom-draft-preparation-proof";
const pgName = "newsroom-draft-preparation-pg";
const evidence = { results: [], runtime: {} };
const responseStatuses = [];
let port;
let pgPort;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = [result.error?.code, result.stderr, result.stdout]
      .filter(Boolean)
      .join(" ")
      .slice(-1500)
      .replaceAll(/postgresql:\/\/[^\s]+/g, "[database-url-redacted]");
    throw new Error(`${options.label ?? command} failed: ${diagnostic}`);
  }
  return (result.stdout ?? "").trim();
}
function compose(args) {
  return run(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      envFile,
      "--file",
      composeFile,
      ...args,
    ],
    { cwd: runtimeDir, label: "compose" },
  );
}
function wp(args) {
  return compose(["exec", "-T", "cli", "wp", ...args]);
}
function pass(name, details = {}) {
  evidence.results.push({ name, status: "PASS", details });
  process.stdout.write(`PASS ${name}\n`);
}
function assert(value, message) {
  if (!value) throw new Error(message);
}
async function freePort(start) {
  for (let value = start; value < start + 100; value++) {
    const free = await new Promise((done) => {
      const server = net.createServer();
      server.once("error", () => done(false));
      server.listen(value, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (free) return value;
  }
  throw new Error("no port");
}
async function waitHttp(base) {
  for (let i = 0; i < 90; i++) {
    try {
      await request("GET", "/", {}, base);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  throw new Error("WordPress unavailable");
}
function request(
  method,
  path,
  headers = {},
  base = `http://127.0.0.1:${port}`,
  body,
) {
  return new Promise((resolveRequest, rejectRequest) => {
    const bytes =
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body);
    const target = new URL(path, base);
    const outgoing = http.request(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(bytes.length ? { "content-length": String(bytes.length) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          responseStatuses.push({
            method,
            path: target.pathname,
            status: response.statusCode ?? 0,
          });
          resolveRequest({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    outgoing.on("error", rejectRequest);
    if (bytes.length) outgoing.write(bytes);
    outgoing.end();
  });
}
const transport = {
  send: ({ method, url, headers, body }) =>
    request(method, new URL(url).pathname, headers, undefined, body),
};

async function main() {
  port = await freePort(18480);
  pgPort = await freePort(55480);
  const secret = () => randomBytes(32).toString("base64url");
  const draftSecret = secret();
  const mediaSecret = secret();
  const runtimeEnv = {
    NEWSROOM_TEST_PORT: String(port),
    RUNTIME_DB_PASSWORD: secret(),
    RUNTIME_DB_ROOT_PASSWORD: secret(),
    ADMIN_PASSWORD: secret(),
    NEWSROOM_BRIDGE_USER_ID: "3",
    NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: "1",
    NEWSROOM_BRIDGE_HMAC_ENABLED: "1",
    NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON: JSON.stringify([
      { id: "draft-local-v1", secret: draftSecret },
    ]),
    NEWSROOM_BRIDGE_MEDIA_USER_ID: "2",
    NEWSROOM_BRIDGE_MEDIA_HMAC_ENABLED: "1",
    NEWSROOM_BRIDGE_MEDIA_SERVICE_LOCKDOWN_ENABLED: "1",
    NEWSROOM_BRIDGE_MEDIA_HMAC_KEYS_JSON: JSON.stringify([
      { id: "media-local-v1", secret: mediaSecret },
    ]),
    NEWSROOM_BRIDGE_MEDIA_MAX_BYTES: "500000",
    NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED: "0",
  };
  writeFileSync(
    envFile,
    Object.entries(runtimeEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  compose(["up", "-d", "db", "wordpress", "cli"]);
  run("docker", [
    "run",
    "--rm",
    "--detach",
    "--name",
    pgName,
    "--publish",
    `127.0.0.1:${pgPort}:5432`,
    "--env",
    "POSTGRES_USER=newsroom",
    "--env",
    "POSTGRES_PASSWORD=proof_only",
    "--env",
    "POSTGRES_DB=newsroom_test",
    "postgres:16-alpine",
  ]);
  await waitHttp(`http://127.0.0.1:${port}`);
  wp([
    "core",
    "install",
    `--url=http://127.0.0.1:${port}`,
    "--title=Draft Preparation Proof",
    "--admin_user=runtime_admin",
    `--admin_password=${runtimeEnv.ADMIN_PASSWORD}`,
    "--admin_email=admin@example.invalid",
    "--skip-email",
  ]);
  wp(["rewrite", "structure", "/%postname%/", "--hard"]);
  wp([
    "eval",
    "add_role('newsroom_media_service','Media',array('read'=>true,'upload_files'=>true)); add_role('newsroom_draft_service','Draft',array('read'=>true,'edit_posts'=>true,'assign_categories'=>true));",
  ]);
  wp([
    "user",
    "create",
    "runtime_media",
    "media@example.invalid",
    "--role=newsroom_media_service",
    `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`,
  ]);
  wp([
    "user",
    "create",
    "runtime_draft",
    "draft@example.invalid",
    "--role=newsroom_draft_service",
    `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`,
  ]);
  wp(["plugin", "activate", "newsroom-bridge"]);
  const categoryId = Number(
    wp(["term", "create", "category", "Proof", "--porcelain"]),
  );
  for (let i = 0; i < 30; i++) {
    try {
      run("docker", [
        "exec",
        pgName,
        "pg_isready",
        "-U",
        "newsroom",
        "-d",
        "newsroom_test",
      ]);
      break;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  const databaseUrl = `postgresql://newsroom:proof_only@127.0.0.1:${pgPort}/newsroom_test?schema=public`;
  run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "pnpm exec prisma migrate deploy"],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  process.env.DATABASE_URL = databaseUrl;
  const { ConfigService } = require("@nestjs/config");
  const { PrismaService } = require(
    resolve(repo, "apps/api/src/database/prisma.service.ts"),
  );
  const { DraftPreparationService } = require(
    resolve(
      repo,
      "apps/api/src/modules/draft-preparation/draft-preparation.service.ts",
    ),
  );
  const { ConversationProvisioningService } = require(resolve(repo, "apps/api/src/modules/reporter-workflow/conversation-provisioning.service.ts"));
  const { ConversationStateMachineService } = require(resolve(repo, "apps/api/src/modules/reporter-workflow/conversation-state-machine.service.ts"));
  const { InboundEventProcessingService } = require(resolve(repo, "apps/api/src/modules/reporter-workflow/inbound-event-processing.service.ts"));
  const { ReporterAuthorizationService } = require(resolve(repo, "apps/api/src/modules/reporter-workflow/reporter-authorization.service.ts"));
  const { Round6FinalisationService } = require(resolve(repo, "apps/api/src/modules/reporter-workflow/round6-finalisation.service.ts"));
  const { StoredWhatsappEventParser } = require(resolve(repo, "apps/api/src/modules/story-collection/stored-whatsapp-event.parser.ts"));
  const { StoryEventProcessor } = require(resolve(repo, "apps/api/src/modules/story-collection/story-event-processor.service.ts"));
  const { ApprovalPromptService } = require(resolve(repo, "apps/api/src/modules/whatsapp-outbound/approval-prompt.service.ts"));
  const { WordPressDraftClient } = require(
    resolve(
      repo,
      "apps/api/src/modules/wordpress-draft/wordpress-draft.client.ts",
    ),
  );
  const { WordPressMediaClient } = require(
    resolve(
      repo,
      "apps/api/src/modules/wordpress-media/wordpress-media.client.ts",
    ),
  );
  const enums = require("@prisma/client");
  const prisma = new PrismaService();
  const drafts = new WordPressDraftClient(
    {
      baseUrl: "https://runtime.wordpress.test",
      keyId: "draft-local-v1",
      secret: draftSecret,
      requestTimeoutMs: 5000,
      reconciliationAttempts: 3,
      reconciliationDelayMs: 10,
    },
    transport,
  );
  const media = new WordPressMediaClient(
    {
      baseUrl: "https://runtime.wordpress.test",
      keyId: "media-local-v1",
      secret: mediaSecret,
      requestTimeoutMs: 5000,
      reconciliationAttempts: 3,
      reconciliationDelayMs: 10,
      maxBytes: 500000,
    },
    transport,
  );
  const stored = new Map();
  const store = {
    putIfAbsent: () => Promise.resolve("CREATED"),
    head: (key) =>
      Promise.resolve(
        stored.get(key)
          ? {
              size: stored.get(key).length,
              sha256: createHash("sha256")
                .update(stored.get(key))
                .digest("hex"),
              mimeType: "image/png",
            }
          : null,
      ),
    read: (key) => Promise.resolve(stored.get(key)),
  };
  const runtimeConfig = new ConfigService({
    preview: { ttlSeconds: 86400 },
    round6: { controlCutoverAt: new Date(0) },
  });
  const service = new DraftPreparationService(
    prisma,
    runtimeConfig,
    store,
    drafts,
    media,
  );
  const stateMachine = new ConversationStateMachineService(prisma);
  const dispatched = [];
  const round6 = new Round6FinalisationService(
    prisma,
    service,
    new ApprovalPromptService(),
    { dispatchOne: (id) => { dispatched.push(id); return Promise.resolve("SENT"); } },
    stateMachine,
  );
  const inbound = new InboundEventProcessingService(
    prisma,
    new ReporterAuthorizationService(),
    new ConversationProvisioningService(),
    new StoredWhatsappEventParser(),
    new StoryEventProcessor(stateMachine),
    undefined,
    runtimeConfig,
    service,
    round6,
  );
  const category = await prisma.editorialCategory.create({
    data: {
      wordpressCategoryId: BigInt(categoryId),
      name: "Proof",
      slug: `proof-${randomUUID()}`,
      status: enums.EditorialCategoryStatus.ACTIVE,
    },
  });
  async function seed(mediaCount) {
    const reporter = await prisma.reporter.create({
      data: {
        phoneNumber: `+2637${String(Date.now()).slice(-7)}${mediaCount}`,
        displayName: "Proof",
        editorialByline: "Reporter Example",
        status: enums.ReporterStatus.ACTIVE,
      },
    });
    const story = await prisma.story.create({
      data: {
        reporterId: reporter.id,
        status: enums.StoryStatus.COLLECTING,
        headline: "Proof headline",
        body: "Proof body",
        byline: "Reporter Example",
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        reporterId: reporter.id,
        state: enums.ConversationState.COLLECTING_MEDIA,
        currentStoryId: story.id,
      },
    });
    const providerMessageId = randomUUID();
    const occurredAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const event = await prisma.inboundEvent.create({
      data: {
        provider: enums.Provider.WHATSAPP,
        providerMessageId,
        senderPhone: reporter.phoneNumber,
        senderIngestSequence: BigInt(Date.now()) + BigInt(mediaCount),
        eventType: enums.InboundEventType.TEXT,
        processingStatus: enums.InboundProcessingStatus.RECEIVED,
        receivedAt: new Date(),
        providerOccurredAt: occurredAt,
        rawPayload: {
          message: {
            id: providerMessageId,
            from: reporter.phoneNumber.slice(1),
            timestamp: String(Math.floor(occurredAt.getTime() / 1000)),
            type: "text",
            text: { body: "/done" },
          },
        },
      },
    });
    await prisma.storyCategory.create({
      data: { storyId: story.id, categoryId: category.id },
    });
    for (let position = 0; position < mediaCount; position++) {
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const row = await prisma.storyMedia.create({
        data: {
          storyId: story.id,
          providerMediaId: randomUUID(),
          mediaType: enums.StoryMediaType.IMAGE,
          status: enums.MediaProcessingStatus.FETCHED,
          mimeType: "image/png",
          fileSizeBytes: BigInt(bytes.length),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          position,
        },
      });
      stored.set(`story-media/v1/${row.id}/source`, bytes);
    }
    return { reporter, story, conversation, event };
  }
  const baselinePostCount = Number(wp(["post", "list", "--post_type=post", "--format=count"]));
  let completedPathCount = 0;
  for (const mediaCount of [0, 2]) {
    const value = await seed(mediaCount);
    const result = await inbound.process(value.event.id);
    assert(
      result.outcome === "PROCESSED",
      `full inbound saga did not complete (${result.outcome}:${result.reason ?? "none"}; ${JSON.stringify(responseStatuses.slice(-5))})`,
    );
    const final = await prisma.story.findUnique({
      where: { id: value.story.id },
      include: {
        draftPreparations: true,
        publishAttempts: true,
        outboundMessages: true,
        media: true,
        activeInConversation: true,
      },
    });
    assert(
      final.status === "AWAITING_APPROVAL" &&
        final.activeInConversation.state === "AWAITING_APPROVAL" &&
        final.draftPreparations[0].status === "READY_FOR_APPROVAL" &&
        final.outboundMessages.length === 1,
      "local posture mismatch",
    );
    assert(
      final.publishAttempts.every(
        (attempt) => attempt.status === "SUCCEEDED",
      ) && final.media.every((item) => item.status === "UPLOADED"),
      "attempt/media mismatch",
    );
    const state = await drafts.getDraftState(final.wordpressDraftKey);
    assert(
      state.status === "draft" &&
        state.title === "Proof headline" &&
        state.content === "Proof body" &&
        state.editorial_byline === "Reporter Example" &&
        state.categories.length === 1 &&
        state.categories[0] === categoryId &&
        state.author_id === 3 &&
        state.featured_media_key === (final.media[0]?.id ?? null),
      "WordPress state mismatch",
    );
    assert(
      (await prisma.approval.count({ where: { storyId: value.story.id } })) === 0 &&
        (await prisma.publishAttempt.count({ where: { storyId: value.story.id, operation: enums.PublishOperation.PUBLISH } })) === 0 &&
        final.publishAttempts.every((attempt) => attempt.operation !== "PUBLISH") &&
        dispatched.filter((id) => id === final.outboundMessages[0].id).length === 1,
      "approval/publish/fake-Meta posture mismatch",
    );
    completedPathCount += 1;
    const postCount = Number(wp(["post", "list", "--post_type=post", "--format=count"]));
    assert(postCount === baselinePostCount + completedPathCount, "unexpected WordPress post count");
    pass(
      mediaCount === 0
        ? "zero_media_full_inbound_orchestration"
        : "multi_media_full_inbound_orchestration",
      { media: mediaCount, post_id: state.post_id, post_count: postCount, status: state.status, author_id: state.author_id, category_id: state.categories[0], featured_media_key: state.featured_media_key },
    );
  }
  evidence.runtime = {
    wordpress: wp(["core", "version"]),
    php: compose(["exec", "-T", "wordpress", "php", "-r", "echo PHP_VERSION;"]),
    mariadb: compose(["exec", "-T", "db", "mariadb", "--version"]),
    postgres: run("docker", ["exec", pgName, "postgres", "--version"]),
  };
  await prisma.$disconnect();
  writeFileSync(resultFile, JSON.stringify(evidence, null, 2));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAIL ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    compose(["down", "--volumes", "--remove-orphans"]);
  } catch {}
  try {
    run("docker", ["stop", pgName]);
  } catch {}
  if (existsSync(envFile)) rmSync(envFile);
}
