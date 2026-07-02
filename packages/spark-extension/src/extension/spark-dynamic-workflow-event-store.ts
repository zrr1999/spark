import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  newRef,
  nowIso,
  type RunRef,
  writeJsonFileAtomic,
  readJsonFileOptional,
} from "@zendev-lab/spark-extension-api";
import {
  projectWorkflowRunEvents,
  type WorkflowAgentTelemetry,
  type WorkflowJournalEntry,
  type WorkflowMeta,
  type WorkflowPhaseRun,
  type WorkflowStageRun,
  type WorkflowRunEvent,
  type WorkflowRunResult,
  type WorkflowRunSnapshot,
} from "@zendev-lab/spark-workflows";
import {
  hashWorkflowScript,
  type SparkDynamicWorkflowRunApproval,
  type SparkDynamicWorkflowRunBaseMetadata,
  type SparkDynamicWorkflowRunOptions,
  type SparkDynamicWorkflowAgentTelemetry,
  type SparkDynamicWorkflowRunAckResult,
  type SparkDynamicWorkflowRunRecord,
  type SparkDynamicWorkflowRunSavedWorkflow,
  type SparkDynamicWorkflowRunSaveResult,
  type SparkDynamicWorkflowRunSource,
  type SparkDynamicWorkflowRunStatus,
  type SparkDynamicWorkflowRunStoreSnapshot,
  type SparkDynamicWorkflowUsageTotals,
} from "./spark-dynamic-workflow-run-store.ts";
import { userWorkflowDir, workspaceWorkflowDir } from "./spark-workflow-registry.ts";

export interface SparkDynamicWorkflowEventRunMetadata {
  version: 2;
  runRef: RunRef;
  source: SparkDynamicWorkflowRunSource;
  scriptHash: string;
  args?: unknown;
  meta: WorkflowMeta;
  options: SparkDynamicWorkflowRunOptions;
  base?: SparkDynamicWorkflowRunBaseMetadata;
  approval?: SparkDynamicWorkflowRunApproval;
  savedWorkflow?: SparkDynamicWorkflowRunSavedWorkflow;
  acknowledgedAt?: string;
  resumedFrom?: RunRef;
  stages?: WorkflowStageRun[];
  /** @deprecated Use stages. */
  phases?: WorkflowPhaseRun[];
  journal?: WorkflowJournalEntry[];
  spentTokens?: number;
  usageTotals?: SparkDynamicWorkflowUsageTotals;
  agentTelemetry?: SparkDynamicWorkflowAgentTelemetry[];
  createdAt: string;
  updatedAt: string;
  migratedFrom?: "dynamic-workflow-runs-v1";
}

export interface SparkDynamicWorkflowEventSnapshotFile {
  version: 2;
  runRef: RunRef;
  updatedAt: string;
  snapshot: WorkflowRunSnapshot;
}

export interface SparkDynamicWorkflowEventRunView {
  metadata: SparkDynamicWorkflowEventRunMetadata;
  snapshot: WorkflowRunSnapshot;
}

export type SparkDynamicWorkflowEventInput = Omit<
  WorkflowRunEvent,
  "id" | "sequence" | "timestamp"
> & {
  timestamp?: string;
};

export interface SparkDynamicWorkflowEventRunStartInput {
  runRef?: RunRef;
  source: SparkDynamicWorkflowRunSource;
  script: string;
  args?: unknown;
  meta: WorkflowMeta;
  options: SparkDynamicWorkflowRunOptions;
  base?: SparkDynamicWorkflowRunBaseMetadata;
  approval?: SparkDynamicWorkflowRunApproval;
  savedWorkflow?: SparkDynamicWorkflowRunSavedWorkflow;
  acknowledgedAt?: string;
  resumedFrom?: RunRef;
  resumeRunRef?: RunRef;
  now?: string;
}

export class SparkDynamicWorkflowEventStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async load(): Promise<SparkDynamicWorkflowRunStoreSnapshot> {
    return { version: 1, runs: await this.listDynamicWorkflowRunRecords() };
  }

  async get(runRef: RunRef): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    return this.toDynamicWorkflowRunRecord(runRef);
  }

  async start(
    input: SparkDynamicWorkflowEventRunStartInput,
  ): Promise<SparkDynamicWorkflowRunRecord> {
    const snapshot = await this.startRun(input);
    const run = await this.toDynamicWorkflowRunRecord(snapshot.runRef as RunRef);
    if (!run) throw new Error(`failed to start dynamic workflow run ${snapshot.runRef}`);
    return run;
  }

  async startRun(input: SparkDynamicWorkflowEventRunStartInput): Promise<WorkflowRunSnapshot> {
    const runRef = input.runRef ?? input.resumeRunRef ?? newRef("run");
    const timestamp = input.now ?? nowIso();
    const previousMetadata = input.resumeRunRef ? await this.getMetadata(runRef) : undefined;
    const runDir = this.runDir(runRef);
    await mkdir(runDir, { recursive: true });
    const metadata: SparkDynamicWorkflowEventRunMetadata = {
      version: 2,
      runRef,
      source: input.source,
      scriptHash: hashWorkflowScript(input.script),
      ...(input.args === undefined ? {} : { args: input.args }),
      meta: input.meta,
      options: input.options,
      ...(input.base ? { base: input.base } : {}),
      ...(input.approval ? { approval: input.approval } : {}),
      ...(previousMetadata?.savedWorkflow ? { savedWorkflow: previousMetadata.savedWorkflow } : {}),
      ...(input.savedWorkflow ? { savedWorkflow: input.savedWorkflow } : {}),
      ...(input.acknowledgedAt ? { acknowledgedAt: input.acknowledgedAt } : {}),
      ...((input.resumedFrom ?? input.resumeRunRef)
        ? { resumedFrom: input.resumedFrom ?? input.resumeRunRef }
        : {}),
      ...(previousMetadata?.stages ? { stages: previousMetadata.stages } : {}),
      ...(previousMetadata?.phases ? { phases: previousMetadata.phases } : {}),
      ...(previousMetadata?.journal ? { journal: previousMetadata.journal } : {}),
      ...(previousMetadata?.spentTokens !== undefined
        ? { spentTokens: previousMetadata.spentTokens }
        : {}),
      ...(previousMetadata?.usageTotals ? { usageTotals: previousMetadata.usageTotals } : {}),
      ...(previousMetadata?.agentTelemetry
        ? { agentTelemetry: previousMetadata.agentTelemetry }
        : {}),
      createdAt: previousMetadata?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const existingEvents = input.resumeRunRef ? await this.readEvents(runRef) : [];
    await writeJsonFileAtomic(this.metadataPath(runRef), metadata);
    await writeFile(this.scriptPath(runRef), input.script, "utf8");
    if (existingEvents.length === 0) await writeFile(this.eventsPath(runRef), "", "utf8");
    return this.appendEvent(runRef, {
      type: "run_started",
      nodeId: "run",
      nodeKind: "run",
      label: input.meta.name,
      meta: input.meta,
      timestamp,
    });
  }

  async appendEvent(
    runRef: RunRef,
    input: SparkDynamicWorkflowEventInput,
  ): Promise<WorkflowRunSnapshot> {
    const events = await this.readEvents(runRef);
    const sequence =
      events.length === 0 ? 0 : Math.max(...events.map((event) => event.sequence)) + 1;
    const event: WorkflowRunEvent = {
      id: `event:${sequence}`,
      sequence,
      timestamp: input.timestamp ?? nowIso(),
      ...input,
    };
    await mkdir(this.runDir(runRef), { recursive: true });
    await appendFile(this.eventsPath(runRef), `${JSON.stringify(event)}\n`, "utf8");
    const snapshot = projectWorkflowRunEvents([...events, event]);
    snapshot.runRef = runRef;
    await this.writeSnapshot(runRef, snapshot);
    await this.touchMetadata(runRef, event.timestamp);
    return snapshot;
  }

  async recordStage(runRef: RunRef, stage: WorkflowStageRun): Promise<void> {
    await this.updateMetadata(runRef, (metadata, now) => {
      const existingStages = metadata.stages ?? metadata.phases ?? [];
      const next = [...existingStages].filter((candidate) => candidate.title !== stage.title);
      next.push(stage);
      metadata.stages = next;
      metadata.phases = next;
      metadata.updatedAt = now;
    });
    await this.appendEvent(runRef, {
      type: stage.status ? "stage_finished" : "stage_started",
      nodeId: `stage:${stage.title}`,
      parentId: "run",
      nodeKind: "stage",
      title: stage.title,
      stage: stage.title,
      phase: stage.title,
      stageRun: stage,
      phaseRun: stage,
      status:
        stage.status === "fail"
          ? "failed"
          : stage.status === "skip"
            ? "skipped"
            : stage.status
              ? "succeeded"
              : undefined,
      timestamp: stage.finishedAt ?? stage.startedAt,
    });
  }

  /** @deprecated Use recordStage. */
  async recordPhase(runRef: RunRef, phase: WorkflowPhaseRun): Promise<void> {
    await this.recordStage(runRef, phase);
  }

  async recordJournal(runRef: RunRef, entry: WorkflowJournalEntry): Promise<void> {
    await this.updateMetadata(runRef, (metadata, now) => {
      const next = [...(metadata.journal ?? [])].filter(
        (candidate) => candidate.index !== entry.index,
      );
      next.push(entry);
      next.sort((a, b) => a.index - b.index);
      metadata.journal = next;
      metadata.updatedAt = now;
    });
    await this.appendEvent(runRef, {
      type: "agent_succeeded",
      nodeId: `agent:${entry.index}`,
      parentId: "run",
      nodeKind: "agent",
      index: entry.index,
      label: `agent ${entry.index + 1}`,
      result: entry.result,
    });
  }

  async recordTokenUsage(
    runRef: RunRef,
    spentTokens: number,
    usage?: WorkflowAgentTelemetry["usage"],
  ): Promise<void> {
    await this.updateMetadata(runRef, (metadata, now) => {
      metadata.spentTokens = spentTokens;
      if (usage) metadata.usageTotals = addUsageToTotals(metadata.usageTotals, usage);
      metadata.updatedAt = now;
    });
  }

  async recordAgentTelemetry(runRef: RunRef, telemetry: WorkflowAgentTelemetry): Promise<void> {
    await this.updateMetadata(runRef, (metadata, now) => {
      const next = [...(metadata.agentTelemetry ?? [])].filter(
        (candidate) => candidate.index !== telemetry.index,
      );
      next.push({ ...telemetry });
      next.sort((a, b) => a.index - b.index);
      metadata.agentTelemetry = next;
      if (telemetry.spentTokens !== undefined) metadata.spentTokens = telemetry.spentTokens;
      const totals = aggregateWorkflowUsageTotals(next);
      if (totals) metadata.usageTotals = totals;
      metadata.updatedAt = now;
    });
  }

  async finish(
    runRef: RunRef,
    result: WorkflowRunResult,
    error?: unknown,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    for (const stage of result.stages ?? result.phases) await this.recordStage(runRef, stage);
    for (const entry of result.journal) await this.recordJournal(runRef, entry);
    await this.appendEvent(runRef, {
      type: error ? "run_failed" : "run_succeeded",
      nodeId: "run",
      nodeKind: "run",
      result: error ? undefined : result.result,
      errorMessage: error ? errorMessage(error) : undefined,
    });
    await this.updateMetadata(runRef, (metadata, now) => {
      const stages = result.stages ?? result.phases;
      metadata.stages = stages;
      metadata.phases = stages;
      metadata.journal = result.journal;
      const totals = aggregateWorkflowUsageTotals(metadata.agentTelemetry ?? []);
      if (totals) metadata.usageTotals = totals;
      metadata.updatedAt = now;
    });
    return this.get(runRef);
  }

  async fail(runRef: RunRef, error: unknown): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    await this.appendEvent(runRef, {
      type: "run_failed",
      nodeId: "run",
      nodeKind: "run",
      errorMessage: errorMessage(error),
    });
    return this.get(runRef);
  }

  async pause(runRef: RunRef, reason = "paused by workflow control") {
    await this.appendEvent(runRef, {
      type: "run_paused",
      nodeId: "run",
      nodeKind: "run",
      errorMessage: reason,
    });
    return this.get(runRef);
  }

  async resume(runRef: RunRef) {
    await this.updateMetadata(runRef, (metadata, now) => {
      metadata.acknowledgedAt = undefined;
      metadata.updatedAt = now;
    });
    const metadata = await this.getMetadata(runRef);
    await this.appendEvent(runRef, {
      type: "run_started",
      nodeId: "run",
      nodeKind: "run",
      label: metadata?.meta.name ?? runRef,
      meta: metadata?.meta,
    });
    return this.get(runRef);
  }

  async stop(runRef: RunRef, reason = "stopped by workflow control") {
    await this.appendEvent(runRef, {
      type: "run_stopped",
      nodeId: "run",
      nodeKind: "run",
      errorMessage: reason,
    });
    return this.get(runRef);
  }

  async restart(runRef: RunRef) {
    await this.updateMetadata(runRef, (metadata, now) => {
      metadata.acknowledgedAt = undefined;
      metadata.spentTokens = undefined;
      metadata.stages = [];
      metadata.phases = [];
      metadata.journal = [];
      metadata.usageTotals = undefined;
      metadata.agentTelemetry = [];
      metadata.updatedAt = now;
    });
    const metadata = await this.getMetadata(runRef);
    await this.appendEvent(runRef, {
      type: "run_started",
      nodeId: "run",
      nodeKind: "run",
      label: metadata?.meta.name ?? runRef,
      meta: metadata?.meta,
      data: { restarted: true },
    });
    return this.get(runRef);
  }

  async acknowledge(runRef?: RunRef): Promise<SparkDynamicWorkflowRunAckResult> {
    const acknowledgedAt = nowIso();
    const records = await this.listDynamicWorkflowRunRecords();
    const targets = records.filter(
      (record) => (!runRef || record.ref === runRef) && isAcknowledgeableDynamicWorkflowRun(record),
    );
    for (const record of targets) {
      await this.updateMetadata(record.ref, (metadata) => {
        metadata.acknowledgedAt = acknowledgedAt;
        metadata.updatedAt = acknowledgedAt;
      });
    }
    return { runRefs: targets.map((record) => record.ref), acknowledgedAt };
  }

  async saveAsWorkspaceWorkflow(input: {
    cwd: string;
    runRef: RunRef;
    workflowId?: string;
  }): Promise<SparkDynamicWorkflowRunSaveResult | undefined> {
    return this.saveAsWorkflow({ ...input, scope: "workspace" });
  }

  async saveAsWorkflow(input: {
    cwd: string;
    runRef: RunRef;
    workflowId?: string;
    scope?: "workspace" | "user";
  }): Promise<SparkDynamicWorkflowRunSaveResult | undefined> {
    const record = await this.get(input.runRef);
    if (!record) return undefined;
    const savedAt = nowIso();
    const scope = input.scope ?? "workspace";
    const workflowId = normalizeWorkflowId(
      input.workflowId ?? `${record.meta.name}-${input.runRef.replace(/^run:/u, "").slice(0, 8)}`,
    );
    const dir = scope === "user" ? userWorkflowDir() : workspaceWorkflowDir(input.cwd);
    const filePath = await nextAvailableWorkflowPath(dir, workflowId);
    await mkdir(dirname(filePath.path), { recursive: true });
    await writeFile(
      filePath.path,
      record.script.endsWith("\n") ? record.script : `${record.script}\n`,
      "utf8",
    );
    const savedWorkflow: SparkDynamicWorkflowRunSavedWorkflow = {
      selector: `${scope}:${filePath.savedId}`,
      path: scope === "workspace" ? relative(input.cwd, filePath.path) : filePath.path,
      savedAt,
      scope,
    };
    await this.updateMetadata(input.runRef, (metadata) => {
      metadata.savedWorkflow = savedWorkflow;
      metadata.updatedAt = savedAt;
    });
    return {
      runRef: input.runRef,
      selector: savedWorkflow.selector,
      path: savedWorkflow.path,
      savedAt,
      scope,
    };
  }

  async reconcileStale(input: { now?: string; staleAfterMs?: number } = {}) {
    const now = input.now ?? nowIso();
    const staleAfterMs = input.staleAfterMs ?? 30 * 60 * 1_000;
    const nowMs = Date.parse(now);
    const records = await this.listDynamicWorkflowRunRecords();
    for (const record of records) {
      if (record.status !== "running") continue;
      const updatedMs = Date.parse(record.updatedAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(updatedMs)) continue;
      if (nowMs - updatedMs < staleAfterMs) continue;
      await this.appendEvent(record.ref, {
        type: "run_stale",
        nodeId: "run",
        nodeKind: "run",
        errorMessage: `dynamic workflow run became stale after ${staleAfterMs}ms without progress`,
        timestamp: now,
      });
    }
    return this.load();
  }

  async getSnapshot(runRef: RunRef): Promise<WorkflowRunSnapshot | undefined> {
    const raw = await readJsonFileOptional(
      this.snapshotPath(runRef),
      (path, message) => new Error(`invalid workflow event snapshot ${path}: ${message}`),
    );
    if (!raw) return undefined;
    return (raw as SparkDynamicWorkflowEventSnapshotFile).snapshot;
  }

  async getMetadata(runRef: RunRef): Promise<SparkDynamicWorkflowEventRunMetadata | undefined> {
    const raw = await readJsonFileOptional(
      this.metadataPath(runRef),
      (path, message) => new Error(`invalid workflow event run metadata ${path}: ${message}`),
    );
    return raw as SparkDynamicWorkflowEventRunMetadata | undefined;
  }

  async getRun(runRef: RunRef): Promise<SparkDynamicWorkflowEventRunView | undefined> {
    const [metadata, snapshot] = await Promise.all([
      this.getMetadata(runRef),
      this.getSnapshot(runRef),
    ]);
    if (!metadata || !snapshot) return undefined;
    return { metadata, snapshot };
  }

  async toDynamicWorkflowRunRecord(
    runRef: RunRef,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    const run = await this.getRun(runRef);
    if (!run) return undefined;
    return dynamicWorkflowRecordFromEventRun(run, await this.readScript(runRef));
  }

  async listRuns(): Promise<SparkDynamicWorkflowEventRunView[]> {
    const runRefs = await this.listRunRefs();
    const runs = await Promise.all(runRefs.map((runRef) => this.getRun(runRef)));
    return runs
      .filter((run): run is SparkDynamicWorkflowEventRunView => Boolean(run))
      .sort((a, b) => (b.snapshot.updatedAt ?? "").localeCompare(a.snapshot.updatedAt ?? ""));
  }

  async listDynamicWorkflowRunRecords(): Promise<SparkDynamicWorkflowRunRecord[]> {
    const runRefs = await this.listRunRefs();
    const records = await Promise.all(
      runRefs.map((runRef) => this.toDynamicWorkflowRunRecord(runRef)),
    );
    return records
      .filter((record): record is SparkDynamicWorkflowRunRecord => Boolean(record))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async listSnapshots(): Promise<WorkflowRunSnapshot[]> {
    const runRefs = await this.listRunRefs();
    const snapshots = await Promise.all(runRefs.map((runRef) => this.getSnapshot(runRef)));
    return snapshots
      .filter((snapshot): snapshot is WorkflowRunSnapshot => Boolean(snapshot))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async readScript(runRef: RunRef): Promise<string> {
    return readFile(this.scriptPath(runRef), "utf8");
  }

  async readEvents(runRef: RunRef): Promise<WorkflowRunEvent[]> {
    try {
      const text = await readFile(this.eventsPath(runRef), "utf8");
      return text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkflowRunEvent)
        .sort((a, b) => a.sequence - b.sequence);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  async tailEvents(runRef: RunRef, limit = 50): Promise<WorkflowRunEvent[]> {
    const events = await this.readEvents(runRef);
    return events.slice(-Math.max(0, Math.trunc(limit)));
  }

  async compact(runRef: RunRef): Promise<WorkflowRunSnapshot | undefined> {
    const events = await this.readEvents(runRef);
    if (events.length === 0) return undefined;
    const snapshot = projectWorkflowRunEvents(events);
    snapshot.runRef = runRef;
    await this.writeSnapshot(runRef, snapshot);
    return snapshot;
  }

  async migrateFromV1Snapshot(
    legacy: SparkDynamicWorkflowRunStoreSnapshot,
  ): Promise<WorkflowRunSnapshot[]> {
    const migrated: WorkflowRunSnapshot[] = [];
    for (const record of legacy.runs) {
      migrated.push(await this.migrateFromV1Record(record));
    }
    return migrated;
  }

  async migrateFromV1Record(record: SparkDynamicWorkflowRunRecord): Promise<WorkflowRunSnapshot> {
    const existing = await this.getSnapshot(record.ref);
    if (existing) return existing;
    const runDir = this.runDir(record.ref);
    await mkdir(runDir, { recursive: true });
    const metadata: SparkDynamicWorkflowEventRunMetadata = {
      version: 2,
      runRef: record.ref,
      source: record.source,
      scriptHash: record.scriptHash,
      ...(record.args === undefined ? {} : { args: record.args }),
      meta: record.meta,
      options: record.options,
      ...(record.base ? { base: record.base } : {}),
      ...(record.approval ? { approval: record.approval } : {}),
      ...(record.savedWorkflow ? { savedWorkflow: record.savedWorkflow } : {}),
      ...(record.acknowledgedAt ? { acknowledgedAt: record.acknowledgedAt } : {}),
      ...(record.resumedFrom ? { resumedFrom: record.resumedFrom } : {}),
      stages: record.phases,
      phases: record.phases,
      journal: record.journal,
      createdAt: record.startedAt,
      updatedAt: record.updatedAt,
      migratedFrom: "dynamic-workflow-runs-v1",
    };
    await writeJsonFileAtomic(this.metadataPath(record.ref), metadata);
    await writeFile(this.scriptPath(record.ref), record.script, "utf8");
    await writeFile(this.eventsPath(record.ref), "", "utf8");
    await this.appendEvent(record.ref, {
      type: "run_started",
      nodeId: "run",
      nodeKind: "run",
      label: record.meta.name,
      meta: record.meta,
      timestamp: record.startedAt,
    });
    for (const phase of record.phases) {
      await this.appendEvent(record.ref, {
        type: "phase_started",
        nodeId: `phase:${phase.title}`,
        parentId: "run",
        nodeKind: "phase",
        title: phase.title,
        phase: phase.title,
        phaseRun: phase,
        timestamp: phase.startedAt,
      });
      if (phase.status) {
        await this.appendEvent(record.ref, {
          type: "phase_finished",
          nodeId: `phase:${phase.title}`,
          nodeKind: "phase",
          title: phase.title,
          phase: phase.title,
          phaseRun: phase,
          status:
            phase.status === "fail" ? "failed" : phase.status === "skip" ? "skipped" : "succeeded",
          timestamp: phase.finishedAt ?? record.updatedAt,
        });
      }
    }
    for (const entry of record.journal) {
      await this.appendEvent(record.ref, {
        type: "agent_succeeded",
        nodeId: `agent:${entry.index}`,
        nodeKind: "agent",
        index: entry.index,
        label: `agent ${entry.index + 1}`,
        result: entry.result,
        timestamp: record.updatedAt,
      });
    }
    if (record.status === "failed") {
      return this.appendEvent(record.ref, {
        type: "run_failed",
        nodeId: "run",
        nodeKind: "run",
        errorMessage: record.errorMessage ?? "workflow failed",
        timestamp: record.finishedAt ?? record.updatedAt,
      });
    }
    if (record.status === "succeeded") {
      return this.appendEvent(record.ref, {
        type: "run_succeeded",
        nodeId: "run",
        nodeKind: "run",
        result: record.result,
        timestamp: record.finishedAt ?? record.updatedAt,
      });
    }
    if (record.status === "paused") {
      return this.appendEvent(record.ref, {
        type: "run_paused",
        nodeId: "run",
        nodeKind: "run",
        timestamp: record.finishedAt ?? record.updatedAt,
      });
    }
    if (record.status === "stopped") {
      return this.appendEvent(record.ref, {
        type: "run_stopped",
        nodeId: "run",
        nodeKind: "run",
        timestamp: record.finishedAt ?? record.updatedAt,
      });
    }
    if (record.status === "stale") {
      return this.appendEvent(record.ref, {
        type: "run_stale",
        nodeId: "run",
        nodeKind: "run",
        timestamp: record.finishedAt ?? record.updatedAt,
      });
    }
    const snapshot = await this.compact(record.ref);
    if (!snapshot) throw new Error(`failed to migrate dynamic workflow run ${record.ref}`);
    return snapshot;
  }

  private async writeSnapshot(runRef: RunRef, snapshot: WorkflowRunSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.snapshotPath(runRef), {
      version: 2,
      runRef,
      updatedAt: snapshot.updatedAt ?? nowIso(),
      snapshot,
    } satisfies SparkDynamicWorkflowEventSnapshotFile);
  }

  private async touchMetadata(runRef: RunRef, updatedAt: string): Promise<void> {
    await this.updateMetadata(runRef, (metadata) => {
      metadata.updatedAt = updatedAt;
    });
  }

  private async updateMetadata(
    runRef: RunRef,
    updater: (metadata: SparkDynamicWorkflowEventRunMetadata, now: string) => void,
  ): Promise<void> {
    const raw = await this.getMetadata(runRef);
    if (!raw) return;
    const now = nowIso();
    const next: SparkDynamicWorkflowEventRunMetadata = { ...raw };
    updater(next, now);
    await writeJsonFileAtomic(this.metadataPath(runRef), next);
  }

  private async listRunRefs(): Promise<RunRef[]> {
    try {
      const entries = await readdir(this.runsDir(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
        .map((entry) => entry.name.replace(/^run-/u, "run:") as RunRef)
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  private runsDir(): string {
    return join(this.rootDir, "runs");
  }

  private runDir(runRef: RunRef): string {
    return join(this.runsDir(), runRef.replace(/^run:/u, "run-"));
  }

  private metadataPath(runRef: RunRef): string {
    return join(this.runDir(runRef), "run.json");
  }

  private eventsPath(runRef: RunRef): string {
    return join(this.runDir(runRef), "events.jsonl");
  }

  private snapshotPath(runRef: RunRef): string {
    return join(this.runDir(runRef), "snapshot.json");
  }

  private scriptPath(runRef: RunRef): string {
    return join(this.runDir(runRef), "script.js");
  }
}

export function dynamicWorkflowRecordFromEventRun(
  run: SparkDynamicWorkflowEventRunView,
  script: string,
): SparkDynamicWorkflowRunRecord {
  const agentNodes = run.snapshot.nodes.filter((node) => node.kind === "agent");
  const nodeTelemetry = agentNodes
    .map((node) => node.telemetry)
    .filter((telemetry): telemetry is SparkDynamicWorkflowAgentTelemetry => Boolean(telemetry));
  const agentTelemetry = mergeAgentTelemetry(run.metadata.agentTelemetry ?? [], nodeTelemetry);
  const usageTotals = run.metadata.usageTotals ?? aggregateWorkflowUsageTotals(agentTelemetry);
  const latestSpentTokens = [...agentTelemetry]
    .reverse()
    .find((telemetry) => telemetry.spentTokens !== undefined)?.spentTokens;
  return {
    ref: run.metadata.runRef,
    status: snapshotStatusToDynamicStatus(run.snapshot.status),
    source: run.metadata.source,
    script,
    scriptHash: run.metadata.scriptHash,
    ...(run.metadata.args === undefined ? {} : { args: run.metadata.args }),
    meta: run.snapshot.meta ?? run.metadata.meta,
    phases: run.metadata.stages ?? run.metadata.phases ?? stageRunsFromSnapshot(run.snapshot),
    journal:
      run.metadata.journal ??
      agentNodes.map((node, index) => ({
        index,
        hash: node.id,
        result: node.result,
      })),
    result: run.snapshot.result,
    errorMessage: run.snapshot.errorMessage,
    agentCount: agentNodes.length,
    spentTokens: run.metadata.spentTokens ?? latestSpentTokens,
    usageTotals,
    agentTelemetry,
    options: run.metadata.options,
    ...(run.metadata.base ? { base: run.metadata.base } : {}),
    ...(run.metadata.savedWorkflow ? { savedWorkflow: run.metadata.savedWorkflow } : {}),
    ...(run.metadata.approval ? { approval: run.metadata.approval } : {}),
    startedAt: run.snapshot.startedAt ?? run.metadata.createdAt,
    updatedAt: run.snapshot.updatedAt ?? run.metadata.updatedAt,
    ...(run.snapshot.finishedAt ? { finishedAt: run.snapshot.finishedAt } : {}),
    ...(run.metadata.acknowledgedAt ? { acknowledgedAt: run.metadata.acknowledgedAt } : {}),
    ...(run.metadata.resumedFrom ? { resumedFrom: run.metadata.resumedFrom } : {}),
  };
}

export function defaultSparkDynamicWorkflowEventStore(cwd: string): SparkDynamicWorkflowEventStore {
  return new SparkDynamicWorkflowEventStore(join(cwd, ".spark", "dynamic-workflows"));
}

function snapshotStatusToDynamicStatus(
  status: WorkflowRunSnapshot["status"],
): SparkDynamicWorkflowRunStatus {
  if (status === "queued") return "running";
  if (status === "cached" || status === "skipped") return "succeeded";
  return status;
}

function stageRunsFromSnapshot(snapshot: WorkflowRunSnapshot): WorkflowStageRun[] {
  return snapshot.nodes
    .filter((node) => node.kind === "stage" || node.kind === "phase")
    .map((node) => ({
      title: node.label,
      status: workflowNodeStatusToPhaseStatus(node.status),
      startedAt: node.startedAt ?? snapshot.startedAt ?? snapshot.updatedAt ?? nowIso(),
      finishedAt: node.finishedAt,
    }));
}

function workflowNodeStatusToPhaseStatus(status: string): WorkflowStageRun["status"] {
  if (status === "failed") return "fail";
  if (status === "skipped") return "skip";
  if (status === "succeeded") return "success";
  return undefined;
}

function mergeAgentTelemetry(
  metadataTelemetry: SparkDynamicWorkflowAgentTelemetry[],
  nodeTelemetry: SparkDynamicWorkflowAgentTelemetry[],
): SparkDynamicWorkflowAgentTelemetry[] {
  const merged = new Map<number, SparkDynamicWorkflowAgentTelemetry>();
  for (const telemetry of metadataTelemetry) merged.set(telemetry.index, telemetry);
  for (const telemetry of nodeTelemetry) {
    const current = merged.get(telemetry.index);
    if (!current || (!current.usage && telemetry.usage) || current.status === "running") {
      merged.set(telemetry.index, telemetry);
    }
  }
  return [...merged.values()].sort((a, b) => a.index - b.index);
}

function addUsageToTotals(
  totals: SparkDynamicWorkflowUsageTotals | undefined,
  usage: NonNullable<WorkflowAgentTelemetry["usage"]>,
): SparkDynamicWorkflowUsageTotals {
  const next: SparkDynamicWorkflowUsageTotals = {
    actualTokens: totals?.actualTokens ?? 0,
    estimatedTokens: totals?.estimatedTokens ?? 0,
    totalTokens: totals?.totalTokens ?? 0,
    ...(totals?.inputTokens !== undefined ? { inputTokens: totals.inputTokens } : {}),
    ...(totals?.outputTokens !== undefined ? { outputTokens: totals.outputTokens } : {}),
    ...(totals?.cacheReadTokens !== undefined ? { cacheReadTokens: totals.cacheReadTokens } : {}),
    ...(totals?.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: totals.cacheWriteTokens }
      : {}),
    ...(totals?.costUsd !== undefined ? { costUsd: totals.costUsd } : {}),
  };
  if (usage.source === "estimated") next.estimatedTokens += usage.totalTokens;
  else next.actualTokens += usage.totalTokens;
  next.totalTokens += usage.totalTokens;
  if (usage.inputTokens !== undefined)
    next.inputTokens = (next.inputTokens ?? 0) + usage.inputTokens;
  if (usage.outputTokens !== undefined)
    next.outputTokens = (next.outputTokens ?? 0) + usage.outputTokens;
  if (usage.cacheReadTokens !== undefined)
    next.cacheReadTokens = (next.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined)
    next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  if (usage.costUsd !== undefined) next.costUsd = (next.costUsd ?? 0) + usage.costUsd;
  return next;
}

function aggregateWorkflowUsageTotals(
  telemetry: SparkDynamicWorkflowAgentTelemetry[],
): SparkDynamicWorkflowUsageTotals | undefined {
  if (telemetry.length === 0) return undefined;
  let actualTokens = 0;
  let estimatedTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  let hasCost = false;
  let hasUsage = false;
  for (const item of telemetry) {
    const usage = item.usage;
    if (!usage) continue;
    hasUsage = true;
    if (usage.source === "estimated") estimatedTokens += usage.totalTokens;
    else actualTokens += usage.totalTokens;
    if (usage.inputTokens !== undefined) {
      inputTokens += usage.inputTokens;
      hasInput = true;
    }
    if (usage.outputTokens !== undefined) {
      outputTokens += usage.outputTokens;
      hasOutput = true;
    }
    if (usage.cacheReadTokens !== undefined) {
      cacheReadTokens += usage.cacheReadTokens;
      hasCacheRead = true;
    }
    if (usage.cacheWriteTokens !== undefined) {
      cacheWriteTokens += usage.cacheWriteTokens;
      hasCacheWrite = true;
    }
    if (usage.costUsd !== undefined) {
      costUsd += usage.costUsd;
      hasCost = true;
    }
  }
  if (!hasUsage) return undefined;
  const totalTokens = actualTokens + estimatedTokens;
  return {
    actualTokens,
    estimatedTokens,
    totalTokens,
    ...(hasInput ? { inputTokens } : {}),
    ...(hasOutput ? { outputTokens } : {}),
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
    ...(hasCost ? { costUsd } : {}),
  };
}

function isAcknowledgeableDynamicWorkflowRun(run: SparkDynamicWorkflowRunRecord): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "stale" ||
    run.status === "stopped"
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : (JSON.stringify(error) ?? String(error));
}

function normalizeWorkflowId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "workflow"
  );
}

async function nextAvailableWorkflowPath(
  dir: string,
  workflowId: string,
): Promise<{ path: string; savedId: string }> {
  for (let index = 0; index < 1000; index += 1) {
    const savedId = index === 0 ? workflowId : `${workflowId}-${index + 1}`;
    const path = join(dir, `${savedId}.js`);
    if (!(await pathExists(path))) return { path, savedId };
  }
  throw new Error(`dynamic workflow save could not find available id for ${workflowId}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}
