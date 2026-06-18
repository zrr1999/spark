import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import {
  SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
  collectRoleRunArtifactRetentionPlan,
} from "@zendev-lab/spark-runtime";
import {
  loadSparkGraph,
  sanitizeStoreScope,
  sparkSessionKey,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-state.ts";
import {
  normalizeArtifactBoolean,
  normalizeArtifactLimit,
  normalizePositiveInteger,
} from "./artifact-tools.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
  appendRoleRunArtifactRetentionLines,
  appendSparkWorkflowRunPruneLines,
  appendSparkStateCleanupPlanLines,
  appendSparkStateDiagnosticsLines,
  appendSparkStateHousekeepingLines,
} from "./state-housekeeping-rendering.ts";
import {
  SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
  collectSparkStateCleanupPlan,
  collectSparkStateDiagnostics,
  collectSparkStateHousekeeping,
  type SparkStateSessionScopes,
} from "./state-housekeeping.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { migrateStoreV2 } from "./store-v2-migration.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkStateToolDependencies {
  ensureSparkStateForActiveWorkspace: (cwd: string, ctx?: SparkToolContext) => Promise<unknown>;
}

type SparkStateAction =
  | "status"
  | "diagnostics"
  | "doctor"
  | "migrate-v2"
  | "cleanup"
  | "prune"
  | "compact-role-run-artifacts";

const SPARK_STATE_ACTIONS: SparkStateAction[] = [
  "status",
  "diagnostics",
  "doctor",
  "migrate-v2",
  "cleanup",
  "prune",
  "compact-role-run-artifacts",
];

export function normalizeSparkStateAction(value: unknown): SparkStateAction {
  if (value === undefined || value === null) return "status";
  if (SPARK_STATE_ACTIONS.includes(value as SparkStateAction)) return value as SparkStateAction;
  throw new Error(
    "action must be status, diagnostics, doctor, migrate-v2, cleanup, prune, or compact-role-run-artifacts",
  );
}

