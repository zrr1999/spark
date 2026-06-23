import { Type } from "typebox";
import type { RunRef } from "@zendev-lab/pi-extension-api";
import { defaultArtifactStore, type JsonValue } from "@zendev-lab/pi-artifacts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import {
  killActiveSparkRoleRunProcesses,
  sendInputToActiveSparkRoleRunProcesses,
} from "@zendev-lab/spark-runtime";
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
import { appendRoleRunActivityEvent } from "./role-run-activity-events.ts";
import { renderSparkBackgroundRunsText } from "./background-runs-rendering.ts";
import { appendSparkWorkflowRunPruneLines } from "./state-housekeeping-rendering.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  defaultSparkDynamicWorkflowEventStore,
  type SparkDynamicWorkflowEventStore,
} from "./spark-dynamic-workflow-event-store.ts";
import { defaultSparkDynamicWorkflowManager } from "./spark-dynamic-workflow-manager.ts";
import type { SparkDynamicWorkflowRunRecord } from "./spark-dynamic-workflow-run-store.ts";
import {
  buildSparkDynamicWorkflowDashboardView,
  projectSparkDynamicWorkflowRuns,
  renderSparkDynamicWorkflowDashboardText,
  renderSparkDynamicWorkflowRunsText,
  selectSparkDynamicWorkflowRuns,
  type SparkDynamicWorkflowRunControlResult,
  type SparkDynamicWorkflowRunProjection,
} from "./spark-dynamic-workflow-run-rendering.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkWorkflowRunsParams {
  action?: unknown;
  runRef?: unknown;
  taskRef?: unknown;
  projectRef?: unknown;
  includeHistory?: unknown;
  signal?: unknown;
  forceAfterMs?: unknown;
  all?: unknown;
  message?: unknown;
  workflowId?: unknown;
  workflowScope?: unknown;
  dryRun?: unknown;
  olderThanDays?: unknown;
  keepRecent?: unknown;
  keepRecentPerProject?: unknown;
}

export function normalizeSparkWorkflowRunsAction(value: unknown) {
  return normalizeSparkBackgroundAction(value);
}

export function normalizeSparkWorkflowRunsRunRef(value: unknown): RunRef | undefined {
  return normalizeOptionalRunRef(value, "task_read run_status runRef");
}

export function normalizeSparkWorkflowRunsBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  return normalizeSparkBackgroundBoolean(value, fallback, `task_read run_status ${field}`);
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

function normalizeControlMessage(value: unknown, action: "reply" | "steer"): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`task_read run_status ${action} requires a non-empty message`);
  return value.trim();
}

function normalizeOptionalWorkflowId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error("task_read run_status workflowId must be a non-empty string");
  return value.trim();
}

function normalizeWorkflowSaveScope(value: unknown): "workspace" | "user" {
  if (value === undefined || value === null) return "workspace";
  if (value === "workspace" || value === "user") return value;
  throw new Error("task_read run_status workflowScope must be workspace or user");
}

function buildDynamicWorkflowRunDetails(input: {
  action: string;
  runs: SparkDynamicWorkflowRunRecord[];
  includeHistory: boolean;
  detailed: boolean;
  targetRunRef?: RunRef;
  control?: SparkDynamicWorkflowRunControlResult;
  projection?: SparkDynamicWorkflowRunProjection[];
}) {
  const runs = selectSparkDynamicWorkflowRuns({
    runs: input.runs,
    includeHistory: input.includeHistory,
    targetRunRef: input.targetRunRef,
  });
  return {
    text: renderSparkDynamicWorkflowRunsText({
      action: input.action,
      runs,
      detailed: input.detailed,
      control: input.control,
    }),
    details: {
      action: input.action,
      runs,
      projection: input.projection,
      selected: runs.map((run) => run.ref),
      control: input.control,
    },
  };
}

