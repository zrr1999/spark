import { Type } from "typebox";
import type { RunRef } from "@zendev-lab/pi-extension-api";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { killActiveSparkRoleRunProcesses } from "@zendev-lab/spark-runtime";
import {
  acknowledgeBackgroundWorkflowRuns,
  buildSparkBackgroundDetails,
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalRunRef,
  normalizeOptionalTaskSelector,
  normalizeOptionalProjectRef,
  normalizeSparkBackgroundBoolean,
  normalizeSparkBackgroundAction,
  reconcileSparkWorkflowRunsWithActiveProcesses,
  resolveBackgroundTaskRef,
} from "./background-runs.ts";
import { renderSparkBackgroundRunsText } from "./background-runs-rendering.ts";
import { appendSparkWorkflowRunPruneLines } from "./state-housekeeping-rendering.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkWorkflowRunsParams {
  action?: unknown;
  runRef?: unknown;
  taskRef?: unknown;
  projectRef?: unknown;
  includeHistory?: unknown;
  includeDetails?: unknown;
  signal?: unknown;
  forceAfterMs?: unknown;
  all?: unknown;
  dryRun?: unknown;
  olderThanDays?: unknown;
  keepRecent?: unknown;
  keepRecentPerProject?: unknown;
}

export function normalizeSparkWorkflowRunsAction(value: unknown) {
  return normalizeSparkBackgroundAction(value);
}

export function normalizeSparkWorkflowRunsRunRef(value: unknown): RunRef | undefined {
  return normalizeOptionalRunRef(value, "spark_workflow_runs runRef");
}

export function normalizeSparkWorkflowRunsBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  return normalizeSparkBackgroundBoolean(value, fallback, `spark_workflow_runs ${field}`);
}

