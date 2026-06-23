import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import {
  newRef,
  nowIso,
  readJsonFileOptional,
  type RunRef,
  writeJsonFileAtomic,
} from "@zendev-lab/pi-extension-api";
import { parseWorkflowScript } from "@zendev-lab/pi-workflows";
import type {
  WorkflowAgentTelemetry,
  WorkflowAgentTokenUsage,
  WorkflowJournalEntry,
  WorkflowMeta,
  WorkflowPhaseRun,
  WorkflowRunResult,
} from "@zendev-lab/pi-workflows";
import { userWorkflowDir, workspaceWorkflowDir } from "./spark-workflow-registry.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_DYNAMIC_WORKFLOW_STALE_AFTER_MS = 30 * 60 * 1_000;

/**
 * Legacy v1 dynamic workflow snapshot store.
 *
 * Production dynamic workflow execution, dashboard/status rendering, and controls use the v2
 * event-sourced store in spark-dynamic-workflow-event-store.ts. Keep this module for importing
 * pre-existing .spark/dynamic-workflow-runs.json state, migration tests, and compatibility type
 * definitions only.
 */

export type SparkDynamicWorkflowRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "stale"
  | "paused"
  | "stopped";
export type SparkDynamicWorkflowRunSourceKind = "inline" | "selector";

export interface SparkDynamicWorkflowRunSource {
  kind: SparkDynamicWorkflowRunSourceKind;
  label: string;
  selector?: string;
}

export interface SparkDynamicWorkflowRunBaseMetadata {
  baseRef?: string;
  baseState?: string;
  baseTree?: string;
  capturedAt: string;
}

export interface SparkDynamicWorkflowRunOptions {
  concurrency?: number;
  maxAgents?: number;
  tokenBudget?: number;
}

export type SparkDynamicWorkflowSaveScope = "workspace" | "user";

export interface SparkDynamicWorkflowRunSavedWorkflow {
  selector: string;
  path: string;
  savedAt: string;
  scope?: SparkDynamicWorkflowSaveScope;
}

export interface SparkDynamicWorkflowRunApproval {
  status: "approved";
  method: "dependency" | "reviewer" | "ui";
  requestedAt: string;
  approvedAt: string;
  reason?: string;
  summary: {
    required: true;
    scriptHash: string;
    source: string;
    workflowName: string;
    riskFlags: string[];
    resources: {
      concurrency?: number;
      maxAgents?: number;
      tokenBudget?: number;
      phaseCount: number;
      agentCallSites: number;
      timeoutMs: number[];
    };
    tools: string[];
    isolation: string[];
    base?: SparkDynamicWorkflowRunBaseMetadata;
  };
}

