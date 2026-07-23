import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  stableId,
  type TaskRef,
  type ProjectRef,
} from "@zendev-lab/spark-core";
import {
  type WorkflowRunCompletionFollowUp,
  type WorkflowRunControlStatus,
  type WorkflowRunStatus,
  runReadyTasks,
} from "@zendev-lab/spark-workflows";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import { reconcileSparkWorkflowRunsWithActiveProcesses } from "./background-runs.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { ensureRoleModelSettingsForProject } from "./role-model-settings.ts";
import { hasLocalSparkDirectory } from "./spark-activation.ts";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import { mergeTaskProgressIntoStore } from "./task-progress-store.ts";
import { sessionModelName } from "./session-model.ts";
import { createSparkRuntimeReadyTaskRunner } from "./spark-ready-task-runtime.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import {
  sparkDaemonDriverControl,
  type SparkDaemonDriverControl,
} from "./spark-daemon-driver-client.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export type SparkWorkflowRunManagerContext = SparkToolContext;

export interface SparkWorkflowRunManagerTickResult {
  continuePolling: boolean;
}

export class SparkWorkflowRunManagerController {
  private readonly hooks: {
    refreshSparkWidget: (cwd: string, ctx: SparkWorkflowRunManagerContext) => Promise<void>;
    piCommand?: (cwd: string, ctx: SparkWorkflowRunManagerContext) => string | undefined;
    driverControl: SparkDaemonDriverControl;
  };

  constructor(hooks: {
    refreshSparkWidget: (cwd: string, ctx: SparkWorkflowRunManagerContext) => Promise<void>;
    piCommand?: (cwd: string, ctx: SparkWorkflowRunManagerContext) => string | undefined;
    driverControl?: SparkDaemonDriverControl;
  }) {
    this.hooks = { ...hooks, driverControl: hooks.driverControl ?? sparkDaemonDriverControl };
  }

  async ensure(cwd: string, ctx: SparkWorkflowRunManagerContext): Promise<void> {
    if (!(await hasLocalSparkDirectory(cwd))) return;
    const control = await defaultSparkWorkflowRunStore(cwd).loadControl();
    if (!control || control.status !== "running") return;
    const ownerSessionId = ctx.sessionId?.trim();
    if (!ownerSessionId) throw new Error("Spark workflow driver requires a daemon-owned session");
    await this.hooks.driverControl.start({
      driverId: `workflow:${stableId(`${cwd}:${ownerSessionId}`)}`,
      kind: "workflow",
      ownerSessionId,
      continuity: "session",
      cwd,
      prompt: [
        "Advance the active Spark workflow scheduler by exactly one daemon-owned tick.",
        'Call workflow_driver({ action: "tick" }) exactly once.',
        "Do not wait, sleep, or run a frontend polling loop.",
      ].join("\n"),
      reason: "workflow scheduler active",
    });
  }

