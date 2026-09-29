import { Injectable } from "@nestjs/common";

type LoopMetric = {
  runs: number;
  errors: number;
  results: number;
  durationSeconds: number;
  lastCycleSeconds: number;
};

@Injectable()
export class WorkerMetricsService {
  private readonly loops = new Map<string, LoopMetric>();
  private readonly degradation = new Map<string, number>();

  record(loop: string, durationMs: number, results: number, error = false, degraded = false): void {
    const metric = this.loops.get(loop) ?? {
      runs: 0,
      errors: 0,
      results: 0,
      durationSeconds: 0,
      lastCycleSeconds: 0,
    };
    metric.runs++;
    metric.errors += error ? 1 : 0;
    metric.results += results;
    metric.durationSeconds += durationMs / 1000;
    metric.lastCycleSeconds = Date.now() / 1000;
    this.loops.set(loop, metric);
    if (error || degraded)
      this.degradation.set(loop, (this.degradation.get(loop) ?? 0) + 1);
  }

  lastCycle(loop: string): number {
    return this.loops.get(loop)?.lastCycleSeconds ?? 0;
  }

  render(): string {
    const lines = [
      "# TYPE newsroom_worker_loop_runs_total counter",
      "# TYPE newsroom_worker_loop_errors_total counter",
      "# TYPE newsroom_worker_loop_results_total counter",
      "# TYPE newsroom_worker_loop_duration_seconds_total counter",
      "# TYPE newsroom_worker_loop_last_cycle_timestamp_seconds gauge",
      "# TYPE newsroom_worker_dependency_degradation_total counter",
    ];
    for (const [loop, value] of [...this.loops].sort()) {
      const label = `{loop="${loop}"}`;
      lines.push(`newsroom_worker_loop_runs_total${label} ${value.runs}`);
      lines.push(`newsroom_worker_loop_errors_total${label} ${value.errors}`);
      lines.push(`newsroom_worker_loop_results_total${label} ${value.results}`);
      lines.push(`newsroom_worker_loop_duration_seconds_total${label} ${value.durationSeconds}`);
      lines.push(`newsroom_worker_loop_last_cycle_timestamp_seconds${label} ${value.lastCycleSeconds}`);
      lines.push(`newsroom_worker_dependency_degradation_total${label} ${this.degradation.get(loop) ?? 0}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