export interface SparkDynamicWorkflowUsageTotals {
  actualTokens: number;
  estimatedTokens: number;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface SparkDynamicWorkflowAgentTelemetry extends WorkflowAgentTelemetry {}

export interface SparkDynamicWorkflowRunRecord {
  ref: RunRef;
  status: SparkDynamicWorkflowRunStatus;
  source: SparkDynamicWorkflowRunSource;
  script: string;
  scriptHash: string;
  args?: unknown;
  meta: WorkflowMeta;
  phases: WorkflowPhaseRun[];
  journal: WorkflowJournalEntry[];
  result?: unknown;
  errorMessage?: string;
  agentCount: number;
  spentTokens?: number;
  usageTotals?: SparkDynamicWorkflowUsageTotals;
  agentTelemetry?: SparkDynamicWorkflowAgentTelemetry[];
  options: SparkDynamicWorkflowRunOptions;
  base?: SparkDynamicWorkflowRunBaseMetadata;
  savedWorkflow?: SparkDynamicWorkflowRunSavedWorkflow;
  approval?: SparkDynamicWorkflowRunApproval;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  resumedFrom?: RunRef;
}

export interface SparkDynamicWorkflowRunStoreSnapshot {
  version: 1;
  runs: SparkDynamicWorkflowRunRecord[];
}

export interface SparkDynamicWorkflowRunStartInput {
  source: SparkDynamicWorkflowRunSource;
  script: string;
  args?: unknown;
  meta: WorkflowMeta;
  options: SparkDynamicWorkflowRunOptions;
  base?: SparkDynamicWorkflowRunBaseMetadata;
  approval?: SparkDynamicWorkflowRunApproval;
  resumeRunRef?: RunRef;
  now?: string;
}

export interface SparkDynamicWorkflowRunReconcileInput {
  now?: string;
  staleAfterMs?: number;
}

export interface SparkDynamicWorkflowRunAckResult {
  runRefs: RunRef[];
  acknowledgedAt: string;
}

export interface SparkDynamicWorkflowRunSaveResult {
  runRef: RunRef;
  selector: string;
  path: string;
  savedAt: string;
  scope: SparkDynamicWorkflowSaveScope;
}

export class SparkDynamicWorkflowRunStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid dynamic workflow-run store: ${filePath}: ${message}`);
    this.name = "SparkDynamicWorkflowRunStoreFormatError";
    this.filePath = filePath;
  }
}

export class SparkDynamicWorkflowRunStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<SparkDynamicWorkflowRunStoreSnapshot> {
    const raw = await readJsonFileOptional(
      this.filePath,
      (path, message) => new SparkDynamicWorkflowRunStoreFormatError(path, message),
    );
    if (raw === undefined) return { version: 1, runs: [] };
    assertSparkDynamicWorkflowRunSnapshot(raw, this.filePath);
    return normalizeSparkDynamicWorkflowRunSnapshot(raw);
  }

  async get(runRef: RunRef): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    return (await this.load()).runs.find((run) => run.ref === runRef);
  }

  async start(input: SparkDynamicWorkflowRunStartInput): Promise<SparkDynamicWorkflowRunRecord> {
    const now = input.now ?? nowIso();
    const record: SparkDynamicWorkflowRunRecord = {
      ref: input.resumeRunRef ?? newRef("run"),
      status: "running",
      source: input.source,
      script: input.script,
      scriptHash: hashWorkflowScript(input.script),
      ...(input.args === undefined ? {} : { args: input.args }),
      meta: input.meta,
      phases: [],
      journal: [],
      agentCount: 0,
      agentTelemetry: [],
      options: input.options,
      ...(input.base ? { base: input.base } : {}),
      ...(input.approval ? { approval: input.approval } : {}),
      startedAt: now,
      updatedAt: now,
      ...(input.resumeRunRef ? { resumedFrom: input.resumeRunRef } : {}),
    };
    await this.updateSnapshot((snapshot) => {
      const index = snapshot.runs.findIndex((run) => run.ref === record.ref);
      if (index >= 0) {
        const previous = snapshot.runs[index]!;
        snapshot.runs[index] = {
          ...previous,
          ...record,
          journal: previous.journal,
          phases: previous.phases,
          result: undefined,
          errorMessage: undefined,
          finishedAt: undefined,
          acknowledgedAt: undefined,
          agentTelemetry: previous.agentTelemetry ?? record.agentTelemetry,
          usageTotals: previous.usageTotals,
          base: previous.base ?? record.base,
          approval: record.approval ?? previous.approval,
          startedAt: previous.startedAt,
          updatedAt: now,
        };
      } else {
        snapshot.runs.push(record);
      }
    });
    return (await this.get(record.ref)) ?? record;
  }

  async recordJournal(runRef: RunRef, entry: WorkflowJournalEntry): Promise<void> {
    await this.updateRun(runRef, (record) => {
      const next = record.journal.filter((candidate) => candidate.index !== entry.index);
      next.push(entry);
      next.sort((a, b) => a.index - b.index);
      record.journal = next;
      record.updatedAt = nowIso();
    });
  }

  async recordPhase(runRef: RunRef, phase: WorkflowPhaseRun): Promise<void> {
    await this.updateRun(runRef, (record) => {
      const index = record.phases.findIndex((candidate) => candidate.title === phase.title);
      if (index >= 0) record.phases[index] = phase;
      else record.phases.push(phase);
      record.updatedAt = nowIso();
    });
  }

  async recordTokenUsage(runRef: RunRef, spentTokens: number): Promise<void> {
    await this.updateRun(runRef, (record) => {
      record.spentTokens = spentTokens;
      record.updatedAt = nowIso();
    });
  }

  async recordAgentTelemetry(runRef: RunRef, telemetry: WorkflowAgentTelemetry): Promise<void> {
    await this.updateRun(runRef, (record) => {
      const next = [...(record.agentTelemetry ?? [])].filter(
        (candidate) => candidate.index !== telemetry.index,
      );
      next.push(cloneAgentTelemetry(telemetry));
      next.sort((a, b) => a.index - b.index);
      record.agentTelemetry = next;
      if (telemetry.spentTokens !== undefined) record.spentTokens = telemetry.spentTokens;
      record.usageTotals = aggregateWorkflowUsageTotals(next);
      record.updatedAt = nowIso();
    });
  }

  async finish(
    runRef: RunRef,
    result: WorkflowRunResult,
    error?: unknown,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    let updated: SparkDynamicWorkflowRunRecord | undefined;
    const now = nowIso();
    await this.updateRun(runRef, (record) => {
      record.status = error ? "failed" : "succeeded";
      record.phases = result.phases;
      record.journal = result.journal;
      record.result = error ? undefined : result.result;
      record.errorMessage = error ? errorMessage(error) : undefined;
      record.agentCount = result.agentCount;
      record.usageTotals = aggregateWorkflowUsageTotals(record.agentTelemetry ?? []);
      record.finishedAt = now;
      record.updatedAt = now;
      updated = { ...record, phases: [...record.phases], journal: [...record.journal] };
    });
    return updated;
  }

  async fail(runRef: RunRef, error: unknown): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    let updated: SparkDynamicWorkflowRunRecord | undefined;
    const now = nowIso();
    await this.updateRun(runRef, (record) => {
      record.status = "failed";
      record.errorMessage = errorMessage(error);
      record.finishedAt = now;
      record.updatedAt = now;
      updated = cloneRun(record);
    });
    return updated;
  }

  async pause(runRef: RunRef, reason = "paused by workflow control") {
    return this.controlRun(runRef, (record, now) => {
      record.status = "paused";
      record.errorMessage = reason;
      record.finishedAt = now;
    });
  }

  async resume(runRef: RunRef) {
    return this.controlRun(runRef, (record) => {
      record.status = "running";
      record.errorMessage = undefined;
      record.finishedAt = undefined;
      record.acknowledgedAt = undefined;
    });
  }

  async stop(runRef: RunRef, reason = "stopped by workflow control") {
    return this.controlRun(runRef, (record, now) => {
      record.status = "stopped";
      record.errorMessage = reason;
      record.finishedAt = now;
    });
  }

  async acknowledge(runRef?: RunRef): Promise<SparkDynamicWorkflowRunAckResult> {
    const acknowledgedAt = nowIso();
    const acknowledged: RunRef[] = [];
    await this.updateSnapshot((snapshot) => {
      for (const record of snapshot.runs) {
        if (runRef && record.ref !== runRef) continue;
        if (!isAcknowledgeableDynamicWorkflowRun(record)) continue;
        record.acknowledgedAt = acknowledgedAt;
        record.updatedAt = acknowledgedAt;
        acknowledged.push(record.ref);
      }
    });
    return { runRefs: acknowledged, acknowledgedAt };
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
    scope?: SparkDynamicWorkflowSaveScope;
  }): Promise<SparkDynamicWorkflowRunSaveResult | undefined> {
    const record = await this.get(input.runRef);
    if (!record) return undefined;
    parseWorkflowScript(record.script);
    const savedAt = nowIso();
    const scope: SparkDynamicWorkflowSaveScope = input.scope ?? "workspace";
    const workflowId = normalizeWorkspaceWorkflowId(
      input.workflowId ?? `${record.meta.name}-${input.runRef.replace(/^run:/u, "").slice(0, 8)}`,
    );
    const dir = scope === "user" ? userWorkflowDir() : workspaceWorkflowDir(input.cwd);
    const filePath = await nextAvailableWorkflowPath(dir, workflowId);
    const savedId = filePath.savedId;
    await mkdir(dirname(filePath.path), { recursive: true });
    await writeFile(
      filePath.path,
      record.script.endsWith("\n") ? record.script : `${record.script}\n`,
      "utf8",
    );
    const savedWorkflow: SparkDynamicWorkflowRunSavedWorkflow = {
      selector: `${scope}:${savedId}`,
      path: scope === "workspace" ? relative(input.cwd, filePath.path) : filePath.path,
      savedAt,
      scope,
    };
    await this.updateRun(input.runRef, (current) => {
      current.savedWorkflow = savedWorkflow;
      current.updatedAt = savedAt;
    });
    return {
      runRef: input.runRef,
      selector: savedWorkflow.selector,
      path: savedWorkflow.path,
      savedAt: savedWorkflow.savedAt,
      scope,
    };
  }

  async restart(runRef: RunRef) {
    return this.controlRun(runRef, (record) => {
      record.status = "running";
      record.result = undefined;
      record.errorMessage = undefined;
      record.finishedAt = undefined;
      record.acknowledgedAt = undefined;
      record.agentCount = 0;
      record.spentTokens = undefined;
      record.usageTotals = undefined;
      record.agentTelemetry = [];
      record.phases = [];
      record.journal = [];
    });
  }

  async reconcileStale(
    input: SparkDynamicWorkflowRunReconcileInput = {},
  ): Promise<SparkDynamicWorkflowRunStoreSnapshot> {
    const now = input.now ?? nowIso();
    const staleAfterMs = input.staleAfterMs ?? DEFAULT_DYNAMIC_WORKFLOW_STALE_AFTER_MS;
    const nowMs = Date.parse(now);
    let reconciled: SparkDynamicWorkflowRunStoreSnapshot | undefined;
    await this.updateSnapshot((snapshot) => {
      for (const record of snapshot.runs) {
        if (record.status !== "running") continue;
        const updatedMs = Date.parse(record.updatedAt);
        if (!Number.isFinite(nowMs) || !Number.isFinite(updatedMs)) continue;
        if (nowMs - updatedMs < staleAfterMs) continue;
        record.status = "stale";
        record.errorMessage = `dynamic workflow run became stale after ${staleAfterMs}ms without progress`;
        record.finishedAt = now;
        record.updatedAt = now;
      }
      reconciled = cloneSnapshot(snapshot);
    });
    return reconciled ?? (await this.load());
  }

  private async controlRun(
    runRef: RunRef,
    updater: (record: SparkDynamicWorkflowRunRecord, now: string) => void,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    let updated: SparkDynamicWorkflowRunRecord | undefined;
    const now = nowIso();
    await this.updateRun(runRef, (record) => {
      updater(record, now);
      record.updatedAt = now;
      updated = cloneRun(record);
    });
    return updated;
  }

  private async updateRun(
    runRef: RunRef,
    updater: (record: SparkDynamicWorkflowRunRecord) => void,
  ): Promise<void> {
    await this.updateSnapshot((snapshot) => {
      const record = snapshot.runs.find((run) => run.ref === runRef);
      if (!record) throw new Error(`dynamic workflow run not found: ${runRef}`);
      updater(record);
    });
  }

  private async updateSnapshot(
    updater: (snapshot: SparkDynamicWorkflowRunStoreSnapshot) => void,
  ): Promise<void> {
    const snapshot = await this.load();
    updater(snapshot);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function sparkDynamicWorkflowRunStorePath(cwd: string): string {
  return join(cwd, ".spark", "dynamic-workflow-runs.json");
}

/** Legacy v1 import helper. Prefer defaultSparkDynamicWorkflowEventStore for active code. */
export function defaultSparkDynamicWorkflowRunStore(cwd: string): SparkDynamicWorkflowRunStore {
  return new SparkDynamicWorkflowRunStore(sparkDynamicWorkflowRunStorePath(cwd));
}

export function hashWorkflowScript(script: string): string {
  return createHash("sha256").update(script).digest("hex");
}

export async function captureSparkWorkflowBaseMetadata(
  cwd: string,
): Promise<SparkDynamicWorkflowRunBaseMetadata | undefined> {
  const baseRef = process.env.GRAFT_BASE_REF?.trim() || "HEAD";
  const [baseState, baseTree] = await Promise.all([
    gitRevParse(cwd, `${baseRef}^{commit}`),
    gitRevParse(cwd, `${baseRef}^{tree}`),
  ]);
  if (!process.env.GRAFT_BASE_REF && !baseState && !baseTree) return undefined;
  return {
    baseRef,
    ...(baseState ? { baseState } : {}),
    ...(baseTree ? { baseTree } : {}),
    capturedAt: nowIso(),
  };
}

async function gitRevParse(cwd: string, revision: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--verify", revision], {
      timeout: 2_000,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function assertSparkDynamicWorkflowRunSnapshot(
  value: unknown,
  filePath: string,
): asserts value is SparkDynamicWorkflowRunStoreSnapshot {
  if (!isRecord(value))
    throw new SparkDynamicWorkflowRunStoreFormatError(filePath, "root must be an object");
  if (value.version !== 1)
    throw new SparkDynamicWorkflowRunStoreFormatError(filePath, "version must be 1");
  if (!Array.isArray(value.runs))
    throw new SparkDynamicWorkflowRunStoreFormatError(filePath, "runs must be an array");
  for (const [index, run] of value.runs.entries())
    assertSparkDynamicWorkflowRunRecord(run, filePath, index);
}

function assertSparkDynamicWorkflowRunRecord(
  value: unknown,
  filePath: string,
  index: number,
): void {
  if (!isRecord(value))
    throw new SparkDynamicWorkflowRunStoreFormatError(filePath, `runs[${index}] must be an object`);
  if (typeof value.ref !== "string" || !value.ref)
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].ref must be a string`,
    );
  if (!isSparkDynamicWorkflowRunStatus(value.status))
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].status must be valid`,
    );
  if (!isRecord(value.source))
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].source must be an object`,
    );
  if (value.source.kind !== "inline" && value.source.kind !== "selector")
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].source.kind must be valid`,
    );
  if (typeof value.script !== "string")
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].script must be a string`,
    );
  if (typeof value.scriptHash !== "string")
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].scriptHash must be a string`,
    );
  if (!isRecord(value.meta))
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].meta must be an object`,
    );
  if (!Array.isArray(value.phases))
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].phases must be an array`,
    );
  if (!Array.isArray(value.journal))
    throw new SparkDynamicWorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].journal must be an array`,
    );
}

