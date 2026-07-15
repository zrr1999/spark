/** Process-local abort handles for active remote command routing. */

export interface SparkDaemonInvocationRecord {
  invocationId: string;
  kind: string;
  startedAt: string;
  sessionId?: string;
  reason?: string;
}

export interface SparkDaemonInvocationHandle extends SparkDaemonInvocationRecord {
  readonly signal: AbortSignal;
  finish(): void;
  cancel(reason?: string): boolean;
}

interface TrackedInvocation extends SparkDaemonInvocationRecord {
  controller: AbortController;
}

export type SparkDaemonSessionCancellationResult =
  | "cancel-requested"
  | "not-found"
  | "session-mismatch";

export class SparkDaemonInvocationRegistry {
  private readonly active = new Map<string, TrackedInvocation>();
  private readonly activeSessions = new Map<string, Set<string>>();
  private readonly idleWaiters = new Set<() => void>();
  private accepting = true;

  start(input: {
    invocationId: string;
    kind: string;
    sessionId?: string | null;
  }): SparkDaemonInvocationHandle {
    if (!this.accepting) {
      throw new Error("Spark daemon is draining and cannot start a new direct invocation");
    }
    if (this.active.has(input.invocationId)) {
      throw new Error(`Spark daemon invocation already active: ${input.invocationId}`);
    }
    const record: TrackedInvocation = {
      invocationId: input.invocationId,
      kind: input.kind,
      startedAt: new Date().toISOString(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      controller: new AbortController(),
    };
    this.active.set(record.invocationId, record);
    if (record.sessionId) {
      const sessions = this.activeSessions.get(record.sessionId) ?? new Set<string>();
      sessions.add(record.invocationId);
      this.activeSessions.set(record.sessionId, sessions);
    }
    return this.handleFor(record);
  }

  cancel(invocationId: string, reason?: string): boolean {
    const record = this.active.get(invocationId);
    if (!record) return false;
    record.reason = reason;
    record.controller.abort(reason);
    return true;
  }

  cancelForSession(
    invocationId: string,
    sessionId: string,
    reason?: string,
  ): SparkDaemonSessionCancellationResult {
    const record = this.active.get(invocationId);
    if (!record) return "not-found";
    if (record.sessionId !== sessionId) return "session-mismatch";
    record.reason = reason;
    record.controller.abort(reason);
    return "cancel-requested";
  }

  has(invocationId: string): boolean {
    return this.active.has(invocationId);
  }

  hasActiveSession(sessionId: string): boolean {
    return (this.activeSessions.get(sessionId)?.size ?? 0) > 0;
  }

  snapshot(): SparkDaemonInvocationRecord[] {
    return [...this.active.values()].map((record) => ({
      invocationId: record.invocationId,
      kind: record.kind,
      startedAt: record.startedAt,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }));
  }

  beginDrain(): number {
    this.accepting = false;
    return this.active.size;
  }

  get draining(): boolean {
    return !this.accepting;
  }

  stop(reason = "Spark daemon stopped"): number {
    this.accepting = false;
    const active = [...this.active.values()];
    for (const record of active) {
      record.reason = reason;
      record.controller.abort(reason);
    }
    return active.length;
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private finish(invocationId: string): void {
    const record = this.active.get(invocationId);
    if (!record) return;
    this.active.delete(invocationId);
    if (record.sessionId) {
      const sessions = this.activeSessions.get(record.sessionId);
      sessions?.delete(invocationId);
      if (sessions?.size === 0) this.activeSessions.delete(record.sessionId);
    }
    if (this.active.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private handleFor(record: TrackedInvocation): SparkDaemonInvocationHandle {
    let finished = false;
    return {
      invocationId: record.invocationId,
      kind: record.kind,
      startedAt: record.startedAt,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      get signal() {
        return record.controller.signal;
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.finish(record.invocationId);
      },
      cancel: (reason?: string) => this.cancel(record.invocationId, reason),
    };
  }
}
