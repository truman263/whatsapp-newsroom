import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const name = `newsroom-r8b2-s3-${randomUUID().slice(0, 8)}`;
let started = false;

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

try {
  const port = await freePort();
  run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:4566`,
      "-e",
      "SERVICES=s3",
      "localstack/localstack:4.8.1",
    ],
    { label: "LocalStack startup" },
  );
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/_localstack/health`,
        { signal: AbortSignal.timeout(2000) },
      );
      const health = await response.json();
      if (["available", "running"].includes(health.services?.s3)) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (!ready) throw new Error("Disposable LocalStack S3 did not start");
  const env = {
    ...process.env,
    ROUND8B2_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    ROUND8B2_S3_BUCKET: "proof-media",
  };
  const pnpmCli = resolve(
    process.execPath,
    "../node_modules/corepack/dist/pnpm.js",
  );
  const output =
    process.platform === "win32"
      ? run(
          process.execPath,
          [
            pnpmCli,
            "--filter",
            "@newsroom/api",
            "exec",
            "jest",
            "--config",
            "test/jest-round8b2-s3.config.ts",
            "--runInBand",
          ],
          { env, includeStderr: true, label: "Round 8B.2 S3 integration" },
        )
      : run(
          "pnpm",
          [
            "--filter",
            "@newsroom/api",
            "exec",
            "jest",
            "--config",
            "test/jest-round8b2-s3.config.ts",
            "--runInBand",
          ],
          { env, includeStderr: true, label: "Round 8B.2 S3 integration" },
        );
  process.stdout.write(
    `${output}\nDisposable LocalStack 4.8.1 S3 integration passed.\n`,
  );
} catch (error) {
  process.stderr.write(`Round 8B.2 S3 integration failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (started)
    spawnSync("docker", ["rm", "-f", name], { cwd: root, windowsHide: true });
}
