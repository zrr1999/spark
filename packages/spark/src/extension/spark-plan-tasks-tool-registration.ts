import { Type } from "typebox";
import type { RoleRegistry } from "pi-roles";
import { DependencyError } from "pi-extension-api";
import {
  collectNonConcreteTaskIssues,
  decideTaskPlanBeforeCreate,
  defaultTaskGraphStore,
  normalizeTaskPlan,
  renderTaskPlanReadinessRules,
  renderNonConcreteTaskIssues,
  type TaskGraph,
  type TaskPlanInput,
} from "pi-tasks";
import {
  applyRoadmapHintsToTaskPlanInput,
  attachRoadmapPlanningRefs,
  roadmapPlanningContext,
} from "../flows/roadmap-flow.ts";
import { currentSparkProject, loadSparkGraph, saveSparkGraphAndTodos } from "./session-state.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import {
  compactTaskDetail,
  compactTaskPlanResult,
  normalizeOptionalToolString,
  normalizeRequiredToolString,
  normalizeTaskKind,
  normalizeTaskPlanPatch,
  normalizeTaskStatus,
  normalizeToolStringArray,
  taskPlanSchema,
} from "./task-plan-tool.ts";

const DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT = 5;
const SPARK_PLAN_TASKS_READINESS_RULES = [
  "Readiness rules:",
  "- Tasks must be concrete executable/review/validation/research work; do not create standalone design/planning tasks. Discuss design with the user first, then place the chosen design and rationale inside each concrete task.plan.",
  renderTaskPlanReadinessRules(),
  '- dependsOn resolution is active-project scoped and includes both existing project tasks and every task created/updated in the same task({ action: "plan" }) batch before dependencies are added. Use a bare task name (displayed as @name, passed without @), exact task title, or task:* ref; unresolved dependencies block the plan, and cross-project dependencies are unsupported.',
].join("\n");

interface SparkPlanTasksToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function normalizeSparkPlanTaskInputs(
  params: Record<string, unknown>,
  registry: RoleRegistry,
): TaskPlanInput[] | undefined {
  const rawTasks = params.tasks;
  if (rawTasks === undefined || rawTasks === null) return undefined;
  if (!Array.isArray(rawTasks)) throw new Error("tasks must be a non-empty array");
  if (rawTasks.length === 0) return undefined;
  return rawTasks.map((rawTask, index) =>
    normalizeSparkPlanTaskInput(rawTask, registry, index + 1),
  );
}

