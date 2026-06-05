import { Type } from "typebox";
import type { TaskGraph } from "pi-tasks";
import { clearSparkExecutionMode, currentSparkProject, loadSparkGraph } from "./session-state.ts";
import {
  inferProjectGoalObjective,
  loadProjectGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  setProjectGoal,
  updateProjectGoalStatus,
  type SparkProjectGoal,
  type SparkProjectGoalSource,
} from "./spark-project-goals.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

export type SparkGoalToolAction = "status" | "infer" | "set" | "start" | "pause" | "complete";

interface SparkGoalToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkGoalTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkGoalToolDeps,
): void {
  registerSparkTool({
    name: "goal",
    label: "Spark Goal",
    description:
      "Manage the current project's durable goal state. Actions: status, infer, set, start, pause, complete. Goals are project-bound and only active goals are eligible for autonomous loop execution.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "status | infer | set | start | pause | complete. Defaults to status.",
        }),
      ),
      objective: Type.Optional(Type.String({ description: "Goal objective for set/start." })),
      reason: Type.Optional(Type.String({ description: "Reason for pause/complete." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeSparkGoalAction(params.action);
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false, error: "no_project" },
        };
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [
            {
              type: "text",
              text: 'No current Spark project selected. Use task({ action: "project_use" }) before managing project goals.',
            },
          ],
          details: { found: false, error: "no_current_project" },
        };

      if (action === "infer") {
        const objective = inferProjectGoalObjective(graph, project);
        return {
          content: [{ type: "text", text: objective }],
          details: { found: true, action, projectRef: project.ref, objective },
        };
      }

      if (action === "status") {
        const goal = await loadProjectGoal(cwd, project.ref);
        return goalResult(
          goal,
          action,
          goal ? renderGoalStatus(goal, project.title) : "No project goal is set.",
        );
      }

      if (action === "set" || action === "start") {
        const objective =
          params.objective === undefined && action === "start"
            ? inferProjectGoalObjective(graph, project)
            : normalizeGoalObjective(params.objective);
        const source: SparkProjectGoalSource =
          params.objective === undefined ? "inferred" : "explicit";
        const goal = await setProjectGoal(cwd, {
          projectRef: project.ref,
          objective,
          source,
          status: "active",
        });
        await clearSparkExecutionMode(cwd, ctx);
        await deps.refreshSparkWidget(cwd, ctx);
        return goalResult(
          goal,
          action,
          `Spark goal active for “${project.title}”: ${oneLine(goal.objective)}`,
        );
      }

      const reason = normalizeOptionalReason(params.reason);
      const nextStatus = action === "pause" ? "paused" : "complete";
      const goal = await updateProjectGoalStatus(cwd, project.ref, nextStatus, { reason });
      if (!goal)
        return {
          content: [{ type: "text", text: "No project goal is set." }],
          details: { found: false, action, error: "no_goal", projectRef: project.ref },
        };
      await clearSparkExecutionMode(cwd, ctx);
      await deps.refreshSparkWidget(cwd, ctx);
      return goalResult(goal, action, renderGoalStatus(goal, project.title));
    },
  });
}

export function normalizeSparkGoalAction(value: unknown): SparkGoalToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "infer" ||
    value === "set" ||
    value === "start" ||
    value === "pause" ||
    value === "complete"
  ) {
    return value;
  }
  throw new Error("goal action must be status, infer, set, start, pause, or complete");
}

export async function startOrInferProjectGoal(
  cwd: string,
  ctx: SparkToolContext,
  graph: TaskGraph,
  explicitObjective?: string,
): Promise<SparkProjectGoal | undefined> {
  const project = await currentSparkProject(cwd, ctx, graph);
  if (!project) return undefined;
  const objective = explicitObjective?.trim() || inferProjectGoalObjective(graph, project);
  await clearSparkExecutionMode(cwd, ctx);
  return setProjectGoal(cwd, {
    projectRef: project.ref,
    objective,
    source: explicitObjective?.trim() ? "explicit" : "inferred",
    status: "active",
  });
}

export async function pauseCurrentProjectGoal(
  cwd: string,
  ctx: SparkToolContext,
  graph: TaskGraph,
  reason?: string,
): Promise<SparkProjectGoal | undefined> {
  const project = await currentSparkProject(cwd, ctx, graph);
  if (!project) return undefined;
  await clearSparkExecutionMode(cwd, ctx);
  return updateProjectGoalStatus(cwd, project.ref, "paused", { reason });
}

function goalResult(goal: SparkProjectGoal | undefined, action: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { found: Boolean(goal), action, goal },
  };
}

function renderGoalStatus(goal: SparkProjectGoal, projectTitle: string): string {
  const reason = goal.pauseReason ?? goal.completedReason;
  const reasonText = reason ? ` Reason: ${reason}` : "";
  return `Spark goal ${goal.status} for “${projectTitle}”: ${oneLine(goal.objective)}${reasonText}`;
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
