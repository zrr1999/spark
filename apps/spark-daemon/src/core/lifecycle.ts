import { randomUUID } from "node:crypto";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

export type SparkDaemonLifecycleState = "starting" | "running" | "draining" | "stopping";
export type SparkDaemonLifecyclePhase =
  | "initializing"
  | "serving"
  | "draining-active-work"
  | "draining-channel-ingress"
  | "stopping";

export type SparkDaemonDrainStage = "active-work" | "channel-ingress";

export interface SparkDaemonDrainWork {
  invocationId: string;
  kind: string;
  startedAt: string;
  sessionId?: string;
}

/** Process-local execution fences that must settle before a restart can hand off ownership. */
export interface SparkDaemonDrainProgress {
  observedAt: string;
  stage: SparkDaemonDrainStage;
  scheduler: SparkDaemonDrainWork[];
  direct: SparkDaemonDrainWork[];
}

export interface SparkDaemonProcessIdentity {
  pid: number;
  instanceId: string;
  /** Unique for every daemon process, even when a service manager reuses configuration. */
  generation: string;
  protocolVersion: typeof SPARK_PROTOCOL_VERSION;
  startedAt: string;
  /** Restart fence this process was created to satisfy, when applicable. */
  acceptedRestartId?: string;
  predecessorInstanceId?: string;
  predecessorGeneration?: string;
}

export interface SparkDaemonLifecycleSnapshot {
  state: SparkDaemonLifecycleState;
  phase?: SparkDaemonLifecyclePhase;
  process?: SparkDaemonProcessIdentity;
  restartId?: string;
  targetInstanceId?: string;
  targetGeneration?: string;
  targetVersion?: string;
  targetBuildFingerprint?: string;
  restartRequestedAt?: string;
  drain?: SparkDaemonDrainProgress;
  stopRequestedAt?: string;
  stopReason?: string;
}

export interface SparkDaemonRestartRequestResult {
  accepted: true;
  state: "draining";
  restartId: string;
  processInstanceId: string;
  processGeneration: string;
  targetInstanceId: string;
  targetGeneration: string;
  targetVersion?: string;
  targetBuildFingerprint?: string;
  requestedAt: string;
}

export class SparkDaemonRestartRequestedError extends Error {
  constructor() {
    super("Spark daemon restart requested");
    this.name = "SparkDaemonRestartRequestedError";
  }
}

/**
 * Process-local lifecycle intent. Requesting a restart is deliberately split
 * from process replacement: the daemon drains work, while its service helper
 * owns starting the next process generation.
 */
export class SparkDaemonLifecycle {
  private readonly drainController = new AbortController();
  private readonly restartController = new AbortController();
  private readonly identity: SparkDaemonProcessIdentity;
  private restartId: string | undefined;
  private targetInstanceId: string | undefined;
  private targetGeneration: string | undefined;
  private targetVersion: string | undefined;
  private targetBuildFingerprint: string | undefined;
  private restartRequestedAt: string | undefined;
  private stopRequestedAt: string | undefined;
  private stopReason: string | undefined;
  private serving: boolean;

  constructor(
    identity: Partial<Omit<SparkDaemonProcessIdentity, "pid" | "generation" | "startedAt">> &
      Pick<Partial<SparkDaemonProcessIdentity>, "pid" | "generation" | "startedAt"> = {},
    options: { initiallyServing?: boolean } = {},
  ) {
    this.identity = {
      pid: identity.pid ?? process.pid,
      instanceId: identity.instanceId ?? randomUUID(),
      generation: identity.generation ?? randomUUID(),
      protocolVersion: SPARK_PROTOCOL_VERSION,
      startedAt: identity.startedAt ?? new Date().toISOString(),
      ...(identity.acceptedRestartId ? { acceptedRestartId: identity.acceptedRestartId } : {}),
      ...(identity.predecessorGeneration
        ? { predecessorGeneration: identity.predecessorGeneration }
        : {}),
      ...(identity.predecessorInstanceId
        ? { predecessorInstanceId: identity.predecessorInstanceId }
        : {}),
    };
    this.serving = options.initiallyServing !== false;
  }