export function normalizeSparkStateOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (!value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function registerSparkStateTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkStateToolDependencies,
): void {
  registerSparkTool({
    name: "spark_state",
    label: "Spark State",
    description:
      "Inspect, migrate, or explicitly clean safe Spark session/cache state. action=status and action=diagnostics/doctor are read-only; action=migrate-v2 previews or applies explicit V2 legacy imports with backups; action=cleanup defaults to dryRun=true and never deletes protected stores such as project graph, TODO records, session state, artifacts, notes, role-reports, workflow-runs, or review indexes. action=compact-role-run-artifacts previews or applies historical role-run transcript blob replacement and defaults to dry-run.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | diagnostics | doctor | migrate-v2 | cleanup | prune | compact-role-run-artifacts. status summarizes cache/protected stores; diagnostics/doctor reports protected-store candidates read-only; migrate-v2 previews/applies explicit legacy imports with backups; cleanup previews or deletes safe cache files; prune previews or applies typed workflow-run retention; compact-role-run-artifacts previews/applies role-run transcript blob replacement.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          default: true,
          description:
            "Preview deletions without removing files. Defaults to true for cleanup, prune, and compact-role-run-artifacts.",
        }),
      ),
      olderThanDays: Type.Optional(
        Type.Number({
          default: 30,
          description: "Staleness cutoff for cleanup candidates. Defaults to 30 days.",
        }),
      ),
      includeBroken: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "Also treat malformed cache JSON as cleanup candidates. Defaults to false so broken files are reported but not deleted unless explicitly requested.",
        }),
      ),
      thresholdBytes: Type.Optional(
        Type.Number({
          default: SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
          description:
            "For action=compact-role-run-artifacts, only consider role-run blobs at or above this byte size.",
        }),
      ),
      tailBytes: Type.Optional(
        Type.Number({
          default: SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
          description:
            "For action=compact-role-run-artifacts, retain this many bytes of serialized transcript tail in replacement metadata.",
        }),
      ),
      exportDir: Type.Optional(
        Type.String({
          description:
            "For action=compact-role-run-artifacts apply, copy each full transcript blob to this directory before deleting the in-store blob.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          default: SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
          description:
            "For action=compact-role-run-artifacts, maximum candidate rows to render in text output.",
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
      const action = normalizeSparkStateAction((params as { action?: unknown }).action);
      const dryRun = normalizeArtifactBoolean(
        (params as { dryRun?: unknown }).dryRun,
        true,
        "dryRun",
      );
      const olderThanDays = normalizeArtifactLimit(
        (params as { olderThanDays?: unknown }).olderThanDays,
        30,
        "olderThanDays",
      );
      const keepRecent = normalizeArtifactLimit(
        (params as { keepRecent?: unknown }).keepRecent,
        10,
        "keepRecent",
      );
      const keepRecentPerProject = normalizeArtifactLimit(
        (params as { keepRecentPerProject?: unknown }).keepRecentPerProject,
        10,
        "keepRecentPerProject",
      );
      const thresholdBytes = normalizePositiveInteger(
        (params as { thresholdBytes?: unknown }).thresholdBytes,
        SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
        "thresholdBytes",
      );
      const tailBytes = normalizePositiveInteger(
        (params as { tailBytes?: unknown }).tailBytes,
        SPARK_ROLE_RUN_RETENTION_TAIL_BYTES,
        "tailBytes",
      );
      const exportDir = normalizeSparkStateOptionalString(
        (params as { exportDir?: unknown }).exportDir,
        "exportDir",
      );
      const limit = normalizeArtifactLimit(
        (params as { limit?: unknown }).limit,
        SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT,
        "limit",
      );
      const includeBroken = normalizeArtifactBoolean(
        (params as { includeBroken?: unknown }).includeBroken,
        false,
        "includeBroken",
      );
      await deps.ensureSparkStateForActiveWorkspace(cwd, ctx);
      if (action === "migrate-v2") {
        const migration = await migrateStoreV2(cwd, ctx, { dryRun });
        const lines = [`Spark store V2 migration ${dryRun ? "dry-run" : "apply"}:`];
        lines.push(`Actions: ${migration.actions.length}`);
        if (migration.backupDir) lines.push(`Backup: ${migration.backupDir}`);
        if (migration.legacyImportOnly.length)
          lines.push(`Legacy import-only: ${migration.legacyImportOnly.join(", ")}`);
        for (const item of migration.actions.slice(0, limit)) {
          const target = item.target ? ` -> ${item.target}` : "";
          const imported = item.imported === undefined ? "" : ` imported=${item.imported}`;
          const reason = item.reason ? ` (${item.reason})` : "";
          lines.push(
            `- ${item.status} ${item.kind}: ${item.path ?? ""}${target}${imported}${reason}`,
          );
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, migration },
        };
      }
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (action === "status") {
        const summary = await collectSparkStateHousekeeping(
          cwd,
          sparkStateSessionScopes(ctx),
          graph,
        );
        const lines = ["Spark state status:"];
        appendSparkStateHousekeepingLines(lines, summary);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, state: summary },
        };
      }
      if (action === "diagnostics" || action === "doctor") {
        const diagnostics = await collectSparkStateDiagnostics(cwd, graph);
        const lines = ["Spark state diagnostics (read-only):"];
        appendSparkStateDiagnosticsLines(lines, diagnostics);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, diagnostics },
        };
      }
      if (action === "prune") {
        const runStore = defaultSparkWorkflowRunStore(cwd);
        const prune = await runStore.pruneRuns({
          dryRun,
          olderThanDays,
          keepRecent,
          keepRecentPerProject,
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
        const lines = [`Spark workflow-run prune ${dryRun ? "dry-run" : "apply"}:`];
        appendSparkWorkflowRunPruneLines(lines, prune);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, prune },
        };
      }
      if (action === "compact-role-run-artifacts") {
        const retention = await collectRoleRunArtifactRetentionPlan(cwd, {
          dryRun,
          thresholdBytes,
          tailBytes,
          exportDir,
        });
        const lines = [
          `Spark role-run artifact retention ${dryRun ? "dry-run" : "apply"}: ${dryRun ? "would replace" : "replaced"} ${retention.candidates.length} large transcript blob(s).`,
        ];
        appendRoleRunArtifactRetentionLines(lines, retention, limit);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { found: true, action, retention },
        };
      }
      const plan = await collectSparkStateCleanupPlan(cwd, sparkStateSessionScopes(ctx), graph, {
        dryRun,
        olderThanDays,
        includeBroken,
      });
      if (!dryRun) {
        for (const candidate of plan.candidates)
          await rm(join(cwd, candidate.path), { force: true });
        plan.deleted = [...plan.candidates];
      }
      const lines: string[] = [];
      appendSparkStateCleanupPlanLines(lines, plan);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { found: true, action, cleanup: plan },
      };
    },
  });
}

export function sparkStateSessionScopes(ctx: SparkSessionContext): SparkStateSessionScopes {
  return {
    currentSessionScope: sanitizeStoreScope(sparkSessionKey(ctx)),
    currentOwnerScope: sanitizeStoreScope(sparkSessionOwnerKey(ctx)),
  };
}
