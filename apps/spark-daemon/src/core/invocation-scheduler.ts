import { setTimeout as delay } from "node:timers/promises";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkDaemonEvent,
  parseSparkViewModelEvent,
  type SparkDaemonEvent,
  type SparkJsonObject,
} from "@zendev-lab/spark-protocol";
import {
  SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
  SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
  SparkInvocationStore,
  type CompleteSparkInvocationInput,
  type SparkInvocationEvent,
  type SparkInvocationRecord,
} from "../store/invocations.ts";
import {
  getSparkDaemonTaskSessionId,
  validateSparkDaemonTask,
  type SparkDaemonTask,
  type SparkDaemonTaskExecutor,
} from "./types.ts";

export const DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY = 4;
/**
 * Daemon turns are durable background work, so their default lifetime is
 * bounded by explicit cancellation rather than an arbitrary wall-clock
 * deadline. A positive `taskTimeoutMs` remains available to callers that need
 * a finite execution budget; zero disables the timer.
 */
export const DEFAULT_INVOCATION_TASK_TIMEOUT_MS = 0;
export const DEFAULT_INVOCATION_ABORT_DRAIN_MS = 1_000;
const MAX_BLOCKING_QUESTION_OVERFLOW = 1;

interface ActiveInvocation {
  invocation: SparkInvocationRecord;
  controller: AbortController;
  settled: Promise<void>;
}

export interface SparkInvocationSchedulerOptions {
  store: SparkInvocationStore;
  executeTask: SparkDaemonTaskExecutor;
  /**
   * Optional daemon-owned terminal commit. Production uses this to commit the
   * invocation outcome and its channel-delivery intent in one SQLite
   * transaction; the core scheduler otherwise completes the invocation
   * directly.
   */
  completeInvocation?: (
    invocation: SparkInvocationRecord,
    task: SparkDaemonTask,
    completion: CompleteSparkInvocationInput,
  ) => SparkInvocationRecord;
  emitEvent?: (event: SparkInvocationEvent) => void | Promise<void>;
  workerId?: string;
  concurrency?: number;
  taskTimeoutMs?: number;
  /** @deprecated Executors now drain to actual settlement after cancellation. */
  abortDrainMs?: number;
  /** Keep durable claims closed until the owning daemon commits its serving fence. */
  initiallyAccepting?: boolean;
}

export class SparkInvocationScheduler {
  private readonly store: SparkInvocationStore;
  private readonly executeTask: SparkDaemonTaskExecutor;
  private readonly completeInvocation: NonNullable<
    SparkInvocationSchedulerOptions["completeInvocation"]
  >;
  private readonly emitEvent?: (event: SparkInvocationEvent) => void | Promise<void>;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly taskTimeoutMs: number;
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly activeSessions = new Set<string>();
  private accepting: boolean;

  constructor(options: SparkInvocationSchedulerOptions) {
    this.store = options.store;
    this.executeTask = options.executeTask;
    this.completeInvocation =
      options.completeInvocation ??
      ((invocation, _task, completion) => this.store.complete(invocation.invocationId, completion));
    this.emitEvent = options.emitEvent;
    this.workerId = options.workerId ?? `daemon-${process.pid}`;
    this.concurrency = positiveInteger(
      options.concurrency,
      DEFAULT_INVOCATION_SCHEDULER_CONCURRENCY,
    );
    this.taskTimeoutMs = nonNegativeInteger(
      options.taskTimeoutMs,
      DEFAULT_INVOCATION_TASK_TIMEOUT_MS,
    );
    this.accepting = options.initiallyAccepting !== false;
  }

  recover(now?: string): number {
    // Successor daemon resumes interrupted turns against persisted session state.
    // Invalid task payloads still fail closed because they cannot be reclaimed.
    let recovered = 0;
    while (true) {
      const running = this.store.listPage({ status: "running", limit: 100 }).invocations;
      if (running.length === 0) return recovered;
      for (const invocation of running) {
        try {
          validateSparkDaemonTask(invocation.task);
        } catch {
          this.store.complete(invocation.invocationId, {
            status: "failed",
            errorCode: SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
            errorMessage: SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
            ...(now ? { now } : {}),
          });
          recovered += 1;
          continue;
        }
        this.store.requeueForResume(invocation.invocationId, now);
        recovered += 1;
      }
    }
  }