export function registerSparkPlanTasksTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkPlanTasksToolDeps,
): void {
  registerSparkTool({
    name: "spark_plan_tasks",
    label: "Spark Plan Tasks",
    description: [
      'Compatibility surface for task({ action: "plan" }): create or update multiple durable Spark tasks in the active project from a concrete task plan. Tasks must be concrete executable/review/validation/research work, not standalone design/planning placeholders; design discussion belongs in conversation with the user and in each task.plan after decisions are clear. The tool writes directly after readiness checks pass, so clarify all planning-affecting questions before calling it and refine by calling it again with concrete updates.',
      "",
      SPARK_PLAN_TASKS_READINESS_RULES,
    ].join("\n"),
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          name: Type.Optional(
            Type.String({ description: "Stable simple @name handle for the task." }),
          ),
          title: Type.String({ description: "Human-readable task title shown as @name: title." }),
          description: Type.String({
            description:
              "Concrete task objective/instruction; do not use this for abstract design/planning placeholders.",
          }),
          kind: Type.Optional(
            Type.String({
              description:
                "research | plan | implement | review | ask | cue | interaction | generic",
            }),
          ),
          status: Type.Optional(
            Type.String({
              description: "pending | ready | running | blocked | done | failed | cancelled",
            }),
          ),
          roleRef: Type.Optional(
            Type.String({
              description:
                "Optional builtin/project/user Spark role spec id or ref, e.g. scout, planner, reviewer, worker. This is a preferred executor hint, not a readiness requirement.",
            }),
          ),
          plan: Type.Optional(taskPlanSchema()),
          dependsOn: Type.Optional(
            Type.Array(
              Type.String({
                description:
                  "Dependency task ref, bare task name (displayed as @name), or exact task title in this plan/project.",
              }),
            ),
          ),
          rationale: Type.Optional(
            Type.String({ description: "Why this task belongs in the plan." }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project)
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
      const registry = await createSparkRoleRegistry(cwd);
      const normalizedTasks = normalizeSparkPlanTaskInputs(params, registry);
      if (!normalizedTasks)
        return {
          content: [{ type: "text", text: "Task plan is required." }],
          details: { found: true, error: "missing_tasks" },
        };
      const roadmapResult = roadmapPlanningContext(graph, project.ref);
      const roadmapContext = roadmapResult?.context;
      const tasks: TaskPlanInput[] = normalizedTasks.map((task) =>
        applyRoadmapHintsToTaskPlanInput(task, roadmapContext?.item),
      );
      const concreteIssues = collectNonConcreteTaskIssues(tasks);
      if (concreteIssues.length > 0) {
        return {
          content: [{ type: "text", text: renderNonConcreteTaskIssues(concreteIssues) }],
          details: { found: true, error: "task_not_concrete", issues: concreteIssues },
        };
      }
      let result: ReturnType<TaskGraph["planTasks"]>;
      try {
        result = graph.planTasks(project.ref, tasks);
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Task plan dependency error: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const changedForDecision = [...result.created, ...result.updated];
      const planDecisions = changedForDecision.map(decideTaskPlanBeforeCreate);
      const rejectedIndex = planDecisions.findIndex((decision) => !decision.accepted);
      if (rejectedIndex >= 0) {
        const task = changedForDecision[rejectedIndex];
        const decision = planDecisions[rejectedIndex];
        const rejectionText = `Task plan not ready: @${task.name}: ${task.title}; revise the task plan with context-specific success criteria and evidence requirements before creating or updating it.`;
        return {
          content: [
            {
              type: "text",
              text: rejectionText,
            },
          ],
          details: {
            found: true,
            error: "task_plan_not_ready",
            result: compactTaskPlanResult(result),
            task: compactTaskDetail(task),
            planDecision: decision as unknown as Record<string, unknown>,
            planDecisions,
          },
        };
      }
      const changedRefs = [...result.created, ...result.updated].map((task) => task.ref);
      const updatedRoadmapItem = attachRoadmapPlanningRefs(
        graph,
        project.ref,
        roadmapContext?.item.ref,
        changedRefs,
      );
      await saveSparkGraphAndTodos(cwd, graph, ctx, store);
      await deps.refreshSparkWidget(cwd, ctx);
      const changed = [
        ...result.created.map((task) => ({ action: "created" as const, task })),
        ...result.updated.map((task) => ({ action: "updated" as const, task })),
      ];
      const visibleChanged = changed.slice(0, DEFAULT_SPARK_PLAN_TASK_OUTPUT_LIMIT);
      const hiddenChanged = changed.length - visibleChanged.length;
      const lines = [
        `Planned tasks: created=${result.created.length} updated=${result.updated.length} dependencies=${result.dependencies.length}`,
        ...visibleChanged.map(
          ({ action, task }) => `- ${action} [${task.status}] @${task.name}: ${task.title}`,
        ),
      ];
      if (hiddenChanged > 0) lines.push(`- … ${hiddenChanged} more changed task(s)`);
      if (updatedRoadmapItem) lines.push(`- roadmap item updated: ${updatedRoadmapItem.ref}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          result: compactTaskPlanResult(result),
          planDecisions,
          roadmapItem: updatedRoadmapItem as unknown as Record<string, unknown> | undefined,
        },
      };
    },
  });
}

function normalizeSparkPlanTaskInput(
  value: unknown,
  registry: RoleRegistry,
  position: number,
): TaskPlanInput {
  if (!isRecord(value)) throw new Error(`tasks[${position - 1}] must be an object`);
  const name = normalizeOptionalToolString(value.name, `tasks[${position - 1}].name`);
  const title = normalizeRequiredToolString(value.title, `tasks[${position - 1}].title`);
  const description = normalizeRequiredToolString(
    value.description,
    `tasks[${position - 1}].description`,
  );
  const roleRefInput = normalizeOptionalToolString(value.roleRef, `tasks[${position - 1}].roleRef`);
  const roleRef = roleRefInput ? registry.select(roleRefInput).ref : undefined;
  return {
    name,
    title,
    description,
    kind: normalizeTaskKind(value.kind) ?? "generic",
    status: normalizeTaskStatus(value.status),
    roleRef,
    plan: normalizeTaskPlan(
      normalizeTaskPlanPatch(value.plan, `tasks[${position - 1}].plan`),
      description,
      title,
    ),
    dependsOn: normalizeToolStringArray(value.dependsOn, `tasks[${position - 1}].dependsOn`),
    rationale: normalizeOptionalToolString(value.rationale, `tasks[${position - 1}].rationale`),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
