import { Type } from "typebox";
import { defaultSparkDagRunStore } from "spark-orchestrator";
import { killActiveSparkRoleRunProcesses } from "spark-runtime";
import type { RunRef } from "spark-core";
import { loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import { appendSparkDagRunPruneLines } from "./state-housekeeping-rendering.ts";
import { appendSparkDagStatusLines } from "./spark-dag-status-rendering.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

type SparkDagManagerAction =
  | "status"
  | "reconcile"
  | "ack"
  | "clear_inactive"
  | "prune"
  | "kill_active";
const SPARK_DAG_MANAGER_ACTIONS = [
  "status",
  "reconcile",
  "ack",
  "clear_inactive",
  "prune",
  "kill_active",
] as const;

export function normalizeSparkDagManagerAction(value: unknown): SparkDagManagerAction {
  if (value === undefined || value === null) return "status";
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "spark_dag_manager action must be status, reconcile, ack, clear_inactive, prune, or kill_active",
    );
  }
  const normalized = value.trim();
  if (!(SPARK_DAG_MANAGER_ACTIONS as readonly string[]).includes(normalized)) {
    throw new Error(
      "spark_dag_manager action must be status, reconcile, ack, clear_inactive, prune, or kill_active",
    );
  }
  return normalized as SparkDagManagerAction;
}

export function normalizeSparkDagManagerRunRef(value: unknown): RunRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error("spark_dag_manager runRef must be a run: ref");
  const normalized = value.trim();
  if (!normalized.startsWith("run:"))
    throw new Error("spark_dag_manager runRef must be a run: ref");
  return normalized as RunRef;
}

export function normalizeSparkDagManagerBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeSparkDagManagerNonNegativeInteger(
  value: unknown,
  fallback: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export function registerSparkDagManagerTool(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "spark_dag_manager",
    label: "Spark Workflow Run Debug",
    description:
      "Low-level persisted Spark workflow-run compatibility/debug surface. Prefer spark_background_runs status/inspect/kill and spark_state prune for normal user-facing background work; kill_active targets child role-run processes, and timed_out is a legacy problem record.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | reconcile | ack | prune | clear_inactive | kill_active. Prefer spark_background_runs for user-facing background inspection and spark_state prune for retention.",
        }),
      ),
      runRef: Type.Optional(
        Type.String({
          description:
            "Optional workflow run ref for ack, or child run ref filter for kill_active.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          default: true,
          description: "For action=prune, preview deletions without writing by default.",
        }),
      ),
      olderThanDays: Type.Optional(
        Type.Number({
          default: 30,
          description:
            "For action=prune, only old terminal workflow runs older than this age are candidates.",
        }),
      ),
      keepRecent: Type.Optional(
        Type.Number({
          default: 10,
          description: "For action=prune, retain this many newest terminal workflow runs globally.",
        }),
      ),
      keepRecentPerProject: Type.Optional(
        Type.Number({
          default: 10,
          description:
            "For action=prune, retain this many newest terminal workflow runs per project.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      const dagRunStore = defaultSparkDagRunStore(cwd);
      const action = normalizeSparkDagManagerAction(params.action);
      const runRef = normalizeSparkDagManagerRunRef(params.runRef);
      const dryRun = normalizeSparkDagManagerBoolean(
        (params as { dryRun?: unknown }).dryRun,
        true,
        "spark_dag_manager dryRun",
      );
      const olderThanDays = normalizeSparkDagManagerNonNegativeInteger(
        (params as { olderThanDays?: unknown }).olderThanDays,
        30,
        "spark_dag_manager olderThanDays",
      );
      const keepRecent = normalizeSparkDagManagerNonNegativeInteger(
        (params as { keepRecent?: unknown }).keepRecent,
        10,
        "spark_dag_manager keepRecent",
      );
      const keepRecentPerProject = normalizeSparkDagManagerNonNegativeInteger(
        (params as { keepRecentPerProject?: unknown }).keepRecentPerProject,
        10,
        "spark_dag_manager keepRecentPerProject",
      );
      let killed: Awaited<ReturnType<typeof killActiveSparkRoleRunProcesses>> = [];
      let acknowledged: Awaited<ReturnType<typeof dagRunStore.acknowledgeFailures>> | undefined;
      if (action === "kill_active") {
        const scopedRunRefs = activeSparkRoleRunProcessesForCwd(cwd)
          .filter((process) => !runRef || process.runRef === runRef)
          .map((process) => process.runRef);
        killed =
          scopedRunRefs.length > 0
            ? await killActiveSparkRoleRunProcesses({ runRefs: scopedRunRefs })
            : [];
      }
      if (
        action === "reconcile" ||
        action === "status" ||
        action === "kill_active" ||
        action === "ack"
      ) {
        await dagRunStore.reconcile({
          graph: graph ?? undefined,
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
      }
      if (action === "ack") {
        acknowledged = await dagRunStore.acknowledgeFailures({
          runRef,
          sessionId: sparkSessionOwnerKey(ctx),
        });
      }
      let prune: Awaited<ReturnType<typeof dagRunStore.pruneRuns>> | undefined;
      if (action === "prune") {
        prune = await dagRunStore.pruneRuns({
          dryRun,
          olderThanDays,
          keepRecent,
          keepRecentPerProject,
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
      }
      if (action === "clear_inactive") await dagRunStore.clearInactiveRuns();
      const status = await dagRunStore.status({ limit: 10 });
      const lines = [
        `Spark workflow-run debug action=${action}`,
        "Low-level compatibility tool; prefer spark_background_runs status/inspect/kill for user-facing background work.",
      ];
      appendSparkDagStatusLines(lines, status);
      if (action === "ack" && acknowledged) {
        lines.push(
          `Acknowledged workflow problem runs: ${acknowledged.acknowledged.length} newly, ${acknowledged.alreadyAcknowledged.length} already, ${acknowledged.skipped.length} skipped, ${acknowledged.missing.length} missing`,
        );
      }
      if (action === "prune" && prune) appendSparkDagRunPruneLines(lines, prune);
      if (action === "kill_active")
        lines.push(`Killed active role-run processes: ${killed.length}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { action, dag: status, killed, acknowledged, prune },
      };
    },
  });
}