export function normalizeSparkWorkflowRunsNonNegativeInteger(
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

export function registerSparkWorkflowRunsTool(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "spark_workflow_runs",
    label: "Spark Workflow Runs",
    description:
      "Inspect and control Spark background workflow runs: status/list/inspect active child role-runs, kill/reconcile/ack background work, and prune/clear retained terminal records. Compact summaries include transcript refs/tail metadata, task claims, pids, run refs, and next actions.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | list | inspect | kill | reconcile | ack | prune | clear_inactive | kill_active",
        }),
      ),
      runRef: Type.Optional(
        Type.String({
          description: "Workflow run ref or child role-run ref to inspect, kill, or ack.",
        }),
      ),
      taskRef: Type.Optional(
        Type.String({
          description: "Task ref, @name, bare task name, or exact title to inspect or kill.",
        }),
      ),
      projectRef: Type.Optional(
        Type.String({
          description: "Optional project filter; defaults to the current project for status/list.",
        }),
      ),
      includeHistory: Type.Optional(
        Type.Boolean({
          description: "Include acknowledged and terminal recent runs in list/status output.",
        }),
      ),
      includeDetails: Type.Optional(
        Type.Boolean({ description: "Expand task/run records in text output." }),
      ),
      signal: Type.Optional(Type.String({ description: "Kill only; default SIGTERM." })),
      forceAfterMs: Type.Optional(
        Type.Number({ description: "Kill only; delay before force-kill scheduling." }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Kill only; required to kill all active children when no runRef/taskRef is provided.",
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
            "For action=prune, only terminal workflow runs older than this age are candidates.",
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
      const p = params as SparkWorkflowRunsParams;
      const cwd = ctx.cwd;
      const action = normalizeSparkBackgroundAction(p.action);
      const includeHistory = normalizeSparkBackgroundBoolean(
        p.includeHistory,
        false,
        "spark_workflow_runs includeHistory",
      );
      const includeDetails = normalizeSparkBackgroundBoolean(
        p.includeDetails,
        false,
        "spark_workflow_runs includeDetails",
      );
      const all = normalizeSparkBackgroundBoolean(p.all, false, "spark_workflow_runs all");
      const requestedProjectRef = normalizeOptionalProjectRef(
        p.projectRef,
        "spark_workflow_runs projectRef",
      );
      const runRef = normalizeOptionalRunRef(p.runRef, "spark_workflow_runs runRef");
      const taskSelector = normalizeOptionalTaskSelector(p.taskRef, "spark_workflow_runs taskRef");
      const signal = normalizeKillSignal(p.signal, "spark_workflow_runs signal");
      const forceAfterMs = normalizeForceAfterMs(
        p.forceAfterMs,
        "spark_workflow_runs forceAfterMs",
      );
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        return {
          content: [
            { type: "text", text: "Spark workflow runs unavailable: no Spark task graph found." },
          ],
          details: { background: { error: "missing_task_graph" } },
        };
      }
      const runStore = defaultSparkWorkflowRunStore(cwd);
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const currentProjectRef = currentProject?.ref;
      const scopeProjectRef = requestedProjectRef ?? currentProjectRef;
      const taskRef = resolveBackgroundTaskRef(graph, taskSelector, scopeProjectRef);
      const control = await runStore.loadControl();
      const controlView =
        control && (!scopeProjectRef || control.projectRef === scopeProjectRef)
          ? {
              projectRef: control.projectRef,
              status: control.status,
              focus: control.focus,
              policy: {
                maxConcurrency: control.policy.maxConcurrency,
                foregroundTimeoutMs: control.policy.timeoutMs,
              },
            }
          : undefined;
      if (taskSelector && !taskRef) {
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory,
          targetRunRef: runRef,
        });
        return {
          content: [{ type: "text", text: `Spark background task not found: ${taskSelector}` }],
          details: { background: { ...background, error: "task_not_found", taskSelector } },
        };
      }
      if (action === "prune") {
        const prune = await runStore.pruneRuns({
          dryRun: normalizeSparkBackgroundBoolean(p.dryRun, true, "spark_workflow_runs dryRun"),
          olderThanDays: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.olderThanDays,
            30,
            "spark_workflow_runs olderThanDays",
          ),
          keepRecent: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.keepRecent,
            10,
            "spark_workflow_runs keepRecent",
          ),
          keepRecentPerProject: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.keepRecentPerProject,
            10,
            "spark_workflow_runs keepRecentPerProject",
          ),
          activeRunRefs: activeSparkRoleRunProcessesForCwd(cwd).map((process) => process.runRef),
        });
        const lines = [`Spark workflow-run prune action=prune`];
        appendSparkWorkflowRunPruneLines(lines, prune);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { prune },
        };
      }
      if (action === "clear_inactive") {
        await runStore.clearInactiveRuns();
        const background = await buildSparkBackgroundDetails({
          action: "status",
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
        });
        return {
          content: [
            { type: "text", text: renderSparkBackgroundRunsText(background, { includeDetails }) },
          ],
          details: { background },
        };
      }
      if (action === "kill_active") {
        const scopedRunRefs = activeSparkRoleRunProcessesForCwd(cwd)
          .filter((process) => !runRef || process.runRef === runRef)
          .map((process) => process.runRef);
        const killed =
          scopedRunRefs.length > 0
            ? await killActiveSparkRoleRunProcesses({
                runRefs: scopedRunRefs,
                signal,
                forceAfterMs,
                reason: "spark_workflow_runs kill_active",
              })
            : [];
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        const background = await buildSparkBackgroundDetails({
          action: "kill",
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: runRef,
          killed,
        });
        return {
          content: [
            { type: "text", text: renderSparkBackgroundRunsText(background, { includeDetails }) },
          ],
          details: { background },
        };
      }
      if (action === "status" || action === "list") {
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
      }
      if (action === "reconcile") {
        const before = await runStore.load();
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        const after = await runStore.load();
        const changed = after.runs.filter((run) => {
          const previous = before.runs.find((candidate) => candidate.ref === run.ref);
          return (
            previous && (previous.status !== run.status || previous.completed !== run.completed)
          );
        });
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        const text = `${renderSparkBackgroundRunsText(background, { includeDetails })}\nReconciled workflow records changed: ${changed.length}`;
        return {
          content: [{ type: "text", text }],
          details: { background, changedWorkflowRuns: changed },
        };
      }
      if (action === "kill") {
        if (!runRef && !taskRef && !all) {
          const background = await buildSparkBackgroundDetails({
            action,
            cwd,
            graph,
            runStore,
            currentProjectRef,
            projectRef: requestedProjectRef,
            control: controlView,
            includeHistory,
          });
          return {
            content: [
              {
                type: "text",
                text: "kill_requires_target: Provide runRef, taskRef, or all:true to kill background child role-runs.",
              },
            ],
            details: { background: { ...background, error: "kill_requires_target" } },
          };
        }
        const before = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        let targetRunRefs: RunRef[] = [];
        const workflowTarget = runRef
          ? before.runs.find((run) => run.runRef === runRef)
          : undefined;
        if (all && !runRef && !taskRef) {
          targetRunRefs = before.childRuns
            .filter((child) => child.activeProcess)
            .map((child) => child.runRef);
        } else if (workflowTarget) {
          targetRunRefs = before.childRuns
            .filter(
              (child) => child.activeProcess && child.workflowRunRef === workflowTarget.runRef,
            )
            .map((child) => child.runRef);
        } else {
          targetRunRefs = before.childRuns
            .filter(
              (child) =>
                child.activeProcess &&
                (!runRef || child.runRef === runRef) &&
                (!taskRef || child.taskRef === taskRef),
            )
            .map((child) => child.runRef);
          if (runRef && targetRunRefs.length === 0) targetRunRefs = [runRef];
        }
        const killed = await killActiveSparkRoleRunProcesses({
          runRefs: targetRunRefs,
          signal,
          forceAfterMs,
          reason: "spark_workflow_runs kill",
        });
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          killed,
        });
        return {
          content: [
            { type: "text", text: renderSparkBackgroundRunsText(background, { includeDetails }) },
          ],
          details: { background },
        };
      }
      if (action === "ack") {
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        const snapshot = await runStore.load();
        const acknowledged = await acknowledgeBackgroundWorkflowRuns({
          runStore,
          snapshot,
          sessionId: sparkSessionOwnerKey(ctx),
          projectRef: scopeProjectRef,
          runRef,
        });
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          acknowledged,
        });
        return {
          content: [
            { type: "text", text: renderSparkBackgroundRunsText(background, { includeDetails }) },
          ],
          details: { background },
        };
      }
      const background = await buildSparkBackgroundDetails({
        action,
        cwd,
        graph,
        runStore,
        currentProjectRef,
        projectRef: requestedProjectRef,
        control: controlView,
        includeHistory: includeHistory || action === "inspect",
        targetRunRef: runRef,
        targetTaskRef: taskRef,
      });
      return {
        content: [
          {
            type: "text",
            text: renderSparkBackgroundRunsText(background, {
              includeDetails: includeDetails || action === "inspect",
            }),
          },
        ],
        details: { background },
      };
    },
  });
}
