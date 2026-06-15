import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  type TaskRef,
  type ProjectRef,
} from "@zendev-lab/pi-extension-api";
import {
  type WorkflowRunCompletionFollowUp,
  type WorkflowRunStatus,
  runReadyTasks,
} from "@zendev-lab/pi-workflows";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  type TaskGraph,
} from "@zendev-lab/pi-tasks";
import { reconcileSparkDagRunsWithActiveProcesses } from "./background-runs.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { ensureRoleModelSettingsForProject } from "./role-model-settings.ts";
import { hasLocalSparkDirectory } from "./spark-activation.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkRunMode,
  sparkSessionOwnerKey,
  sparkTodoStore,
  updateSparkRunModeStatus,
  type SparkRunModeStatus,
} from "./session-state.ts";
import { mergeTaskProgressIntoStore } from "./task-progress-store.ts";
import { sessionModelName } from "./session-model.ts";
import { createSparkRuntimeReadyTaskRunner } from "./spark-ready-task-runtime.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

const DAG_MANAGER_POLL_INTERVAL_MS = 1_000;

export type SparkDagManagerContext = SparkToolContext;

interface SparkDagManagerTickResult {
  continuePolling: boolean;
}

export class SparkDagManagerController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hooks: {
    refreshSparkWidget: (cwd: string, ctx: SparkDagManagerContext) => Promise<void>;
  };

  constructor(hooks: {
    refreshSparkWidget: (cwd: string, ctx: SparkDagManagerContext) => Promise<void>;
  }) {
    this.hooks = hooks;
  }

  ensure(cwd: string, ctx: SparkDagManagerContext): void {
    if (this.timers.has(cwd)) return;
    const tick = async () => {
      this.timers.delete(cwd);
      if (!(await hasLocalSparkDirectory(cwd))) return;
      const result = await this.runOnce(cwd, ctx);
      const runMode = await loadSparkRunMode(cwd, ctx);
      if (result.continuePolling && (!runMode || runMode.status === "running")) {
        this.schedule(cwd, tick, DAG_MANAGER_POLL_INTERVAL_MS);
      }
    };
    this.schedule(cwd, tick, 0);
  }

  private schedule(cwd: string, tick: () => Promise<void>, delayMs: number): void {
    const timer = setTimeout(() => void tick().catch(reportSparkDagManagerError), delayMs);
    timer.unref?.();
    this.timers.set(cwd, timer);
  }

  async runOnce(cwd: string, ctx: SparkDagManagerContext): Promise<SparkDagManagerTickResult> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    if (!graph) return { continuePolling: false };
    const registry = await createSparkRoleRegistry(cwd);
    const artifactStore = defaultArtifactStore(cwd);
    const touched = new Set<TaskRef>();
    const dagRunStore = defaultSparkWorkflowRunStore(cwd);
    const currentProject = await currentSparkProject(cwd, ctx, graph);
    const runMode = await loadSparkRunMode(cwd, ctx);
    if (runMode && runMode.status !== "running") return { continuePolling: false };
    const readyBeforeReconcile = currentProject ? graph.readyTasks(currentProject.ref) : [];
    if (readyBeforeReconcile.length === 0) {
      const dagStatus = await dagRunStore.status();
      if (!dagStatus.activeRun) {
        if (runMode && currentProject?.ref === runMode.projectRef)
          await updateSparkRunModeStatus(
            cwd,
            ctx,
            terminalSparkRunModeStatus(graph, runMode.projectRef),
          );
        return { continuePolling: false };
      }
    }
    await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
    if (!currentProject) return { continuePolling: false };
    const readyTasks = graph.readyTasks(currentProject.ref);
    if (readyTasks.length === 0) {
      const dagStatus = await dagRunStore.status();
      if (dagStatus.activeRun?.status === "running") return { continuePolling: true };
      if (runMode && currentProject.ref === runMode.projectRef)
        await updateSparkRunModeStatus(
          cwd,
          ctx,
          terminalSparkRunModeStatus(graph, runMode.projectRef),
        );
      return { continuePolling: false };
    }
    const settingsResult = await ensureRoleModelSettingsForProject({
      graph,
      projectRef: currentProject.ref,
      registry,
      cwd,
      ctx,
    });
    if (!settingsResult.ready) {
      if (runMode && currentProject.ref === runMode.projectRef)
        await updateSparkRunModeStatus(cwd, ctx, "blocked");
      ctx.ui?.notify?.(settingsResult.message, "warning");
      return { continuePolling: false };
    }
    const ownerSessionId = sparkSessionOwnerKey(ctx);
    const maxConcurrency = runMode?.policy.maxConcurrency ?? DEFAULT_READY_TASK_MAX_CONCURRENCY;
    const timeoutMs = runMode?.policy.timeoutMs ?? DEFAULT_READY_TASK_TIMEOUT_MS;
    const runtimeRunner = createSparkRuntimeReadyTaskRunner({
      registry,
      artifactStore,
      cwd,
      sessionModel: sessionModelName(ctx.model),
    });
    const dagRun = await dagRunStore.startRun({
      projectRef: currentProject.ref,
      dryRun: false,
      maxConcurrency,
      timeoutMs,
      ownerSessionId,
    });
    const saveTaskTodosAfterMerge = async (current: TaskGraph) => {
      await sparkTodoStore(cwd, ctx).hydrate(current);
      await sparkTodoStore(cwd, ctx).save(current);
    };
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
          await dagRunStore.recordSchedule(dagRun.ref, progress);
          await mergeTaskProgressIntoStore(
            store,
            graph,
            [progress.taskRef],
            saveTaskTodosAfterMerge,
          );
          await this.refreshSparkWidget(cwd, ctx);
        },
        onProgress: async (progress) => {
          touched.add(progress.taskRef);
          await dagRunStore.recordProgress(dagRun.ref, progress);
          await mergeTaskProgressIntoStore(
            store,
            graph,
            [progress.taskRef],
            saveTaskTodosAfterMerge,
          );
          await this.refreshSparkWidget(cwd, ctx);
        },
      });
      if (touched.size > 0) {
        await mergeTaskProgressIntoStore(store, graph, [...touched], saveTaskTodosAfterMerge);
        await this.refreshSparkWidget(cwd, ctx);
      }
      const followUp = await dagRunStore.finishRun(dagRun.ref, result);
      if (
        runMode &&
        currentProject.ref === runMode.projectRef &&
        dagResultTerminalForRunMode(result)
      )
        await updateSparkRunModeStatus(cwd, ctx, "blocked");
      emitSparkDagCompletionFollowUp(ctx, followUp);
    } catch (error) {
      const followUp = await dagRunStore.finishRun(
        dagRun.ref,
        { scheduled: touched.size, completed: 0, timedOut: false },
        error,
      );
      if (runMode && currentProject.ref === runMode.projectRef)
        await updateSparkRunModeStatus(cwd, ctx, "failed");
      emitSparkDagCompletionFollowUp(ctx, followUp);
      throw error;
    }
    return {
      continuePolling:
        !(
          runMode &&
          currentProject.ref === runMode.projectRef &&
          dagResultTerminalForRunMode(result)
        ) &&
        (result.foregroundTimedOut || result.detached || result.completed < result.scheduled),
    };
  }

  private async refreshSparkWidget(cwd: string, ctx: SparkDagManagerContext): Promise<void> {
    try {
      await this.hooks.refreshSparkWidget(cwd, ctx);
    } catch (error) {
      reportSparkDagManagerRefreshError(ctx, error);
    }
  }
}

