import { ConsoleLogger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { ApplicationConfiguration } from "./config/configuration";
import { WorkerModule } from "./worker/worker.module";
import { WorkerOrchestratorService } from "./worker/worker-orchestrator.service";
import { validateWorkerEnvironment } from "./config/env.schema";

export async function bootstrapWorker(
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  validateWorkerEnvironment(source);
  const app = await NestFactory.create(WorkerModule, {
    logger: new ConsoleLogger("newsroom-worker", { json: true, colors: false }),
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<ApplicationConfiguration, true>);
  app.get(WorkerOrchestratorService).start();
  await app.listen(config.get("worker.port", { infer: true }), "0.0.0.0");
}

if (require.main === module)
  void bootstrapWorker().catch(() => { process.exitCode = 1; });
