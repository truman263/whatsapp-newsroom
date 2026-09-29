import { BeforeApplicationShutdown, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApplicationConfiguration } from "../config/configuration";
import { PrismaService } from "../database/prisma.service";
import { DraftRecoveryService } from "../modules/draft-preparation/draft-recovery.service";
import { MediaRecoveryService } from "../modules/media-staging/media-recovery.service";
import { PublishAttemptDriverService } from "../modules/publishing/publish-attempt-driver.service";
import { InboundEventDriverService } from "../modules/reporter-workflow/inbound-event-driver.service";
import { WhatsappOutboundDispatcher } from "../modules/whatsapp-outbound/whatsapp-outbound.dispatcher";
import { WorkerMetricsService } from "./worker-metrics.service";

export const WORKER_LOOPS = [
  "inbound", "staleInbound", "media", "draft", "outbound", "staleOutbound", "publish",
] as const;
type LoopName = (typeof WORKER_LOOPS)[number];

export function workerDelay(
  cadenceMs: number,
  failures: number,
  backoffMaxMs: number,
  jitterPercent: number,
  random: number,
): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 52);
  const failureBase = Math.min(backoffMaxMs, cadenceMs * 2 ** exponent);
  if (failures > 0)
    return Math.round(Math.max(0, Math.min(1, random)) * failureBase);
  const base = cadenceMs;
  const spread = base * jitterPercent / 100;
  const jittered = Math.max(0, Math.round(base - spread + random * spread * 2));
  return jittered;
}

@Injectable()
export class WorkerOrchestratorService implements BeforeApplicationShutdown {
  private stopping = false;
  private started = false;
  private readonly timers = new Map<LoopName, NodeJS.Timeout>();
  private readonly failures = new Map<LoopName, number>();
  private readonly degraded = new Set<LoopName>();
  private readonly active = new Set<Promise<void>>();
  private readonly worker: ApplicationConfiguration["worker"];

  constructor(
    private readonly inbound: InboundEventDriverService,
    private readonly media: MediaRecoveryService,
    private readonly drafts: DraftRecoveryService,
    private readonly outbound: WhatsappOutboundDispatcher,
    private readonly publish: PublishAttemptDriverService,
    private readonly prisma: PrismaService,
    private readonly metrics: WorkerMetricsService,
    config: ConfigService<ApplicationConfiguration, true>,
  ) {
    this.worker = config.get("worker", { infer: true });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const loop of WORKER_LOOPS) this.schedule(loop, 0);
  }

  async runOnce(loop: LoopName): Promise<number> {
    const batch = this.worker.batchSize;
    switch (loop) {
      case "inbound": return this.count(loop, await this.inbound.processReceived(batch));
      case "staleInbound": return this.count(loop, await this.inbound.recoverStaleProcessing({ limit: batch, staleBefore: new Date(Date.now() - this.worker.staleInboundMs), maxAttempts: this.worker.inboundMaxAttempts }));
      case "media": return this.count(loop, await this.media.recoverPending(batch));
      case "draft": return this.count(loop, await this.drafts.recover(batch));
      case "outbound": return this.count(loop, await this.outbound.dispatchPending(batch));
      case "staleOutbound": return this.count(loop, await this.outbound.recoverStaleSending(new Date(Date.now() - this.worker.staleOutboundMs), batch));
      case "publish": return this.count(loop, await this.publish.runOnce(batch));
    }
  }

  private count(loop: LoopName, results: ReadonlyArray<unknown>): number {
    if (results.some((result) =>
      result !== null && typeof result === "object" && "outcome" in result &&
      result.outcome === "RETRY_REQUIRED"))
      this.degraded.add(loop);
    return results.length;
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  isLive(): boolean { return true; }

  async isReady(): Promise<boolean> {
    if (!this.started || this.stopping) return false;
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { return false; }
    const oldestAllowed = Date.now() / 1000 - this.worker.readinessSilenceMs / 1000;
    return WORKER_LOOPS.every((loop) => this.metrics.lastCycle(loop) >= oldestAllowed);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stop();
    if (this.active.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise<void>((resolve) => setTimeout(resolve, this.worker.shutdownGraceMs)),
    ]);
  }

  private schedule(loop: LoopName, delay: number): void {
    if (this.stopping) return;
    const timer = setTimeout(() => {
      const cycle = this.cycle(loop);
      this.active.add(cycle);
      void cycle.finally(() => this.active.delete(cycle));
    }, delay);
    timer.unref();
    this.timers.set(loop, timer);
  }

  private async cycle(loop: LoopName): Promise<void> {
    if (this.stopping) return;
    const started = Date.now();
    this.degraded.delete(loop);
    let results = 0;
    let failed = false;
    try {
      results = await this.runOnce(loop);
      this.failures.set(loop, 0);
    } catch {
      failed = true;
      this.failures.set(loop, (this.failures.get(loop) ?? 0) + 1);
    } finally {
      this.metrics.record(loop, Date.now() - started, results, failed, this.degraded.delete(loop));
      const cadence = this.worker.cadencesMs[loop]!;
      const delay = workerDelay(
        cadence,
        this.failures.get(loop) ?? 0,
        this.worker.backoffMaxMs,
        this.worker.jitterPercent,
        Math.random(),
      );
      this.schedule(loop, delay);
    }
  }
}