  processBatch(): boolean {
    this.applyCancellationRequests();
    if (!this.accepting) return false;
    let launched = 0;
    while (this.active.size < this.concurrency) {
      const invocation = this.store.claimNext(this.workerId, new Date().toISOString(), [
        ...this.activeSessions,
      ]);
      if (!invocation) break;
      launched += 1;
      try {
        this.launch(invocation);
      } catch (error) {
        this.failInvalidTask(invocation, error);
      }
    }
    if (
      this.active.size >= this.concurrency &&
      this.activeQuestionCount() < MAX_BLOCKING_QUESTION_OVERFLOW
    ) {
      const question = this.store.claimNext(
        this.workerId,
        new Date().toISOString(),
        [...this.activeSessions],
        { sourceKind: "session.question" },
      );
      if (question) {
        launched += 1;
        try {
          this.launch(question);
        } catch (error) {
          this.failInvalidTask(question, error);
        }
      }
    }
    return launched > 0;
  }

  cancel(invocationId: string, reason = "cancel requested"): boolean {
    const outcome = this.store.requestCancellation(invocationId, reason);
    const active = this.active.get(invocationId);
    if (active) active.controller.abort(new InvocationCancelledError(reason));
    return outcome === "cancelled" || outcome === "requested";
  }

  snapshot(): SparkInvocationRecord[] {
    return [...this.active.values()].map((entry) => entry.invocation);
  }

  /** Stop claiming durable queued work while allowing active invocations to settle normally. */
  beginDrain(): number {
    this.accepting = false;
    return this.active.size;
  }

  /** Open durable claims only after the daemon generation owns its serving fence. */
  activateAdmission(): void {
    this.accepting = true;
  }

  get draining(): boolean {
    return !this.accepting;
  }

  stop(reason = "Spark daemon scheduler stopped"): void {
    for (const active of this.active.values()) {
      active.controller.abort(new InvocationCancelledError(reason));
    }
  }

  async wait(options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
    // Process ownership must outlive the real executor. Callers that are only
    // observing may opt into a deadline, but daemon shutdown/drain is unbounded
    // and remains externally cancellable through the invocation signal.
    const deadline = Date.now() + (options.timeoutMs ?? Number.POSITIVE_INFINITY);
    while (this.active.size > 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for Spark daemon invocations");
      await delay(options.pollIntervalMs ?? 5);
    }
  }

  private activeQuestionCount(): number {
    return [...this.active.values()].filter(
      (entry) => entry.invocation.sourceKind === "session.question",
    ).length;
  }

  private applyCancellationRequests(): void {
    for (const active of this.active.values()) {
      const persisted = this.store.get(active.invocation.invocationId);
      if (persisted?.status === "running" && persisted.cancelReason) {
        active.controller.abort(new InvocationCancelledError(persisted.cancelReason));
      }
    }
  }

  private failInvalidTask(invocation: SparkInvocationRecord, error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    this.store.complete(invocation.invocationId, {
      status: "failed",
      errorCode: "INVALID_TASK",
      errorMessage: reason.message,
    });
    this.emit({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: new Date().toISOString(),
      invocationId: invocation.invocationId,
      ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      taskType: invalidTaskType(invocation.task),
      status: "failed",
      summary: reason.message,
      metadata: {},
    });
  }

  private launch(invocation: SparkInvocationRecord): void {
    const task = validateSparkDaemonTask(invocation.task);
    const controller = new AbortController();
    const sessionId = getSparkDaemonTaskSessionId(task);
    let executorSettled: Promise<unknown> | undefined;
    if (sessionId) this.activeSessions.add(sessionId);
    const settled = this.run(invocation, task, controller, (promise) => {
      executorSettled = promise;
    }).finally(() => {
      this.active.delete(invocation.invocationId);
      if (!sessionId) return;
      const releaseSession = () => this.activeSessions.delete(sessionId);
      if (executorSettled) void executorSettled.then(releaseSession, releaseSession);
      else releaseSession();
    });
    this.active.set(invocation.invocationId, { invocation, controller, settled });
  }