function normalizeSparkDynamicWorkflowRunSnapshot(
  snapshot: SparkDynamicWorkflowRunStoreSnapshot,
): SparkDynamicWorkflowRunStoreSnapshot {
  return {
    version: 1,
    runs: snapshot.runs.map((run) => ({
      ...run,
      phases: [...run.phases],
      journal: [...run.journal].sort((a, b) => a.index - b.index),
      agentCount: typeof run.agentCount === "number" ? run.agentCount : run.journal.length,
      agentTelemetry: normalizeAgentTelemetryArray(run.agentTelemetry),
      usageTotals:
        run.usageTotals ??
        aggregateWorkflowUsageTotals(normalizeAgentTelemetryArray(run.agentTelemetry)),
      options: run.options ?? {},
      approval: normalizeWorkflowApproval(run.approval),
    })),
  };
}

function cloneSnapshot(
  snapshot: SparkDynamicWorkflowRunStoreSnapshot,
): SparkDynamicWorkflowRunStoreSnapshot {
  return {
    version: 1,
    runs: snapshot.runs.map(cloneRun),
  };
}

function cloneRun(run: SparkDynamicWorkflowRunRecord): SparkDynamicWorkflowRunRecord {
  return {
    ...run,
    phases: [...run.phases],
    journal: [...run.journal],
    agentTelemetry: normalizeAgentTelemetryArray(run.agentTelemetry),
    usageTotals: run.usageTotals ? { ...run.usageTotals } : undefined,
    approval: normalizeWorkflowApproval(run.approval),
  };
}

