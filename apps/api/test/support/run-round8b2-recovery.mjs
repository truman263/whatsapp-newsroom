import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const runner = resolve(import.meta.dirname, "run-round7-integration.mjs");
const result = spawnSync(process.execPath, [runner], {
  cwd: resolve(import.meta.dirname, "../../../.."),
  env: { ...process.env, ROUND8B2_RECOVERY_PROOF: "1" },
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
