import { Type } from "typebox";
import type { RunRef } from "pi-extension-api";
import { defaultSparkDagRunStore } from "pi-workflows";
import { killActiveSparkRoleRunProcesses } from "spark-runtime";
import {
  acknowledgeBackgroundDagRuns,
  buildSparkBackgroundDetails,
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalRunRef,
  normalizeOptionalTaskSelector,
  normalizeOptionalProjectRef,
  normalizeSparkBackgroundBoolean,
  normalizeSparkBackgroundAction,
  reconcileSparkDagRunsWithActiveProcesses,
  resolveBackgroundTaskRef,
} from "./background-runs.ts";
import { renderSparkBackgroundRunsText } from "./background-runs-rendering.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkRunMode,
  sparkSessionOwnerKey,
} from "./session-state.ts";
import type { SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkBackgroundRunsParams {
  action?: unknown;
  runRef?: unknown;
  taskRef?: unknown;
  projectRef?: unknown;
  includeHistory?: unknown;
  includeDetails?: unknown;
  signal?: unknown;
  forceAfterMs?: unknown;
  all?: unknown;
}

export function registerSparkBackgroundRunsTool(registerSparkTool: SparkToolRegistrar): void {
  registerSparkTool({
    name: "spark_background_runs",
    label: "Spark Background Runs",
    description:
      "Inspect and control user-facing Spark background work: list/status/inspect/kill/reconcile/ack active child role-runs, compact summaries, transcript refs/tail metadata, task claims, pids, run refs, and next actions.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description: "status | list | inspect | kill | reconcile | ack",
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as SparkBackgroundRunsParams;
      const cwd = ctx.cwd;
      const action = normalizeSparkBackgroundAction(p.action);
      const includeHistory = normalizeSparkBackgroundBoolean(
        p.includeHistory,
        false,
        "spark_background_runs includeHistory",
      );
      const includeDetails = normalizeSparkBackgroundBoolean(
        p.includeDetails,
        false,
        "spark_background_runs includeDetails",
      );
      const all = normalizeSparkBackgroundBoolean(p.all, false, "spark_background_runs all");
      const requestedProjectRef = normalizeOptionalProjectRef(
        p.projectRef,
        "spark_background_runs projectRef",
      );
      const runRef = normalizeOptionalRunRef(p.runRef, "spark_background_runs runRef");
      const taskSelector = normalizeOptionalTaskSelector(
        p.taskRef,
        "spark_background_runs taskRef",
      );
      const signal = normalizeKillSignal(p.signal, "spark_background_runs signal");
      const forceAfterMs = normalizeForceAfterMs(
        p.forceAfterMs,
        "spark_background_runs forceAfterMs",
      );
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        return {
          content: [
            { type: "text", text: "Spark background runs unavailable: no Spark task graph found." },
          ],
          details: { background: { error: "missing_task_graph" } },
        };
      }
      const dagRunStore = defaultSparkDagRunStore(cwd);
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const currentProjectRef = currentProject?.ref;
      const scopeProjectRef = requestedProjectRef ?? currentProjectRef;
      const taskRef = resolveBackgroundTaskRef(graph, taskSelector, scopeProjectRef);
      const runMode = await loadSparkRunMode(cwd, ctx);
      if (taskSelector && !taskRef) {
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          runMode,
          includeHistory,
          targetRunRef: runRef,
        });
        return {
          content: [{ type: "text", text: `Spark background task not found: ${taskSelector}` }],
          details: { background: { ...background, error: "task_not_found", taskSelector } },
        };
      }
      if (action === "status" || action === "list") {
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
      }
      if (action === "reconcile") {
        const before = await dagRunStore.load();
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const after = await dagRunStore.load();
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
          dagRunStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        const text = `${renderSparkBackgroundRunsText(background, { includeDetails })}\nReconciled background records changed: ${changed.length}`;
        return {
          content: [{ type: "text", text }],
          details: { background, changedDagRuns: changed },
        };
      }
      if (action === "kill") {
        if (!runRef && !taskRef && !all) {
          const background = await buildSparkBackgroundDetails({
            action,
            cwd,
            graph,
            dagRunStore,
            currentProjectRef,
            projectRef: requestedProjectRef,
            runMode,
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
          dagRunStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
        });
        let targetRunRefs: RunRef[] = [];
        const dagTarget = runRef ? before.dagRuns.find((run) => run.runRef === runRef) : undefined;
        if (all && !runRef && !taskRef) {
          targetRunRefs = before.childRuns
            .filter((child) => child.activeProcess)
            .map((child) => child.runRef);
        } else if (dagTarget) {
          targetRunRefs = before.childRuns
            .filter((child) => child.activeProcess && child.dagRunRef === dagTarget.runRef)
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
          reason: "spark_background_runs kill",
        });
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          killed,
        });
        return {
          content: [
            {
              type: "text",
              text: renderSparkBackgroundRunsText(background, {
                includeDetails,
              }),
            },
          ],
          details: { background },
        };
      }
      if (action === "ack") {
        await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
        const snapshot = await dagRunStore.load();
        const acknowledged = await acknowledgeBackgroundDagRuns({
          dagRunStore,
          snapshot,
          sessionId: sparkSessionOwnerKey(ctx),
          projectRef: scopeProjectRef,
          runRef,
        });
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          dagRunStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          runMode,
          includeHistory: true,
          targetRunRef: runRef,
          targetTaskRef: taskRef,
          acknowledged,
        });
        return {
          content: [
            {
              type: "text",
              text: renderSparkBackgroundRunsText(background, {
                includeDetails,
              }),
            },
          ],
          details: { background },
        };
      }
      const background = await buildSparkBackgroundDetails({
        action,
        cwd,
        graph,
        dagRunStore,
        currentProjectRef,
        projectRef: requestedProjectRef,
        runMode,
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
