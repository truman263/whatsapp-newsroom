import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const composeFile = resolve(root, "wordpress/runtime/draft-sync-implementation/compose.yaml");
const temp = mkdtempSync(resolve(tmpdir(), "newsroom-r7-integration-"));
const project = `newsroom-r7-${randomUUID().slice(0, 8)}`;
const pgName = `${project}-pg`;
const s3Name = `${project}-s3`;
const envFile = resolve(temp, "compose.env");
const repoEnv = resolve(root, ".env");
const isolatedEnv = resolve(root, `.env.round7-isolated-${randomUUID()}`);
const secret = () => randomBytes(32).toString("base64url");
let movedEnv = false;
let composeStarted = false;
let pgStarted = false;
let s3Started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const message = options.sensitive ? "sensitive command failed" : (result.stderr || result.stdout || result.error?.message || "command failed").trim().slice(0, 1200);
    throw new Error(`${options.label ?? command}: ${message}`);
  }
  return ((result.stdout ?? "") + (options.includeStderr ? result.stderr ?? "" : "")).trim();
}
const compose = (args, options = {}) => run("docker", ["compose", "--project-name", project, "--env-file", envFile, "--file", composeFile, ...args], options);
const wp = (args, options = {}) => compose(["exec", "-T", "cli", "wp", ...args], options);
const pnpmCli = resolve(process.execPath, "../node_modules/corepack/dist/pnpm.js");
const runPnpm = (args, options = {}) => process.platform === "win32"
  ? run(process.execPath, [pnpmCli, ...args], options)
  : run("pnpm", args, options);

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return address.port;
}

async function waitFor(url) {
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
  }
  throw new Error("Disposable WordPress did not start");
}