function normalizeWorkflowApproval(value: unknown): SparkDynamicWorkflowRunApproval | undefined {
  if (!isRecord(value) || value.status !== "approved") return undefined;
  if (!isRecord(value.summary) || value.summary.required !== true) return undefined;
  const summary = value.summary;
  return {
    status: "approved",
    method:
      value.method === "reviewer" || value.method === "ui" || value.method === "dependency"
        ? value.method
        : "dependency",
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : nowIso(),
    approvedAt: typeof value.approvedAt === "string" ? value.approvedAt : nowIso(),
    ...(typeof value.reason === "string" && value.reason.trim()
      ? { reason: value.reason.trim() }
      : {}),
    summary: {
      required: true,
      scriptHash: typeof summary.scriptHash === "string" ? summary.scriptHash : "unknown",
      source: typeof summary.source === "string" ? summary.source : "unknown",
      workflowName: typeof summary.workflowName === "string" ? summary.workflowName : "workflow",
      riskFlags: stringArray(summary.riskFlags),
      resources: isRecord(summary.resources)
        ? {
            concurrency: numberField(summary.resources, "concurrency"),
            maxAgents: numberField(summary.resources, "maxAgents"),
            tokenBudget: numberField(summary.resources, "tokenBudget"),
            phaseCount: numberField(summary.resources, "phaseCount") ?? 0,
            agentCallSites: numberField(summary.resources, "agentCallSites") ?? 0,
            timeoutMs: numberArray(summary.resources.timeoutMs),
          }
        : { phaseCount: 0, agentCallSites: 0, timeoutMs: [] },
      tools: stringArray(summary.tools),
      isolation: stringArray(summary.isolation),
      ...(isRecord(summary.base)
        ? { base: summary.base as unknown as SparkDynamicWorkflowRunBaseMetadata }
        : {}),
    },
  };
}

