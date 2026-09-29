import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const name = `newsroom-r8b5-${randomUUID().slice(0, 8)}`;
const plansOnly = process.argv.includes("--plans-only");
const capacityOnly = process.argv.includes("--capacity-only");
const mediaOnly = process.argv.includes("--media-only");
const baselineOnly = process.argv.includes("--baseline-only");
const queryPlanOnly = process.argv.includes("--query-plan-only");
const privacyOnly = process.argv.includes("--privacy-only");
const processingAgeOnly = process.argv.includes("--processing-age-only");
const focusedOnly = process.argv.includes("--focused-only") || plansOnly || capacityOnly || mediaOnly || baselineOnly || queryPlanOnly || privacyOnly || processingAgeOnly;
const withS3 = !plansOnly && !capacityOnly && !baselineOnly && !queryPlanOnly && !privacyOnly && !processingAgeOnly;
const s3Name = `${name}-s3`;
const disposableHost = (value) => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".test")
    );
  } catch {
    return false;
  }
};
for (const key of [
  "WORDPRESS_BASE_URL",
  "NEWSROOM_MEDIA_S3_ENDPOINT",
  "NEWSROOM_PREVIEW_PUBLIC_ORIGIN",
]) {
  if (process.env[key] && !disposableHost(process.env[key]))
    throw new Error(`Round 8B.5 refuses non-disposable ${key}`);
}
for (const key of ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"]) {
  if (process.env[key] && !disposableHost(process.env[key]))
    throw new Error(`Round 8B.5 refuses non-disposable ${key}`);
}
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const failure = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
    throw new Error((failure || "failed").slice(-12000));
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
};
const server = createServer();
await new Promise((resolveReady, reject) =>
  server.once("error", reject).listen(0, "127.0.0.1", resolveReady),
);
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("port allocation failed");
await new Promise((resolveClose) => server.close(resolveClose));
const port = address.port;
let s3Port;
let runCrossServiceContention = false;
async function startS3() {
  run("docker", [
    "run", "-d", "--name", s3Name,
    "-p", `127.0.0.1:${s3Port}:4566`,
    "-e", "SERVICES=s3", "localstack/localstack:4.8.1",
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${s3Port}/_localstack/health`);
      const health = await response.json();
      if (["available", "running"].includes(health.services?.s3)) return;
    } catch {
      // Local disposable service has not started yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error("LocalStack S3 timeout");
}
if (withS3) {
  const s3Server = createServer();
  await new Promise((resolveReady, reject) =>
    s3Server.once("error", reject).listen(0, "127.0.0.1", resolveReady),
  );
  const s3Address = s3Server.address();
  if (!s3Address || typeof s3Address === "string")
    throw new Error("S3 port allocation failed");
  s3Port = s3Address.port;
  await new Promise((resolveClose) => s3Server.close(resolveClose));
}
try {
  run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_USER=proof",
    "-e",
    "POSTGRES_PASSWORD=proof",
    "-e",
    "POSTGRES_DB=newsroom",
    "-p",
    `127.0.0.1:${port}:5432`,
    "postgres:16-alpine",
  ]);
  if (withS3 && focusedOnly) await startS3();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      spawnSync(
        "docker",
        ["exec", name, "pg_isready", "-U", "proof", "-d", "newsroom"],
        { windowsHide: true },
      ).status === 0
    )
      break;
    if (attempt === 59) throw new Error("PostgreSQL timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  const env = {
    ...process.env,
    NODE_ENV: "test",
    WHATSAPP_ACCESS_TOKEN: "round8b5-disposable-token",
    WHATSAPP_APP_SECRET: "round8b5-local-secret",
    WHATSAPP_VERIFY_TOKEN: "round8b5-disposable-verify",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WORDPRESS_BASE_URL: "https://wordpress.test",
    NEWSROOM_MEDIA_OBJECT_STORE_DRIVER: "unconfigured",
    NEWSROOM_PREVIEW_PUBLIC_ORIGIN: "https://newsroom.test",
    NEWSROOM_MEDIA_S3_ENDPOINT: undefined,
    NEWSROOM_MEDIA_S3_ACCESS_KEY_ID: undefined,
    NEWSROOM_MEDIA_S3_SECRET_ACCESS_KEY: undefined,
    NEWSROOM_MEDIA_S3_SESSION_TOKEN: undefined,
    DATABASE_URL: `postgresql://proof:proof@127.0.0.1:${port}/newsroom?connection_limit=1&pool_timeout=10`,
    ROUND8B5_DATABASE_PORT: String(port),
    ROUND8B5_S3_ENDPOINT: withS3 ? `http://127.0.0.1:${s3Port}` : undefined,
  };
  const cli = resolve(
    process.execPath,
    "../node_modules/corepack/dist/pnpm.js",
  );
  const pnpm = (args) =>
    process.platform === "win32"
      ? run(process.execPath, [cli, ...args], env)
      : run("pnpm", args, env);
  pnpm(["exec", "prisma", "migrate", "deploy"]);
  const jestPath = (path) => pnpm([
    "--filter", "@newsroom/api", "exec", "jest",
    "--config", "test/jest-round8b5-hardening.config.ts",
    "--runInBand", "--runTestsByPath", path,
  ]);
  let output;
  if (focusedOnly) {
    output = plansOnly
      ? jestPath("test/round8b5a-plans.integration-spec.ts")
      : queryPlanOnly
        ? pnpm(["--filter", "@newsroom/api", "exec", "jest", "--config", "test/jest-round8b5-hardening.config.ts", "--runInBand", "--runTestsByPath", "test/round8b5-hardening.integration-spec.ts", "--testNamePattern", "measures bounded worker and backlog plans at ten-thousand-row scale"])
      : privacyOnly
        ? pnpm(["--filter", "@newsroom/api", "exec", "jest", "--config", "test/jest-round8b5-hardening.config.ts", "--runInBand", "--runTestsByPath", "test/round8b5-hardening.integration-spec.ts", "--testNamePattern", "contains privacy sentinels"])
      : processingAgeOnly
        ? pnpm(["--filter", "@newsroom/api", "exec", "jest", "--config", "test/jest-round8b5-hardening.config.ts", "--runInBand", "--runTestsByPath", "test/round8b5-hardening.integration-spec.ts", "--testNamePattern", "uses processingStartedAt rather than receivedAt"])
      : capacityOnly
        ? jestPath("test/round8b5a-capacity.integration-spec.ts")
        : mediaOnly
          ? jestPath("test/round8b5a-media.integration-spec.ts")
          : baselineOnly
            ? jestPath("test/round8b5-hardening.integration-spec.ts")
            : pnpm(["--filter", "@newsroom/api", "exec", "jest", "--config", "test/jest-round8b5-hardening.config.ts", "--runInBand"]);
  } else {
    const outputs = [
      jestPath("test/round8b5-hardening.integration-spec.ts"),
      jestPath("test/round8b5a-capacity.integration-spec.ts"),
      jestPath("test/round8b5a-plans.integration-spec.ts"),
    ];
    await startS3();
    outputs.push(jestPath("test/round8b5a-media.integration-spec.ts"));
    output = outputs.join("\n");
  }
  if (focusedOnly) {
    process.stdout.write(
      `${output}\nDisposable PostgreSQL focused proof passed.\n`,
    );
    process.exitCode = 0;
  } else {
    if (withS3) run("docker", ["stop", s3Name]);
    const databaseEnv = {
      ...env,
      DATABASE_URL: `postgresql://proof:proof@127.0.0.1:${port}/newsroom?connection_limit=4&pool_timeout=10`,
    };
    const databaseOutput =
      process.platform === "win32"
        ? run(process.execPath, [cli, "test:db"], databaseEnv)
        : run("pnpm", ["test:db"], databaseEnv);
    const repeatDeploy = pnpm(["exec", "prisma", "migrate", "deploy"]);
    const migrationStatus = pnpm(["exec", "prisma", "migrate", "status"]);
    run("docker", ["exec", name, "createdb", "-U", "proof", "newsroom_shadow"]);
    const drift = pnpm([
      "exec",
      "prisma",
      "migrate",
      "diff",
      "--from-migrations",
      "prisma/migrations",
      "--to-url",
      env.DATABASE_URL,
      "--shadow-database-url",
      `postgresql://proof:proof@127.0.0.1:${port}/newsroom_shadow`,
      "--exit-code",
    ]);
    const version = run("docker", [
      "exec",
      name,
      "psql",
      "-U",
      "proof",
      "-d",
      "newsroom",
      "-Atc",
      "SHOW server_version",
    ]);
    const databaseSummary =
      databaseOutput.match(
        /Test Suites:[^\r\n]*[\s\S]*?Ran all test suites\./,
      )?.[0] ?? databaseOutput;
    process.stdout.write(
      `${output}\n${databaseSummary}\n${repeatDeploy}\n${migrationStatus}\n${drift}\nDisposable PostgreSQL ${version}; connection_limit=1 hardening and DB regression passed; migration drift zero.\n`,
    );
    runCrossServiceContention = true;
  }
} catch (error) {
  process.stderr.write(`Round 8B.5 hardening proof failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (withS3) spawnSync("docker", ["rm", "-f", s3Name], { windowsHide: true });
  spawnSync("docker", ["rm", "-f", name], { windowsHide: true });
}
if (runCrossServiceContention) {
  try {
    const proofEnv = { ...process.env, ROUND8B5A_CONTENTION_PROOF: "1", ROUND8B5B_FAULT_PROOF: "1" };
    const cli = resolve(process.execPath, "../node_modules/corepack/dist/pnpm.js");
    for (const suite of ["test:round7-integration", "test:round8b3-outbound", "test:round8b4-worker"]) {
      const output = process.platform === "win32"
        ? run(process.execPath, [cli, suite], proofEnv)
        : run("pnpm", [suite], proofEnv);
      process.stdout.write(`${suite}\n${output}\n`);
    }
  } catch (error) {
    process.stderr.write(`Round 8B.5A cross-service contention failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