try {
  if (existsSync(repoEnv)) {
    renameSync(repoEnv, isolatedEnv);
    movedEnv = true;
  }
  const wpPort = await freePort();
  const pgPort = await freePort();
  const s3Port = await freePort();
  const pgPassword = secret();
  const draftSecret = secret();
  const mediaSecret = secret();
  const publishSecret = secret();
  const appSecret = secret();
  const adminPassword = secret();
  const runtime = {
    NEWSROOM_TEST_PORT: String(wpPort),
    RUNTIME_DB_PASSWORD: secret(),
    RUNTIME_DB_ROOT_PASSWORD: secret(),
    ADMIN_PASSWORD: adminPassword,
    NEWSROOM_BRIDGE_USER_ID: "3",
    NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: "1",
    NEWSROOM_BRIDGE_HMAC_ENABLED: "1",
    NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON: JSON.stringify([{ id: "round7-draft", secret: draftSecret }]),
    NEWSROOM_BRIDGE_MEDIA_USER_ID: "2",
    NEWSROOM_BRIDGE_MEDIA_HMAC_ENABLED: "1",
    NEWSROOM_BRIDGE_MEDIA_SERVICE_LOCKDOWN_ENABLED: "1",
    NEWSROOM_BRIDGE_MEDIA_HMAC_KEYS_JSON: JSON.stringify([{ id: "round7-media", secret: mediaSecret }]),
    NEWSROOM_BRIDGE_MEDIA_MAX_BYTES: "100000",
    NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED: "1",
    NEWSROOM_BRIDGE_PUBLISH_HMAC_KEYS_JSON: JSON.stringify([{ id: "round7-publish", secret: publishSecret }]),
    NEWSROOM_BRIDGE_PUBLISHER_USERS_JSON: JSON.stringify({ "round7-publish": 5 }),
  };
  writeFileSync(envFile, Object.entries(runtime).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  const dbUrl = `postgresql://newsroom:${pgPassword}@127.0.0.1:${pgPort}/newsroom_test`;
  const testEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: dbUrl,
    WORDPRESS_BASE_URL: "https://runtime.wordpress.test",
    WORDPRESS_DRAFT_HMAC_KEY_ID: "round7-draft",
    WORDPRESS_DRAFT_HMAC_SECRET: draftSecret,
    WORDPRESS_MEDIA_HMAC_KEY_ID: "round7-media",
    WORDPRESS_MEDIA_HMAC_SECRET: mediaSecret,
    WORDPRESS_PUBLISH_HMAC_KEY_ID: "round7-publish",
    WORDPRESS_PUBLISH_HMAC_SECRET: publishSecret,
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    NEWSROOM_PREVIEW_HMAC_SECRET: secret(),
    ROUND6_CONTROL_CUTOVER_AT: "2026-01-01T00:00:00.000Z",
    ROUND7_CONTROL_CUTOVER_AT: "2026-01-01T00:00:00.000Z",
    ROUND7_TEST_WORDPRESS_PORT: String(wpPort),
    ROUND7_TEST_COMPOSE_PROJECT: project,
    ROUND7_TEST_COMPOSE_ENV_FILE: envFile,
    ROUND8B2_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    NEWSROOM_MEDIA_OBJECT_STORE_DRIVER: "s3",
    NEWSROOM_MEDIA_S3_BUCKET: "proof-media",
    NEWSROOM_MEDIA_S3_REGION: "us-east-1",
    NEWSROOM_MEDIA_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    NEWSROOM_MEDIA_S3_FORCE_PATH_STYLE: "true",
    NEWSROOM_MEDIA_S3_ACCESS_KEY_ID: "proof",
    NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY: "proof-secret",
  };
  run("docker", ["run", "-d", "--name", pgName, "-e", "POSTGRES_USER=newsroom", "-e", `POSTGRES_PASSWORD=${pgPassword}`, "-e", "POSTGRES_DB=newsroom_test", "-p", `127.0.0.1:${pgPort}:5432`, "postgres:16-alpine"], { sensitive: true, label: "PostgreSQL startup" });
  pgStarted = true;
  run("docker", ["run", "-d", "--name", s3Name, "-p", `127.0.0.1:${s3Port}:4566`, "-e", "SERVICES=s3", "localstack/localstack:4.8.1"], { label: "LocalStack startup" });
  s3Started = true;
  for (let i = 0; i < 60; i++) {
    const ready = spawnSync("docker", ["exec", pgName, "pg_isready", "-U", "newsroom", "-d", "newsroom_test"], { windowsHide: true });
    if (ready.status === 0) break;
    if (i === 59) throw new Error("Disposable PostgreSQL did not start");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${s3Port}/_localstack/health`);
      const health = await response.json();
      if (["available", "running"].includes(health.services?.s3)) break;
    } catch {}
    if (i === 59) throw new Error("Disposable LocalStack did not start");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  composeStarted = true;
  compose(["up", "-d", "db", "wordpress", "cli"], { sensitive: true, label: "WordPress startup" });
  await waitFor(`http://127.0.0.1:${wpPort}/`);
  wp(["core", "install", `--url=http://127.0.0.1:${wpPort}`, "--title=Round 7 disposable integration", "--admin_user=runtime_admin", `--admin_password=${adminPassword}`, "--admin_email=admin@example.invalid", "--skip-email"], { sensitive: true, label: "WordPress installation" });
  wp(["rewrite", "structure", "/%postname%/", "--hard"]);
  wp(["eval", "add_role('newsroom_media_service','Media',array('read'=>true,'upload_files'=>true));add_role('newsroom_draft_service','Draft',array('read'=>true,'edit_posts'=>true,'assign_categories'=>true));add_role('newsroom_publish_service','Publisher',array('read'=>true,'publish_newsroom_publications'=>true));"]);
  const users = [
    ["runtime_media", "newsroom_media_service"],
    ["runtime_draft", "newsroom_draft_service"],
    ["runtime_author", "author"],
    ["runtime_publish", "newsroom_publish_service"],
  ];
  for (const [index, [name, role]] of users.entries()) {
    const id = wp(["user", "create", name, `${name}@example.invalid`, `--role=${role}`, `--user_pass=${adminPassword}`, "--porcelain"], { sensitive: true, label: "WordPress service user" });
    if (id !== String(index + 2)) throw new Error("Disposable WordPress service identity mismatch");
  }
  const categoryId = wp(["term", "create", "category", "round7-proof", "--porcelain"]);
  wp(["plugin", "activate", "newsroom-bridge"]);
  const wpVersion = wp(["core", "version"]);
  const phpVersion = compose(["exec", "-T", "wordpress", "php", "-r", "echo PHP_VERSION;"]);
  const mariaVersion = wp(["db", "query", "SELECT VERSION()", "--skip-column-names", "--silent"]);
  const pgVersion = run("docker", ["exec", pgName, "psql", "-U", "newsroom", "-d", "newsroom_test", "-Atc", "SHOW server_version"]);
  if (!wpVersion.startsWith("7.1") || !phpVersion.startsWith("8.2") || !mariaVersion.startsWith("10.11") || !pgVersion.startsWith("16.")) throw new Error("Disposable runtime version mismatch");
  testEnv.ROUND7_TEST_CATEGORY_ID = categoryId;
  runPnpm(["exec", "prisma", "migrate", "deploy"], { env: testEnv, label: "fresh migrations" });
  const repeat = runPnpm(["exec", "prisma", "migrate", "deploy"], { env: testEnv, label: "repeat migrations" });
  if (!repeat.includes("No pending migrations")) throw new Error("Repeat migration was not a no-op");
  runPnpm(["exec", "prisma", "migrate", "status"], { env: testEnv, label: "migration status" });
  const drift = runPnpm(["exec", "prisma", "migrate", "diff", "--from-url", dbUrl, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], { env: testEnv, sensitive: true, label: "schema drift" });
  if (!drift.includes("No difference detected")) throw new Error("Schema drift detected");
  const result = runPnpm(["--filter", "@newsroom/api", "exec", "jest", "--config", "test/jest-round7-integration.config.ts", "--runInBand"], { env: testEnv, label: "Round 7 combined integration", includeStderr: true });
  process.stdout.write(`${result}\n`);
  process.stdout.write(`Disposable PostgreSQL ${pgVersion} / WordPress ${wpVersion} / PHP ${phpVersion} / MariaDB ${mariaVersion} integration passed.\n`);
} catch (error) {
  process.stderr.write(`Round 7 integration failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (composeStarted) {
    try { compose(["down", "-v", "--remove-orphans"], { sensitive: true, label: "WordPress cleanup" }); }
    catch { process.stderr.write("WordPress cleanup failed; inspect isolated project.\n"); process.exitCode = 1; }
  }
  if (pgStarted) {
    spawnSync("docker", ["stop", pgName], { windowsHide: true });
    spawnSync("docker", ["rm", pgName], { windowsHide: true });
  }
  if (s3Started) {
    spawnSync("docker", ["stop", s3Name], { windowsHide: true });
    spawnSync("docker", ["rm", s3Name], { windowsHide: true });
  }
  if (movedEnv) renameSync(isolatedEnv, repoEnv);
  rmSync(temp, { recursive: true, force: true });
}
