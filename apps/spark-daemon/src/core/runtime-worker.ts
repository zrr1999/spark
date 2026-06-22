/** Poll/wake runtime worker loop for the Spark daemon core. */

import { setTimeout as delay } from "node:timers/promises";

import { SparkDaemonQueue } from "./queue.ts";
import {
  DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY,
  DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT,
  createSparkDaemonActiveTasks,
  defaultSparkDaemonTaskExecutor,
  processSparkDaemonQueueBatch,
} from "./queue-worker.ts";
import type { SparkDaemonPathOptions } from "./paths.ts";
import type { SparkDaemonActiveTasks, SparkDaemonTaskExecutor } from "./types.ts";

const DEFAULT_IDLE_POLL_INTERVAL_MS = 250;

export interface SparkDaemonWorkerContext {
  queue: SparkDaemonQueue;
  active: SparkDaemonActiveTasks;
  executeTask: SparkDaemonTaskExecutor;
}

export interface CreateSparkDaemonWorkerContextOptions extends SparkDaemonPathOptions {
  queue?: SparkDaemonQueue;
  active?: SparkDaemonActiveTasks;
  executeTask?: SparkDaemonTaskExecutor;
}

export interface SparkDaemonWorkerLoopOptions {
  context: SparkDaemonWorkerContext;
  label?: string;
  limit?: number;
  concurrency?: number;
  pollIntervalMs?: number;
  isStopped?: () => boolean;
}

export function createSparkDaemonWorkerContext(
  options: CreateSparkDaemonWorkerContextOptions = {},
): SparkDaemonWorkerContext {
  return {
    queue: options.queue ?? new SparkDaemonQueue(options),
    active: options.active ?? createSparkDaemonActiveTasks(),
    executeTask: options.executeTask ?? defaultSparkDaemonTaskExecutor,
  };
}

export async function runSparkDaemonWorkerIteration(
  options: Omit<SparkDaemonWorkerLoopOptions, "pollIntervalMs" | "isStopped">,
): Promise<boolean> {
  return await processSparkDaemonQueueBatch({
    queue: options.context.queue,
    active: options.context.active,
    executeTask: options.context.executeTask,
    label: options.label,
    limit: options.limit,
    concurrency: options.concurrency,
  });
}

export class SparkDaemonWorkerLoop {
  private readonly context: SparkDaemonWorkerContext;
  private readonly label: string;
  private readonly limit: number;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly isStopped?: () => boolean;
  private stopRequested = false;
  private wakeResolver: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(options: SparkDaemonWorkerLoopOptions) {
    this.context = options.context;
    this.label = options.label ?? "spark-daemon";
    this.limit = options.limit ?? DEFAULT_SPARK_DAEMON_QUEUE_LAUNCH_LIMIT;
    this.concurrency = options.concurrency ?? DEFAULT_SPARK_DAEMON_QUEUE_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
    this.isStopped = options.isStopped;
  }

  async start(): Promise<void> {
    if (this.loopPromise) return;
    await this.context.queue.init();
    this.loopPromise = this.runLoop();
  }

  wake(): void {
    const resolve = this.wakeResolver;
    this.wakeResolver = null;
    resolve?.();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake();
    await this.wait();
  }

  async wait(): Promise<void> {
    await this.loopPromise;
  }

  private async waitForWake(): Promise<void> {
    await Promise.race([
      delay(this.pollIntervalMs),
      new Promise<void>((resolve) => {
        this.wakeResolver = resolve;
      }),
    ]);
    this.wakeResolver = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested && !this.isStopped?.()) {
      const didWork = await runSparkDaemonWorkerIteration({
        context: this.context,
        label: this.label,
        limit: this.limit,
        concurrency: this.concurrency,
      });
      if (!didWork) await this.waitForWake();
    }
  }
}

export async function runSparkDaemonWorkerLoop(
  options: SparkDaemonWorkerLoopOptions,
): Promise<void> {
  const loop = new SparkDaemonWorkerLoop(options);
  await loop.start();
  await loop.wait();
}