  async runOnce(
    cwd: string,
    ctx: SparkWorkflowRunManagerContext,
  ): Promise<SparkWorkflowRunManagerTickResult> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) return { continuePolling: false };
    const registry = await createSparkRoleRegistry(cwd);
    const artifactStore = defaultArtifactStore(cwd);
    const touched = new Set<TaskRef>();
    const runStore = defaultSparkWorkflowRunStore(cwd);
    const currentProject = await currentSparkProject(cwd, ctx, graph);
    const control = await runStore.loadControl();
    if (control && control.status !== "running") return { continuePolling: false };
    const readyBeforeReconcile = currentProject ? graph.readyTasks(currentProject.ref) : [];
    if (readyBeforeReconcile.length === 0) {
      const runStatus = await runStore.status();
      if (!runStatus.activeRun) {
        if (control && currentProject?.ref === control.projectRef)
          await runStore.updateControlStatus(
            terminalSparkRunControlStatus(graph, control.projectRef),
          );
        return { continuePolling: false };
      }
    }
    await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
    if (!currentProject) return { continuePolling: false };
    const readyTasks = graph.readyTasks(currentProject.ref);
    if (readyTasks.length === 0) {
      const runStatus = await runStore.status();
      if (runStatus.activeRun?.status === "running") return { continuePolling: true };
      if (control && currentProject.ref === control.projectRef)
        await runStore.updateControlStatus(
          terminalSparkRunControlStatus(graph, control.projectRef),
        );
      return { continuePolling: false };
    }
    const piCommand = this.hooks.piCommand?.(cwd, ctx) ?? "pi";
    const settingsResult = await ensureRoleModelSettingsForProject({
      graph,
      projectRef: currentProject.ref,
      registry,
      cwd,
      ctx,
      piCommand,
    });
    if (!settingsResult.ready) {
      if (control && currentProject.ref === control.projectRef)
        await runStore.updateControlStatus("blocked");
      ctx.ui?.notify?.(settingsResult.message, "warning");
      return { continuePolling: false };
    }
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const maxConcurrency = control?.policy.maxConcurrency ?? DEFAULT_READY_TASK_MAX_CONCURRENCY;
    const timeoutMs = control?.policy.timeoutMs ?? DEFAULT_READY_TASK_TIMEOUT_MS;
    const runtimeRunner = createSparkRuntimeReadyTaskRunner({
      registry,
      artifactStore,
      cwd,
      sessionModel: sessionModelName(ctx.model),
      roleExecutor: ctx.runRole,
    });
    const workflowRun = await runStore.startRun({
      projectRef: currentProject.ref,
      dryRun: false,
      maxConcurrency,
      timeoutMs,
      ownerSessionId,
    });
    let result: Awaited<ReturnType<typeof runReadyTasks>>;
    try {
      result = await runReadyTasks({
        graph,
        ...runtimeRunner,
        dryRun: false,
        maxConcurrency,
        timeoutMs,
        projectRef: currentProject.ref,
        claim: { sessionId: ownerSessionId },
        onSchedule: async (progress) => {
          touched.add(progress.taskRef);
          await runStore.recordSchedule(workflowRun.ref, progress);
          await mergeTaskProgressIntoStore(store, graph, [progress.taskRef]);
          await this.refreshSparkWidget(cwd, ctx);
        },
        onProgress: async (progress) => {
          touched.add(progress.taskRef);
          await runStore.recordProgress(workflowRun.ref, progress);
          await mergeTaskProgressIntoStore(store, graph, [progress.taskRef]);
          await this.refreshSparkWidget(cwd, ctx);
        },
      });
      if (touched.size > 0) {
        await mergeTaskProgressIntoStore(store, graph, [...touched]);
        await this.refreshSparkWidget(cwd, ctx);
      }
      const followUp = await runStore.finishRun(workflowRun.ref, result);
      if (
        control &&
        currentProject.ref === control.projectRef &&
        workflowResultTerminalForControl(result)
      )
        await runStore.updateControlStatus("blocked");
      emitSparkWorkflowRunCompletionFollowUp(ctx, followUp);
    } catch (error) {
      const followUp = await runStore.finishRun(
        workflowRun.ref,
        { scheduled: touched.size, completed: 0, timedOut: false },
        error,
      );
      if (control && currentProject.ref === control.projectRef)
        await runStore.updateControlStatus("failed");
      emitSparkWorkflowRunCompletionFollowUp(ctx, followUp);
      throw error;
    }
    return {
      continuePolling:
        !(
          control &&
          currentProject.ref === control.projectRef &&
          workflowResultTerminalForControl(result)
        ) &&
        (result.foregroundTimedOut || result.detached || result.completed < result.scheduled),
    };
  }

  private async refreshSparkWidget(
    cwd: string,
    ctx: SparkWorkflowRunManagerContext,
  ): Promise<void> {
    try {
      await this.hooks.refreshSparkWidget(cwd, ctx);
    } catch (error) {
      reportSparkWorkflowRunManagerRefreshError(ctx, error);
    }
  }
}

function terminalSparkRunControlStatus(
  graph: TaskGraph,
  projectRef: ProjectRef,
): WorkflowRunControlStatus {
  const unfinished = graph.tasks(projectRef).filter((task) => isUnfinishedTaskStatus(task.status));
  return unfinished.length === 0 ? "done" : "blocked";
}

function workflowResultTerminalForControl(result: {
  failed?: number;
  cancelled?: number;
}): boolean {
  return (result.failed ?? 0) > 0 || (result.cancelled ?? 0) > 0;
}

function emitSparkWorkflowRunCompletionFollowUp(
  ctx: SparkWorkflowRunManagerContext,
  followUp: WorkflowRunCompletionFollowUp | undefined,
): void {
  if (!followUp) return;
  const action = followUp.status === "succeeded" ? undefined : followUp.nextActions[0];
  ctx.ui?.notify?.(
    action ? `${followUp.summary} ${action}` : followUp.summary,
    sparkWorkflowRunCompletionNotificationLevel(followUp.status),
  );
}

function sparkWorkflowRunCompletionNotificationLevel(
  status: WorkflowRunStatus,
): "info" | "warning" | "error" {
  return status === "succeeded" ? "info" : status === "timed_out" ? "warning" : "error";
}

function reportSparkWorkflowRunManagerRefreshError(
  ctx: SparkWorkflowRunManagerContext,
  error: unknown,
): void {
  const message = `Spark widget refresh failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (ctx.ui?.notify) ctx.ui.notify(message, "warning");
  else console.warn(message);
}