  private async run(
    invocation: SparkInvocationRecord,
    task: SparkDaemonTask,
    controller: AbortController,
    trackExecutorSettlement: (promise: Promise<unknown>) => void,
  ): Promise<void> {
    this.emit(lifecycleEvent(invocation.invocationId, task, "running"));
    const timeout = new InvocationTimeoutController(this.taskTimeoutMs, controller);
    timeout.start();
    let executorSettled: Promise<unknown> | undefined;
    let streamedEventCount = 0;
    try {
      const context = {
        invocationId: invocation.invocationId,
        signal: controller.signal,
        timeoutMs: this.taskTimeoutMs,
        withPausedTimeout: async <T>(operation: () => Promise<T>) =>
          await timeout.runPaused(operation),
        emitEvent: (event: SparkDaemonEvent) => {
          streamedEventCount += 1;
          return this.emitPersisted(
            this.store.appendEvent(
              invocation.invocationId,
              event.type,
              event as unknown as Record<string, unknown>,
            ),
          );
        },
      };
      executorSettled = this.executeTask(task, context);
      trackExecutorSettlement(executorSettled);
      const result = await Promise.race([executorSettled, abortPromise(controller.signal)]);
      if (streamedEventCount === 0) {
        for (const event of daemonEventsFromTaskResult(result, task, invocation.invocationId)) {
          this.emit(event);
        }
      }
      this.completeInvocation(invocation, task, { status: "succeeded", result });
      this.emit(lifecycleEvent(invocation.invocationId, task, "succeeded"));
    } catch (error) {
      const reason = abortReason(controller.signal, error);
      if (reason instanceof InvocationCancelledError) {
        this.completeInvocation(invocation, task, {
          status: "cancelled",
          cancelReason: reason.message,
        });
        this.emit(lifecycleEvent(invocation.invocationId, task, "cancelled", reason.message));
      } else {
        this.completeInvocation(invocation, task, {
          status: "failed",
          errorCode: executionErrorCode(reason),
          errorMessage: reason.message,
        });
        this.emit(lifecycleEvent(invocation.invocationId, task, "failed", reason.message));
      }
      if (controller.signal.aborted && executorSettled) {
        // A terminal row is visible as soon as cancellation/timeout wins, but
        // the daemon must retain the session fence and process ownership until
        // the real executor settles. Otherwise an abort-ignoring provider/tool
        // can continue side effects after restart and overlap an explicit retry.
        await executorSettled.catch(() => undefined);
      }
    } finally {
      timeout.clear();
    }
  }

  private emit(event: SparkDaemonEvent): void {
    const persisted = this.store.appendEvent(
      event.invocationId ?? "",
      event.type,
      event as unknown as Record<string, unknown>,
    );
    void this.emitPersisted(persisted);
  }

  private emitPersisted(event: SparkInvocationEvent): void | Promise<void> {
    if (!this.emitEvent) return;
    const emitted = this.emitEvent(event);
    void Promise.resolve(emitted).catch((error) => {
      console.error("[spark-daemon] invocation event sink failed", error);
    });
    return emitted;
  }
}

