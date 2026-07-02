import { Type } from "typebox";
import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
} from "@zendev-lab/spark-extension-api";
import { runReadyTasks } from "@zendev-lab/spark-workflows";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { ensureRoleModelSettingsForProject } from "./role-model-settings.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkRunStrategyForMaxConcurrency,
} from "./session-state.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { sessionModelName } from "./session-model.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { createSparkRuntimeReadyTaskRunner } from "./spark-ready-task-runtime.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkRunReadyTasksToolDeps {
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => void;
}

export function normalizeSparkRunReadyTasksBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeSparkRunReadyTasksPositiveInteger(
  value: unknown,
  fallback: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function registerSparkRunReadyTasksTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkRunReadyTasksToolDeps,
): void {
  registerSparkTool({
    name: "impl_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description:
      "Internal implementation for assign: run all currently ready Spark tasks with their bound builtin/extension/project/user Spark role specs and persist task-run artifacts. Dry-run by default. Use assign for Spark-native role/task workflow instead of spawning nested pi CLI sessions.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      maxConcurrency: Type.Optional(
        Type.Number({
          default: DEFAULT_READY_TASK_MAX_CONCURRENCY,
          description: "Maximum number of child runs running at once. Default: 4.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          default: DEFAULT_READY_TASK_TIMEOUT_MS,
          description:
            "Foreground wait budget in milliseconds for this tool call; active background child runs continue after it expires.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const dryRun = normalizeSparkRunReadyTasksBoolean(params.dryRun, true, "assign dryRun");
      const maxConcurrency = normalizeSparkRunReadyTasksPositiveInteger(
        params.maxConcurrency,
        DEFAULT_READY_TASK_MAX_CONCURRENCY,
        "assign maxConcurrency",
      );
      const timeoutMs = normalizeSparkRunReadyTasksPositiveInteger(
        params.timeoutMs,
        DEFAULT_READY_TASK_TIMEOUT_MS,
        "assign timeoutMs",
      );
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [
            {
              type: "text",
              text: 'No current Spark project selected. Use task_write({ action: "project_use" }) before running ready tasks.',
            },
          ],
          details: { found: false, error: "no_current_project" },
        };
      const registry = await createSparkRoleRegistry(cwd);
      if (!dryRun) {
        const settingsResult = await ensureRoleModelSettingsForProject({
          graph,
          projectRef: project.ref,
          registry,
          cwd,
          ctx,
        });
        if (!settingsResult.ready) {
          return {
            content: [{ type: "text", text: settingsResult.message }],
            details: settingsResult as unknown as Record<string, unknown>,
          };
        }
        const runStore = defaultSparkWorkflowRunStore(cwd);
        const existingControl = await runStore.loadControl();
        const focus =
          existingControl?.projectRef === project.ref ? existingControl.focus : undefined;
        // Keep sparkRunStrategyForMaxConcurrency referenced for status/strategy parity.
        void sparkRunStrategyForMaxConcurrency(maxConcurrency);
        const control = await runStore.setControl({
          projectRef: project.ref,
          focus,
          status: "running",
          policy: { maxConcurrency, timeoutMs },
        });
        deps.ensureWorkflowRunManager(cwd, ctx);
        ctx.ui?.notify?.(
          `Spark workflow-run scheduler started for “${project.title}”. Progress appears in the Spark widget; inspect with task_read({ action: "run_status" }).`,
          "info",
        );
        return {
          content: [
            {
              type: "text",
              text: `Spark workflow-run scheduler started for current project “${project.title}”. Progress appears in the Spark widget; inspect with task_read({ action: "run_status" }).`,
            },
          ],
          details: {
            workflowRunScheduler: "started",
            dryRun: false,
            projectRef: project.ref,
            controlProjectRef: control.projectRef,
            policy: { maxConcurrency, timeoutMs },
          },
        };
      }

      const artifactStore = defaultArtifactStore(cwd);
      const runtimeRunner = createSparkRuntimeReadyTaskRunner({
        registry,
        artifactStore,
        cwd,
        sessionModel: sessionModelName(ctx.model),
      });
      const result = await runReadyTasks({
        graph,
        ...runtimeRunner,
        projectRef: project.ref,
        dryRun: true,
        maxConcurrency,
        timeoutMs,
      });
      const runLabels = result.runs.map((run) => run.runName ?? run.roleRef ?? run.ref);
      const visibleRunLabels = runLabels.slice(0, 8);
      const hiddenRunLabels = runLabels.length - visibleRunLabels.length;
      const runLabelSummary = `${visibleRunLabels.join(", ")}${
        hiddenRunLabels > 0 ? `, … ${hiddenRunLabels} more` : ""
      }`;
      const timeoutSuffix = result.foregroundTimedOut
        ? " Foreground wait expired; active child runs remain detached in the background."
        : "";
      return {
        content: [
          {
            type: "text",
            text: runLabels.length
              ? `Dry-run checked ${result.runs.length} Spark task run(s) with maxConcurrency=${result.maxConcurrency}: ${runLabelSummary}.${timeoutSuffix}`
              : `Dry-run found 0 ready Spark task(s) with maxConcurrency=${result.maxConcurrency}.${timeoutSuffix}`,
          },
        ],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });
}
