import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const name = `newsroom-r8b3-${randomUUID().slice(0, 8)}`;

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
  await new Promise((ready, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", ready),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise((closed) => server.close(closed));
  return address.port;
}

try {
  const port = await freePort();
  run("docker", [
    "run", "-d", "--name", name,
    "-e", "POSTGRES_USER=proof",
    "-e", "POSTGRES_PASSWORD=proof",
    "-e", "POSTGRES_DB=newsroom",
    "-p", `127.0.0.1:${port}:5432`,
    "postgres:16-alpine",
  ], { label: "PostgreSQL startup" });
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", "proof", "-d", "newsroom"],
      { windowsHide: true },
    );
    if (ready.status === 0) break;
    if (attempt === 59) throw new Error("Disposable PostgreSQL did not start");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://proof:proof@127.0.0.1:${port}/newsroom`,
  };
  const pnpmCli = resolve(process.execPath, "../node_modules/corepack/dist/pnpm.js");
  const pnpm = (args, label) =>
    process.platform === "win32"
      ? run(process.execPath, [pnpmCli, ...args], { env, label, includeStderr: true })
      : run("pnpm", args, { env, label, includeStderr: true });
  pnpm(["exec", "prisma", "migrate", "deploy"], "fresh migrations");
  const output = pnpm([
    "--filter", "@newsroom/api", "exec", "jest",
    "--config", "test/jest-round8b3-outbound.config.ts", "--runInBand",
  ], "Round 8B.3 outbound proof");
  const version = run("docker", [
    "exec", name, "psql", "-U", "proof", "-d", "newsroom", "-Atc", "SHOW server_version",
  ]);
  process.stdout.write(`${output}\nDisposable PostgreSQL ${version} outbound authority proof passed.\n`);
} catch (error) {
  process.stderr.write(`Round 8B.3 outbound integration failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "-f", name], { cwd: root, windowsHide: true });
}
