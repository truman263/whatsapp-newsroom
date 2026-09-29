import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { bootstrapWorker } from "../worker";
import { WorkerMetricsService } from "./worker-metrics.service";
import { WORKER_LOOPS, WorkerOrchestratorService, workerDelay } from "./worker-orchestrator.service";

describe("WorkerOrchestratorService", () => {
  const config = new ConfigService({
    worker: {
      batchSize: 7,
      cadencesMs: Object.fromEntries(WORKER_LOOPS.map((loop) => [loop, 100])),
      staleInboundMs: 1000,
      staleOutboundMs: 2000,
      inboundMaxAttempts: 5,
      backoffMaxMs: 1000,
      jitterPercent: 0,
      shutdownGraceMs: 1000,
      readinessSilenceMs: 60000,
    },
  });

  it("registers exactly seven bounded delegating loops", async () => {
    const inbound = { processReceived: jest.fn().mockResolvedValue([1]), recoverStaleProcessing: jest.fn().mockResolvedValue([1]) };
    const media = { recoverPending: jest.fn().mockResolvedValue([1]) };
    const drafts = { recover: jest.fn().mockResolvedValue([1]) };
    const outbound = { dispatchPending: jest.fn().mockResolvedValue([1]), recoverStaleSending: jest.fn().mockResolvedValue([1]) };
    const publish = { runOnce: jest.fn().mockResolvedValue([1]) };
    const service = new WorkerOrchestratorService(inbound as never, media as never, drafts as never, outbound as never, publish as never, { $queryRaw: jest.fn().mockResolvedValue([{ one: 1 }]) } as never, new WorkerMetricsService(), config as never);
    expect(WORKER_LOOPS).toHaveLength(7);
    for (const loop of WORKER_LOOPS) await expect(service.runOnce(loop)).resolves.toBe(1);
    expect(inbound.processReceived).toHaveBeenCalledWith(7);
    expect(media.recoverPending).toHaveBeenCalledWith(7);
    expect(drafts.recover).toHaveBeenCalledWith(7);
    expect(outbound.dispatchPending).toHaveBeenCalledWith(7);
    expect(publish.runOnce).toHaveBeenCalledWith(7);
  });

  it("does not create or start the worker when strict configuration fails", async () => {
    const create = jest.spyOn(NestFactory, "create");
    await expect(bootstrapWorker({
      NODE_ENV: "test",
      WORKER_INBOUND_MAX_ATTEMPTS: "1",
    })).rejects.toThrow(
      "Environment validation failed",
    );
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it("stops scheduling without rewriting durable state", () => {
    jest.useFakeTimers();
    const service = new WorkerOrchestratorService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, new WorkerMetricsService(), config as never);
    service.start();
    expect(jest.getTimerCount()).toBe(7);
    service.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("keeps metric labels fixed and content-free", () => {
    const metrics = new WorkerMetricsService();
    metrics.record("publish", 10, 2, true);
    const text = metrics.render();
    expect(text).toContain('loop="publish"');
    expect(text).not.toMatch(/phone|storyId|token|headline|providerMessageId/);
  });

  it("counts a handled retry as degradation without counting it as a loop exception", async () => {
    jest.useFakeTimers();
    const metrics = new WorkerMetricsService();
    const service = new WorkerOrchestratorService(
      { processReceived: jest.fn().mockResolvedValue([]), recoverStaleProcessing: jest.fn().mockResolvedValue([]) } as never,
      { recoverPending: jest.fn().mockResolvedValue([{ outcome: "RETRY_REQUIRED", reason: "MEDIA_OBJECT_UNAVAILABLE" }]) } as never,
      { recover: jest.fn().mockResolvedValue([]) } as never,
      { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) } as never,
      { runOnce: jest.fn().mockResolvedValue([]) } as never,
      { $queryRaw: jest.fn().mockResolvedValue([{ one: 1 }]) } as never,
      metrics,
      config as never,
    );
    try {
      service.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(metrics.render()).toContain('newsroom_worker_dependency_degradation_total{loop="media"} 1');
      expect(metrics.render()).toContain('newsroom_worker_loop_errors_total{loop="media"} 0');
    } finally {
      service.stop();
      jest.useRealTimers();
    }
  });

  it("calculates bounded failure backoff and resets after success", () => {
    expect(workerDelay(100, 2, 1000, 10, 0)).toBe(0);
    expect(workerDelay(100, 2, 1000, 10, 0.5)).toBe(100);
    expect(workerDelay(100, 2, 1000, 10, 1)).toBe(200);
    expect(workerDelay(100, Number.MAX_SAFE_INTEGER, 1000, 10, 1)).toBe(1000);
    expect(workerDelay(900, 2, 1000, 50, 1)).toBe(1000);
    expect(workerDelay(100, 0, 1000, 0, 0.5)).toBe(100);
    expect(workerDelay(100, 0, 1000, 10, 0)).toBe(90);
    expect(workerDelay(100, 0, 1000, 10, 1)).toBe(110);
  });

  it("isolates an actual scheduled failure and keeps other loops scheduling", async () => {
    jest.useFakeTimers();
    const metrics = new WorkerMetricsService();
    const inbound = {
      processReceived: jest.fn().mockRejectedValue(new Error("dependency")),
      recoverStaleProcessing: jest.fn().mockResolvedValue([]),
    };
    const service = new WorkerOrchestratorService(
      inbound as never,
      { recoverPending: jest.fn().mockResolvedValue([]) } as never,
      { recover: jest.fn().mockResolvedValue([]) } as never,
      { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) } as never,
      { runOnce: jest.fn().mockResolvedValue([]) } as never,
      { $queryRaw: jest.fn().mockResolvedValue([{ one: 1 }]) } as never,
      metrics,
      config as never,
    );
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(inbound.processReceived).toHaveBeenCalledTimes(1);
    expect(inbound.recoverStaleProcessing).toHaveBeenCalledTimes(1);
    expect(metrics.render()).toContain('newsroom_worker_loop_errors_total{loop="inbound"} 1');
    expect(jest.getTimerCount()).toBe(7);
    expect(service.isLive()).toBe(true);
    await expect(service.isReady()).resolves.toBe(true);
    service.stop();
    jest.useRealTimers();
  });

  it("drains an active cycle and starts no new cycle after shutdown", async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    const inbound = {
      processReceived: jest.fn().mockImplementation(() => active.then(() => [])),
      recoverStaleProcessing: jest.fn().mockResolvedValue([]),
    };
    const service = new WorkerOrchestratorService(
      inbound as never,
      { recoverPending: jest.fn().mockResolvedValue([]) } as never,
      { recover: jest.fn().mockResolvedValue([]) } as never,
      { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) } as never,
      { runOnce: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      new WorkerMetricsService(),
      config as never,
    );
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    const shutdown = service.beforeApplicationShutdown();
    let completed = false;
    void shutdown.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    release();
    await shutdown;
    await jest.advanceTimersByTimeAsync(5000);
    expect(inbound.processReceived).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("honors shutdown grace when active work does not complete", async () => {
    jest.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const service = new WorkerOrchestratorService(
      { processReceived: jest.fn().mockReturnValue(never), recoverStaleProcessing: jest.fn().mockResolvedValue([]) } as never,
      { recoverPending: jest.fn().mockResolvedValue([]) } as never,
      { recover: jest.fn().mockResolvedValue([]) } as never,
      { dispatchPending: jest.fn().mockResolvedValue([]), recoverStaleSending: jest.fn().mockResolvedValue([]) } as never,
      { runOnce: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      new WorkerMetricsService(),
      config as never,
    );
    service.start();
    await jest.advanceTimersByTimeAsync(0);
    const shutdown = service.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(shutdown).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