function normalizeAgentTelemetryArray(value: unknown): SparkDynamicWorkflowAgentTelemetry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => cloneAgentTelemetry(entry as unknown as WorkflowAgentTelemetry))
    .sort((a, b) => a.index - b.index);
}

function cloneAgentTelemetry(
  telemetry: WorkflowAgentTelemetry,
): SparkDynamicWorkflowAgentTelemetry {
  return JSON.parse(JSON.stringify(telemetry)) as SparkDynamicWorkflowAgentTelemetry;
}

function aggregateWorkflowUsageTotals(
  telemetry: SparkDynamicWorkflowAgentTelemetry[],
): SparkDynamicWorkflowUsageTotals | undefined {
  const totals: SparkDynamicWorkflowUsageTotals = {
    actualTokens: 0,
    estimatedTokens: 0,
    totalTokens: 0,
  };
  let hasUsage = false;
  for (const item of telemetry) {
    if (!item.usage) continue;
    hasUsage = true;
    addUsage(totals, item.usage);
  }
  return hasUsage ? removeUndefinedTotals(totals) : undefined;
}

function addUsage(totals: SparkDynamicWorkflowUsageTotals, usage: WorkflowAgentTokenUsage): void {
  totals.totalTokens += usage.totalTokens;
  if (usage.source === "actual") totals.actualTokens += usage.totalTokens;
  else totals.estimatedTokens += usage.totalTokens;
  totals.inputTokens = addOptional(totals.inputTokens, usage.inputTokens);
  totals.outputTokens = addOptional(totals.outputTokens, usage.outputTokens);
  totals.cacheReadTokens = addOptional(totals.cacheReadTokens, usage.cacheReadTokens);
  totals.cacheWriteTokens = addOptional(totals.cacheWriteTokens, usage.cacheWriteTokens);
  totals.costUsd = addOptional(totals.costUsd, usage.costUsd);
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (right === undefined) return left;
  return (left ?? 0) + right;
}

function removeUndefinedTotals(
  totals: SparkDynamicWorkflowUsageTotals,
): SparkDynamicWorkflowUsageTotals {
  return Object.fromEntries(
    Object.entries(totals).filter((entry) => entry[1] !== undefined),
  ) as SparkDynamicWorkflowUsageTotals;
}

function isSparkDynamicWorkflowRunStatus(value: unknown): value is SparkDynamicWorkflowRunStatus {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "stale" ||
    value === "paused" ||
    value === "stopped"
  );
}

function isAcknowledgeableDynamicWorkflowRun(run: SparkDynamicWorkflowRunRecord): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "stale" ||
    run.status === "stopped"
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
  } catch {
    return false;
  }
}

function normalizeWorkspaceWorkflowId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!normalized) throw new Error("dynamic workflow save requires a non-empty workflow id");
  return normalized;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
