import { Controller, Get, Header, ServiceUnavailableException } from "@nestjs/common";
import { WorkerMetricsService } from "./worker-metrics.service";
import { WorkerOrchestratorService } from "./worker-orchestrator.service";
import { BacklogMetricsService } from "./backlog-metrics.service";

@Controller()
export class WorkerOperationalController {
  constructor(
    private readonly orchestrator: WorkerOrchestratorService,
    private readonly metrics: WorkerMetricsService,
    private readonly backlog: BacklogMetricsService,
  ) {}

  @Get("health/live") live(): object { return { status: "ok", service: "newsroom-worker" }; }

  @Get("health/ready") async ready(): Promise<object> {
    if (!(await this.orchestrator.isReady()))
      throw new ServiceUnavailableException({ status: "not_ready", service: "newsroom-worker", reason: "scheduler_or_database" });
    return { status: "ok", service: "newsroom-worker" };
  }

  @Get("metrics") @Header("Content-Type", "text/plain; version=0.0.4") async metricsText(): Promise<string> {
    return `${this.metrics.render()}${await this.backlog.render()}`;
  }
}
