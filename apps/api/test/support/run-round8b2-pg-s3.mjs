import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const suffix = randomUUID().slice(0, 8);
const pgName = `newsroom-r8b2-pg-${suffix}`;
const s3Name = `newsroom-r8b2-s3-${suffix}`;
const started = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${options.label ?? command}: ${(result.stderr || result.stdout || result.error?.message || "command failed").trim().slice(0, 1600)}`,
    );
  return `${result.stdout ?? ""}${options.includeStderr ? (result.stderr ?? "") : ""}`.trim();
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolveReady),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port");
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return address.port;
}
async function waitFor(check, label) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`${label} did not start`);
}
try {
  const pgPort = await freePort();
  const s3Port = await freePort();
  run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      pgName,
      "-e",
      "POSTGRES_USER=proof",
      "-e",
      "POSTGRES_PASSWORD=proof",
      "-e",
      "POSTGRES_DB=newsroom",
      "-p",
      `127.0.0.1:${pgPort}:5432`,
      "postgres:16-alpine",
    ],
    { label: "PostgreSQL startup" },
  );
  started.push(pgName);
  run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      s3Name,
      "-p",
      `127.0.0.1:${s3Port}:4566`,
      "-e",
      "SERVICES=s3",
      "localstack/localstack:4.8.1",
    ],
    { label: "LocalStack startup" },
  );
  started.push(s3Name);
  await waitFor(async () => {
    const result = spawnSync(
      "docker",
      ["exec", pgName, "pg_isready", "-U", "proof", "-d", "newsroom"],
      { windowsHide: true },
    );
    return result.status === 0;
  }, "PostgreSQL");
  await waitFor(async () => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${s3Port}/_localstack/health`,
      );
      const health = await response.json();
      return ["available", "running"].includes(health.services?.s3);
    } catch {
      return false;
    }
  }, "LocalStack S3");
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://proof:proof@127.0.0.1:${pgPort}/newsroom`,
    ROUND8B2_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    ROUND8B2_S3_BUCKET: "proof-media",
  };
  const pnpmCli = resolve(
    process.execPath,
    "../node_modules/corepack/dist/pnpm.js",
  );
  const invoke = (args, label) =>
    process.platform === "win32"
      ? run(process.execPath, [pnpmCli, ...args], {
          env,
          includeStderr: true,
          label,
        })
      : run("pnpm", args, { env, includeStderr: true, label });
  invoke(["exec", "prisma", "migrate", "deploy"], "fresh migrations");
  const output = invoke(
    [
      "--filter",
      "@newsroom/api",
      "exec",
      "jest",
      "--config",
      "test/jest-round8b2-pg-s3.config.ts",
      "--runInBand",
    ],
    "Round 8B.2 PostgreSQL/S3 generation proof",
  );
  process.stdout.write(
    `${output}\nDisposable PostgreSQL 16 + LocalStack 4.8.1 generation proof passed.\n`,
  );
} catch (error) {
  process.stderr.write(
    `Round 8B.2 PostgreSQL/S3 integration failed: ${error.message}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const name of started.reverse())
    spawnSync("docker", ["rm", "-f", name], { cwd: root, windowsHide: true });
}
