import { randomUUID } from "node:crypto";
import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

export type SparkDaemonLifecycleState = "running" | "draining";
export type SparkDaemonLifecyclePhase = "serving" | "draining-active-work";

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
  restartRequestedAt?: string;
}

export interface SparkDaemonRestartRequestResult {
  accepted: true;
  state: "draining";
  restartId: string;
  processInstanceId: string;
  processGeneration: string;
  targetInstanceId: string;
  targetGeneration: string;
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
  private restartRequestedAt: string | undefined;

  constructor(
    identity: Partial<Omit<SparkDaemonProcessIdentity, "pid" | "generation" | "startedAt">> &
      Pick<Partial<SparkDaemonProcessIdentity>, "pid" | "generation" | "startedAt"> = {},
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

  get processGeneration(): string {
    return this.identity.generation;
  }

  get processIdentity(): SparkDaemonProcessIdentity {
    return this.identity;
  }

  snapshot(): SparkDaemonLifecycleSnapshot {
    return this.restartRequestedAt
      ? {
          state: "draining",
          phase: "draining-active-work",
          process: this.identity,
          restartId: this.restartId,
          targetInstanceId: this.targetInstanceId,
          targetGeneration: this.targetGeneration,
          restartRequestedAt: this.restartRequestedAt,
        }
      : { state: "running", phase: "serving", process: this.identity };
  }

  requestRestart(
    now = new Date().toISOString(),
    restartId: string = randomUUID(),
    target: { instanceId: string; generation: string } = {
      instanceId: randomUUID(),
      generation: randomUUID(),
    },
  ): SparkDaemonRestartRequestResult {
    if (!this.restartRequestedAt) {
      this.restartRequestedAt = now;
      this.restartId = restartId;
      this.targetInstanceId = target.instanceId;
      this.targetGeneration = target.generation;
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
      requestedAt: this.restartRequestedAt,
    };
  }
}