function daemonEventsFromTaskResult(
  result: unknown,
  task: SparkDaemonTask,
  invocationId: string,
): SparkDaemonEvent[] {
  if (
    result &&
    typeof result === "object" &&
    (result as { eventsStreamed?: unknown }).eventsStreamed
  ) {
    return [];
  }
  const rawEvents =
    result && typeof result === "object"
      ? (result as { jsonEvents?: unknown }).jsonEvents
      : undefined;
  if (!Array.isArray(rawEvents)) return [];
  const sessionId = getSparkDaemonTaskSessionId(task) ?? undefined;
  return rawEvents.flatMap((raw): SparkDaemonEvent[] => {
    if (!raw || typeof raw !== "object") return [];
    const candidate = raw as { type?: unknown; event?: unknown };
    if (candidate.type === "view_event") {
      try {
        return [
          {
            version: SPARK_PROTOCOL_VERSION,
            type: "daemon.view_event",
            source: "daemon",
            emittedAt: new Date().toISOString(),
            sessionId,
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            ...(task.projectId ? { projectId: task.projectId } : {}),
            invocationId,
            view: parseSparkViewModelEvent(candidate.event),
            metadata: daemonTaskRouteMetadata(task),
          },
        ];
      } catch {
        return [];
      }
    }
    if (candidate.type !== "daemon_event") return [];
    try {
      const event = parseSparkDaemonEvent(candidate.event);
      return [
        {
          ...event,
          emittedAt: event.emittedAt ?? new Date().toISOString(),
          ...(task.workspaceId && !event.workspaceId ? { workspaceId: task.workspaceId } : {}),
          ...(task.projectId && !event.projectId ? { projectId: task.projectId } : {}),
          sessionId: event.sessionId ?? sessionId,
          invocationId: event.invocationId ?? invocationId,
          metadata: {
            ...daemonTaskRouteMetadata(task),
            ...event.metadata,
          },
        },
      ];
    } catch {
      return [];
    }
  });
}

function daemonTaskRouteMetadata(task: SparkDaemonTask): SparkJsonObject {
  return {
    ...(task.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
  };
}

function lifecycleEvent(
  invocationId: string,
  task: SparkDaemonTask,
  status: "running" | "succeeded" | "failed" | "cancelled",
  summary?: string,
): SparkDaemonEvent {
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.task.lifecycle",
    source: "daemon",
    emittedAt: new Date().toISOString(),
    invocationId,
    sessionId: task.sessionId,
    ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskType: task.type,
    status,
    ...(summary ? { summary } : {}),
    metadata: {
      ...(task.workspaceBindingId ? { workspaceBindingId: task.workspaceBindingId } : {}),
    },
  };
}

class InvocationTimeoutController {
  private readonly timeoutMs: number;
  private readonly controller: AbortController;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs: number;
  private startedAt: number | undefined;
  private pauseDepth = 0;

  constructor(timeoutMs: number, controller: AbortController) {
    this.timeoutMs = timeoutMs;
    this.controller = controller;
    this.remainingMs = timeoutMs;
  }

  start(): void {
    if (this.timeoutMs > 0) this.arm();
  }

  async runPaused<T>(operation: () => Promise<T>): Promise<T> {
    this.pauseDepth += 1;
    if (this.pauseDepth === 1) this.suspend();
    try {
      return await operation();
    } finally {
      this.pauseDepth -= 1;
      if (this.pauseDepth === 0 && !this.controller.signal.aborted) this.arm();
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  private arm(): void {
    if (this.timeoutMs <= 0 || this.timer || this.controller.signal.aborted) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startedAt = undefined;
      this.remainingMs = 0;
      this.controller.abort(new InvocationTimeoutError(this.timeoutMs));
    }, this.remainingMs);
    this.timer.unref?.();
  }

  private suspend(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.startedAt !== undefined) {
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
    }
    this.startedAt = undefined;
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(abortReason(signal, new Error("invocation aborted")));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : fallback instanceof Error
      ? fallback
      : new Error(String(fallback));
}

function executionErrorCode(error: Error): string {
  if (error instanceof InvocationTimeoutError) return "EXECUTOR_TIMEOUT";
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
    ? code
    : "EXECUTION_FAILED";
}

export class InvocationTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Spark daemon invocation timed out after ${timeoutMs}ms`);
    this.name = "InvocationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class InvocationCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvocationCancelledError";
  }
}

function invalidTaskType(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type.trim()) return type.trim();
  }
  return "invalid";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value ?? fallback));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value ?? fallback));
}
