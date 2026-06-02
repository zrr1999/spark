import { Type } from "typebox";
import { defaultArtifactStore } from "spark-artifacts";
import { RoleRegistry, defaultProjectRoleStore } from "pi-roles";
import {
  DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
} from "spark-core";
import { runReadySparkTasks } from "spark-orchestrator";
import { defaultTaskGraphStore } from "spark-tasks";
import { ensureRoleModelBindingsForProject } from "./role-model-bindings.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkRunMode,
  saveSparkRunMode,
  sparkRunStrategyForMaxConcurrency,
  sparkTodoStore,
} from "./session-state.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkRunReadyTasksToolDeps {
  ensureDagManager: (cwd: string, ctx: SparkToolContext) => void;
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
    name: "spark_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description:
      "Run all currently ready Spark tasks with their bound builtin/project/user Spark role specs and persist task-run artifacts. Dry-run by default. Use this for Spark-native role/task workflow instead of spawning nested pi CLI sessions.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
      maxConcurrency: Type.Optional(
        Type.Number({
          default: DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
          description: "Maximum number of role runs running at once. Default: 4.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          default: DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
          description:
            "Foreground wait budget in milliseconds for this tool call; active background role-runs continue after it expires.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const dryRun = normalizeSparkRunReadyTasksBoolean(
        params.dryRun,
        true,
        "spark_run_ready_tasks dryRun",
      );
      const maxConcurrency = normalizeSparkRunReadyTasksPositiveInteger(
        params.maxConcurrency,
        DEFAULT_SPARK_READY_TASK_MAX_CONCURRENCY,
        "spark_run_ready_tasks maxConcurrency",
      );
      const timeoutMs = normalizeSparkRunReadyTasksPositiveInteger(
        params.timeoutMs,
        DEFAULT_SPARK_READY_TASK_TIMEOUT_MS,
        "spark_run_ready_tasks timeoutMs",
      );
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) {
        await store.save(graph);
        await sparkTodoStore(cwd, ctx).save(graph);
      }
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [
            {
              type: "text",
              text: "No current Spark project selected. Use spark_use_project before running ready tasks.",
            },
          ],
          details: { found: false, error: "no_current_project" },
        };
      const registry = new RoleRegistry();
      await defaultProjectRoleStore(cwd).hydrate(registry);
      if (!dryRun) {
        const bindingResult = await ensureRoleModelBindingsForProject({
          graph,
          projectRef: project.ref,
          registry,
          cwd,
          ctx,
        });
        if (!bindingResult.ready) {
          return {
            content: [{ type: "text", text: bindingResult.message }],
            details: bindingResult as unknown as Record<string, unknown>,
          };
        }
        const existingRunMode = await loadSparkRunMode(cwd, ctx);
        const focus =
          existingRunMode?.projectRef === project.ref ? existingRunMode.focus : undefined;
        const runMode = await saveSparkRunMode(
          cwd,
          ctx,
          project.ref,
          focus,
          sparkRunStrategyForMaxConcurrency(maxConcurrency),
          { maxConcurrency, timeoutMs },
        );
        deps.ensureDagManager(cwd, ctx);
        ctx.ui?.notify?.(
          `Spark workflow-run scheduler started for “${project.title}”. Progress appears in the Spark widget; inspect with spark_background_runs status.`,
          "info",
        );
        return {
          content: [
            {
              type: "text",
              text: `Spark workflow-run scheduler started for current project “${project.title}”. Progress appears in the Spark widget; inspect with spark_background_runs status, or stop explicit stuck child role-runs with spark_background_runs kill.`,
            },
          ],
          details: {
            workflowRunScheduler: "started",
            dryRun: false,
            projectRef: project.ref,
            runModeRef: runMode.runRef,
            policy: { maxConcurrency, timeoutMs },
          },
        };
      }

      const artifactStore = defaultArtifactStore(cwd);
      const result = await runReadySparkTasks({
        graph,
        registry,
        artifactStore,
        cwd,
        projectRef: project.ref,
        dryRun: true,
        maxConcurrency,
        timeoutMs,
      });
      const runLabels = result.runs.map((run) => run.runName ?? run.roleRef ?? run.ref);
      const timeoutSuffix = result.foregroundTimedOut
        ? " Foreground wait expired; active role-runs remain detached in the background."
        : "";
      return {
        content: [
          {
            type: "text",
            text: runLabels.length
              ? `Dry-run checked ${result.runs.length} Spark task run(s) with maxConcurrency=${result.maxConcurrency}: ${runLabels.join(", ")}.${timeoutSuffix}`
              : `Dry-run found 0 ready Spark task(s) with maxConcurrency=${result.maxConcurrency}.${timeoutSuffix}`,
          },
        ],
        details: { result: result as unknown as Record<string, unknown> },
      };
    },
  });
}