async function buildDynamicWorkflowRunDetailsFromStore(input: {
  store: SparkDynamicWorkflowEventStore;
  action: string;
  includeHistory: boolean;
  detailed: boolean;
  targetRunRef?: RunRef;
  control?: SparkDynamicWorkflowRunControlResult;
}) {
  const [snapshot, views] = await Promise.all([input.store.load(), input.store.listRuns()]);
  const legacy = buildDynamicWorkflowRunDetails({
    action: input.action,
    runs: snapshot.runs,
    includeHistory: input.includeHistory,
    detailed: input.detailed,
    targetRunRef: input.targetRunRef,
    control: input.control,
    projection: projectSparkDynamicWorkflowRuns({
      runs: views,
      includeHistory: input.includeHistory,
      targetRunRef: input.targetRunRef,
    }),
  });
  const dashboard = buildSparkDynamicWorkflowDashboardView({
    action: input.action,
    runs: views,
    includeHistory: input.includeHistory,
    detailed: input.detailed,
    targetRunRef: input.targetRunRef,
    control: input.control,
  });
  return {
    text: `${legacy.text}\n${renderSparkDynamicWorkflowDashboardText(dashboard)}`,
    details: { ...legacy.details, dashboard },
  };
}

export function registerSparkWorkflowRunsTool(
  registerSparkTool: SparkToolRegistrar,
  deps: { refreshSparkWidget?: (cwd: string, ctx: SparkToolContext) => Promise<void> } = {},
): void {
  registerSparkTool({
    name: "impl_workflow_runs",
    label: "Spark Workflow Runs",
    description:
      "Inspect and control Spark background workflow runs: status/list/inspect active child role-runs, kill/reply/steer/reconcile/ack background work, and prune/clear retained terminal records. Compact summaries include transcript refs/tail metadata, task claims, pids, run refs, and next actions.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | list | inspect | pause | resume | stop | restart | save | kill | reply | steer | reconcile | ack | prune | clear_inactive | kill_active",
        }),
      ),
      runRef: Type.Optional(
        Type.String({
          description: "Workflow run ref or child role-run ref to inspect, save, kill, or ack.",
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
      message: Type.Optional(
        Type.String({
          description:
            "reply/steer only; text to send to exactly one selected active background role-run stdin. Select with runRef or taskRef, or omit only when exactly one active child is visible.",
        }),
      ),
      workflowId: Type.Optional(
        Type.String({
          description:
            "save only; optional workflow id. Defaults to a normalized meta.name plus run hash prefix.",
        }),
      ),
      workflowScope: Type.Optional(
        Type.String({
          description: "save only; workspace (default) or user.",
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
        "task_read run_status includeHistory",
      );
      const detailed = action === "inspect";
      const all = normalizeSparkBackgroundBoolean(p.all, false, "task_read run_status all");
      const requestedProjectRef = normalizeOptionalProjectRef(
        p.projectRef,
        "task_read run_status projectRef",
      );
      const runRef = normalizeOptionalRunRef(p.runRef, "task_read run_status runRef");
      const taskSelector = normalizeOptionalTaskSelector(p.taskRef, "task_read run_status taskRef");
      const signal = normalizeKillSignal(p.signal, "task_read run_status signal");
      const forceAfterMs = normalizeForceAfterMs(
        p.forceAfterMs,
        "task_read run_status forceAfterMs",
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
      const dynamicRunStore = defaultSparkDynamicWorkflowEventStore(cwd);
      await dynamicRunStore.reconcileStale();
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
      if (
        action === "pause" ||
        action === "resume" ||
        action === "stop" ||
        action === "restart" ||
        action === "save"
      ) {
        if (!runRef) {
          const dynamicWorkflowRuns = await buildDynamicWorkflowRunDetailsFromStore({
            store: dynamicRunStore,
            action,
            includeHistory: true,
            detailed: false,
          });
          return {
            content: [
              {
                type: "text",
                text: `dynamic_workflow_control_requires_runRef: Provide runRef for ${action}.\n${dynamicWorkflowRuns.text}`,
              },
            ],
            details: {
              dynamicWorkflowRuns: { ...dynamicWorkflowRuns.details, error: "missing_runRef" },
            },
          };
        }
        const existingDynamicRun = await dynamicRunStore.get(runRef);
        const savedWorkflow =
          existingDynamicRun && action === "save"
            ? await dynamicRunStore.saveAsWorkflow({
                cwd,
                runRef,
                workflowId: normalizeOptionalWorkflowId(p.workflowId),
                scope: normalizeWorkflowSaveScope(p.workflowScope),
              })
            : undefined;
        const dynamicManager = defaultSparkDynamicWorkflowManager();
        const updated = existingDynamicRun
          ? action === "pause"
            ? await dynamicManager.pause(dynamicRunStore, runRef)
            : action === "resume"
              ? await dynamicManager.resume(dynamicRunStore, runRef)
              : action === "stop"
                ? await dynamicManager.stop(dynamicRunStore, runRef)
                : action === "restart"
                  ? await dynamicManager.restart(dynamicRunStore, runRef)
                  : await dynamicRunStore.get(runRef)
          : undefined;
        const control: SparkDynamicWorkflowRunControlResult = updated
          ? savedWorkflow
            ? { action, run: updated, savedWorkflow }
            : { action, run: updated }
          : { action, missing: runRef };
        const dynamicWorkflowRuns = await buildDynamicWorkflowRunDetailsFromStore({
          store: dynamicRunStore,
          action,
          includeHistory: true,
          detailed: true,
          targetRunRef: runRef,
          control,
        });
        return {
          content: [{ type: "text", text: dynamicWorkflowRuns.text }],
          details: { dynamicWorkflowRuns: dynamicWorkflowRuns.details },
        };
      }
      if (action === "prune") {
        const prune = await runStore.pruneRuns({
          dryRun: normalizeSparkBackgroundBoolean(p.dryRun, true, "task_read run_status dryRun"),
          olderThanDays: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.olderThanDays,
            30,
            "task_read run_status olderThanDays",
          ),
          keepRecent: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.keepRecent,
            10,
            "task_read run_status keepRecent",
          ),
          keepRecentPerProject: normalizeSparkWorkflowRunsNonNegativeInteger(
            p.keepRecentPerProject,
            10,
            "task_read run_status keepRecentPerProject",
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
            { type: "text", text: renderSparkBackgroundRunsText(background, { detailed }) },
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
                reason: "task_read run_status kill_active",
              })
            : [];
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        await deps.refreshSparkWidget?.(cwd, ctx);
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
            { type: "text", text: renderSparkBackgroundRunsText(background, { detailed }) },
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
        await dynamicRunStore.reconcileStale();
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
        const dynamicWorkflowRuns = await buildDynamicWorkflowRunDetailsFromStore({
          store: dynamicRunStore,
          action,
          includeHistory: true,
          detailed,
          targetRunRef: runRef,
        });
        const text = `${renderSparkBackgroundRunsText(background, { detailed })}\nReconciled workflow records changed: ${changed.length}\n${dynamicWorkflowRuns.text}`;
        return {
          content: [{ type: "text", text }],
          details: {
            background,
            changedWorkflowRuns: changed,
            dynamicWorkflowRuns: dynamicWorkflowRuns.details,
          },
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
          reason: "task_read run_status kill",
        });
        await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
        await deps.refreshSparkWidget?.(cwd, ctx);
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
            { type: "text", text: renderSparkBackgroundRunsText(background, { detailed }) },
          ],
          details: { background },
        };
      }
      if (action === "reply" || action === "steer") {
        const message = normalizeControlMessage(p.message, action);
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
        const activeTargets = before.childRuns.filter(
          (child) =>
            child.activeProcess &&
            (!runRef || child.runRef === runRef || child.workflowRunRef === runRef) &&
            (!taskRef || child.taskRef === taskRef),
        );
        if (activeTargets.length !== 1) {
          const error =
            activeTargets.length === 0
              ? "control_requires_active_target"
              : "control_target_ambiguous";
          const guidance =
            activeTargets.length === 0
              ? "No active background role-run process matched the selector. Inspect with action=inspect/list or wait for a visible active child before replying or steering."
              : "Multiple active background role-run processes matched. Provide runRef or taskRef for exactly one active child.";
          return {
            content: [{ type: "text", text: `${error}: ${guidance}` }],
            details: { background: { ...before, error }, activeTargets },
          };
        }
        const target = activeTargets[0]!;
        const now = new Date().toISOString();
        const sent = await sendInputToActiveSparkRoleRunProcesses({
          runRef: target.runRef,
          text: message,
        });
        const delivered = sent.some((entry) => entry.delivered);
        const sentSummary: Array<Record<string, string | number | boolean>> = sent.map((entry) => ({
          runRef: entry.runRef,
          roleRef: entry.roleRef,
          ...(entry.runName ? { runName: entry.runName } : {}),
          ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
          cwd: entry.cwd,
          startedAt: entry.startedAt,
          bytes: entry.bytes,
          delivered: entry.delivered,
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        }));
        const controlBody = JSON.parse(
          JSON.stringify({
            action,
            runRef: target.runRef,
            taskRef: target.taskRef,
            projectRef: target.taskRef ? graph.getTask(target.taskRef).projectRef : scopeProjectRef,
            roleRef: target.roleRef,
            runName: target.runName,
            ownerSessionId: target.ownerSessionId,
            message,
            sent: sentSummary,
            delivered,
            createdAt: now,
          }),
        ) as JsonValue;
        const artifact = await defaultArtifactStore(cwd).put({
          kind: "record",
          title: `Spark role-run ${action} control for ${target.runRef}`,
          format: "json",
          body: controlBody,
          provenance: {
            producer: "spark",
            projectRef: target.taskRef ? graph.getTask(target.taskRef).projectRef : scopeProjectRef,
            taskRef: target.taskRef,
            runRef: target.runRef,
          },
        });
        if (delivered) {
          if (action === "reply") {
            await appendRoleRunActivityEvent(cwd, {
              runRef: target.runRef,
              type: "waiting_for_user",
              at: now,
              message: "main session delivered a reply to this visible role-run",
              messageRole: "system",
              artifactRefs: [artifact.ref],
            });
          }
          await appendRoleRunActivityEvent(cwd, {
            runRef: target.runRef,
            type: action === "reply" ? "replied" : "message_activity",
            at: now,
            message,
            messageRole: "user",
            artifactRefs: [artifact.ref],
          });
        }
        await deps.refreshSparkWidget?.(cwd, ctx);
        const background = await buildSparkBackgroundDetails({
          action,
          cwd,
          graph,
          runStore,
          currentProjectRef,
          projectRef: requestedProjectRef,
          control: controlView,
          includeHistory: true,
          targetRunRef: target.runRef,
          targetTaskRef: target.taskRef,
        });
        const sendErrors = sent.flatMap((entry) =>
          entry.errorMessage ? [entry.errorMessage] : [],
        );
        const text = [
          `Spark background role-run ${action}: ${delivered ? "sent" : "not delivered"} to ${target.runRef}`,
          `Control artifact: ${artifact.ref}`,
          ...sendErrors.map((error) => `Error: ${error}`),
          renderSparkBackgroundRunsText(background, { detailed: false }),
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          details: { background, controlArtifactRef: artifact.ref, sent },
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
        const dynamicAck = await dynamicRunStore.acknowledge(runRef);
        const dynamicControl: SparkDynamicWorkflowRunControlResult = {
          action,
          acknowledgedRunRefs: dynamicAck.runRefs,
        };
        const dynamicWorkflowRuns = await buildDynamicWorkflowRunDetailsFromStore({
          store: dynamicRunStore,
          action,
          includeHistory: true,
          detailed: Boolean(runRef),
          targetRunRef: runRef,
          control: dynamicControl,
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
            {
              type: "text",
              text: `${renderSparkBackgroundRunsText(background, { detailed })}\n${dynamicWorkflowRuns.text}`,
            },
          ],
          details: { background, dynamicWorkflowRuns: dynamicWorkflowRuns.details },
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
      const dynamicWorkflowRuns = await buildDynamicWorkflowRunDetailsFromStore({
        store: dynamicRunStore,
        action,
        includeHistory: includeHistory || action === "inspect" || action === "list",
        detailed,
        targetRunRef: runRef,
      });
      return {
        content: [
          {
            type: "text",
            text: `${renderSparkBackgroundRunsText(background, {
              detailed,
            })}\n${dynamicWorkflowRuns.text}`,
          },
        ],
        details: { background, dynamicWorkflowRuns: dynamicWorkflowRuns.details },
      };
    },
  });
}