function terminalSparkRunModeStatus(graph: TaskGraph, projectRef: ProjectRef): SparkRunModeStatus {
  const unfinished = graph.tasks(projectRef).filter((task) => isUnfinishedTaskStatus(task.status));
  return unfinished.length === 0 ? "done" : "blocked";
}

function dagResultTerminalForRunMode(result: { failed?: number; cancelled?: number }): boolean {
  return (result.failed ?? 0) > 0 || (result.cancelled ?? 0) > 0;
}

function emitSparkDagCompletionFollowUp(
  ctx: SparkDagManagerContext,
  followUp: WorkflowRunCompletionFollowUp | undefined,
): void {
  if (!followUp) return;
  const action = followUp.status === "succeeded" ? undefined : followUp.nextActions[0];
  ctx.ui?.notify?.(
    action ? `${followUp.summary} ${action}` : followUp.summary,
    sparkDagCompletionNotificationLevel(followUp.status),
  );
}

function sparkDagCompletionNotificationLevel(
  status: WorkflowRunStatus,
): "info" | "warning" | "error" {
  return status === "succeeded" ? "info" : status === "timed_out" ? "warning" : "error";
}

function reportSparkDagManagerError(error: unknown): void {
  console.warn(
    `Spark workflow-run manager failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function reportSparkDagManagerRefreshError(ctx: SparkDagManagerContext, error: unknown): void {
  const message = `Spark widget refresh failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (ctx.ui?.notify) ctx.ui.notify(message, "warning");
  else console.warn(message);
}
