import { Type } from "typebox";
import type { TaskGraph } from "pi-tasks";
import { clearSparkExecutionMode, currentSparkProject, loadSparkGraph } from "./session-state.ts";
import {
  inferSessionGoalObjective,
  loadSessionGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  setSessionGoal,
  updateSessionGoalStatus,
  type SparkSessionGoal,
  type SparkSessionGoalSource,
} from "./spark-session-goals.ts";
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
      "Manage the current Pi session's durable goal state. Actions: status, infer, set, start, pause, complete. Goals are session-bound and only active goals are eligible for autonomous loop execution.",
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
      const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;

      if (action === "infer") {
        if (!graph)
          return {
            content: [
              {
                type: "text",
                text: "No Spark project/task state is available to infer a session goal.",
              },
            ],
            details: { found: false, action, error: "no_project_state" },
          };
        const objective = inferSessionGoalObjective(graph, project);
        return {
          content: [{ type: "text", text: objective }],
          details: { found: true, action, projectRef: project?.ref, objective },
        };
      }

      if (action === "status") {
        const goal = await loadSessionGoal(cwd, ctx);
        return goalResult(goal, action, goal ? renderGoalStatus(goal) : "No session goal is set.");
      }

      if (action === "set" || action === "start") {
        const objective = resolveGoalObjective(action, params.objective, graph, project);
        if (!objective)
          return {
            content: [
              {
                type: "text",
                text: "No Spark project/task state is available to infer a session goal. Provide objective for start/set.",
              },
            ],
            details: { found: false, action, error: "no_inferable_goal" },
          };
        const source: SparkSessionGoalSource =
          params.objective === undefined ? "inferred" : "explicit";
        const goal = await setSessionGoal(cwd, ctx, {
          objective,
          source,
          status: "active",
        });
        await clearSparkExecutionMode(cwd, ctx);
        await deps.refreshSparkWidget(cwd, ctx);
        return goalResult(goal, action, `Spark session goal active: ${oneLine(goal.objective)}`);
      }

      const reason = normalizeOptionalReason(params.reason);
      const nextStatus = action === "pause" ? "paused" : "complete";
      const goal = await updateSessionGoalStatus(cwd, ctx, nextStatus, { reason });
      if (!goal)
        return {
          content: [{ type: "text", text: "No session goal is set." }],
          details: { found: false, action, error: "no_goal" },
        };
      await clearSparkExecutionMode(cwd, ctx);
      await deps.refreshSparkWidget(cwd, ctx);
      return goalResult(goal, action, renderGoalStatus(goal));
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

export async function startOrInferSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  graph: TaskGraph | null,
  explicitObjective?: string,
): Promise<SparkSessionGoal | undefined> {
  const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
  const objective =
    explicitObjective?.trim() || (graph ? inferSessionGoalObjective(graph, project) : undefined);
  if (!objective) return undefined;
  await clearSparkExecutionMode(cwd, ctx);
  return setSessionGoal(cwd, ctx, {
    objective,
    source: explicitObjective?.trim() ? "explicit" : "inferred",
    status: "active",
  });
}

export async function pauseCurrentSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  reason?: string,
): Promise<SparkSessionGoal | undefined> {
  await clearSparkExecutionMode(cwd, ctx);
  return updateSessionGoalStatus(cwd, ctx, "paused", { reason });
}

function resolveGoalObjective(
  action: SparkGoalToolAction,
  value: unknown,
  graph: TaskGraph | null,
  project: Awaited<ReturnType<typeof currentSparkProject>>,
): string | undefined {
  if (value !== undefined || action === "set") return normalizeGoalObjective(value);
  return graph ? inferSessionGoalObjective(graph, project) : undefined;
}

function goalResult(goal: SparkSessionGoal | undefined, action: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { found: Boolean(goal), action, goal },
  };
}

function renderGoalStatus(goal: SparkSessionGoal): string {
  const reason = goal.pauseReason ?? goal.completedReason;
  const reasonText = reason ? ` Reason: ${reason}` : "";
  return `Spark session goal ${goal.status}: ${oneLine(goal.objective)}${reasonText}`;
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