  /** Synchronous admission gate: no new work may start once this aborts. */
  get drainSignal(): AbortSignal {
    return this.drainController.signal;
  }

  /** Asynchronous exit gate: delayed so the restart RPC ACK can be written first. */
  get restartSignal(): AbortSignal {
    return this.restartController.signal;
  }

  get restartRequested(): boolean {
    return this.restartRequestedAt !== undefined;
  }

  /** Open externally observable work admission for the final synchronous startup commit. */
  activate(): void {
    this.serving = true;
  }

  /**
   * Roll back an unobservable startup activation when the final restart-fence
   * compare-and-swap loses to an explicit stop. Callers pair this
   * synchronously with `activate()` so local RPC cannot observe a false
   * serving generation between the two operations.
   */
  deactivate(): void {
    this.serving = false;
  }

  get isServing(): boolean {
    return this.serving && !this.restartRequestedAt && !this.stopRequestedAt;
  }

  get processGeneration(): string {
    return this.identity.generation;
  }

  get processIdentity(): SparkDaemonProcessIdentity {
    return this.identity;
  }

  snapshot(): SparkDaemonLifecycleSnapshot {
    if (this.stopRequestedAt) {
      return {
        state: "stopping",
        phase: "stopping",
        process: this.identity,
        stopRequestedAt: this.stopRequestedAt,
        ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      };
    }
    if (this.restartRequestedAt) {
      return {
        state: "draining",
        phase: "draining-active-work",
        process: this.identity,
        restartId: this.restartId,
        targetInstanceId: this.targetInstanceId,
        targetGeneration: this.targetGeneration,
        ...(this.targetVersion ? { targetVersion: this.targetVersion } : {}),
        ...(this.targetBuildFingerprint
          ? { targetBuildFingerprint: this.targetBuildFingerprint }
          : {}),
        restartRequestedAt: this.restartRequestedAt,
      };
    }
    return this.serving
      ? { state: "running", phase: "serving", process: this.identity }
      : { state: "starting", phase: "initializing", process: this.identity };
  }

  /** Close readiness synchronously before asynchronous stop teardown begins. */
  requestStop(reason: string, now = new Date().toISOString()): void {
    if (this.stopRequestedAt) return;
    this.stopRequestedAt = now;
    this.stopReason = reason.trim() || "stop-requested";
    this.serving = false;
    this.drainController.abort(new Error(`Spark daemon stopping: ${this.stopReason}`));
  }

  requestRestart(
    now = new Date().toISOString(),
    restartId: string = randomUUID(),
    target: {
      instanceId: string;
      generation: string;
      version?: string;
      buildFingerprint?: string;
    } = {
      instanceId: randomUUID(),
      generation: randomUUID(),
    },
  ): SparkDaemonRestartRequestResult {
    if (this.stopRequestedAt) {
      throw new Error("Spark daemon is stopping and cannot restart.");
    }
    if (!this.restartRequestedAt) {
      this.restartRequestedAt = now;
      this.restartId = restartId;
      this.targetInstanceId = target.instanceId;
      this.targetGeneration = target.generation;
      this.targetVersion = target.version;
      this.targetBuildFingerprint = target.buildFingerprint;
      const reason = new SparkDaemonRestartRequestedError();
      this.drainController.abort(reason);
      // Let the local-RPC response enter the socket write buffer before the
      // zero-active fast path starts tearing down the server.
      setTimeout(() => {
        this.restartController.abort(reason);
      }, 0);
    }
    return {
      accepted: true,
      state: "draining",
      restartId: this.restartId!,
      processInstanceId: this.identity.instanceId,
      processGeneration: this.identity.generation,
      targetInstanceId: this.targetInstanceId!,
      targetGeneration: this.targetGeneration!,
      ...(this.targetVersion ? { targetVersion: this.targetVersion } : {}),
      ...(this.targetBuildFingerprint
        ? { targetBuildFingerprint: this.targetBuildFingerprint }
        : {}),
      requestedAt: this.restartRequestedAt,
    };
  }
}
