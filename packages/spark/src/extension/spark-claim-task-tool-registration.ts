import { Type } from "typebox";
import type { RoleRegistry } from "pi-roles";
import {
  stableId,
  type RoleRef,
  type Task,
  type TaskPlan,
  type ProjectRef,
} from "pi-extension-api";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  normalizeTaskPlan,
  type TaskGraph,
} from "pi-tasks";
import {
  compactTaskDetail,
  normalizeOptionalToolString,
  normalizeRequiredToolString,
  normalizeTaskKind,
  normalizeTaskPlanPatch,
  normalizeTaskStatus,
  normalizeToolStringArray,
  taskPlanSchema,
} from "./task-plan-tool.ts";
import { currentSparkProject, sparkSessionKey, sparkTodoStore } from "./session-state.ts";
import { isGenericInitialTaskTitle } from "./spark-graph-invariants.ts";
import { findActiveSessionClaim, resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { taskClaimSummary } from "./task-display.ts";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

const MAIN_TASK_CLAIM_LEASE_MS = 10 * 60 * 1_000;

interface SparkClaimTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export interface NormalizedSparkClaimTaskInput {
  name?: string;
  title: string;
  description: string;
  kind: NonNullable<ReturnType<typeof normalizeTaskKind>>;
  requestedStatus?: ReturnType<typeof normalizeTaskStatus>;
  roleRef?: RoleRef;
  plan?: Partial<TaskPlan>;
  todos: string[];
}

export function normalizeSparkClaimTaskInput(
  params: Record<string, unknown>,
  registry: RoleRegistry,
): NormalizedSparkClaimTaskInput {
  const roleRefInput = normalizeOptionalToolString(params.roleRef, "roleRef");
  return {
    name: normalizeOptionalToolString(params.name, "name"),
    title: normalizeRequiredToolString(params.title, "title"),
    description: normalizeRequiredToolString(params.description, "description"),
    kind: normalizeTaskKind(params.kind) ?? "interaction",
    requestedStatus: normalizeTaskStatus(params.status),
    roleRef: roleRefInput ? registry.select(roleRefInput).ref : undefined,
    plan: normalizeTaskPlanPatch(params.plan, "plan"),
    todos: normalizeToolStringArray(params.todos, "todos") ?? [],
  };
}

export function registerSparkClaimTaskTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkClaimTaskToolDependencies,
): void {
  registerSparkTool({
    name: "spark_claim_task",
    label: "Spark Claim Task",
    description:
      'Compatibility surface for task({ action: "claim" }): create or update a concrete Spark task for this session. For Spark-native delegated work, tasks may include an optional roleRef hint, but task({ action: "run_ready" }) assigns the concrete executor role at dispatch; do not spawn nested pi CLI sessions as pseudo-roles unless explicitly testing Pi CLI behavior.',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "Simple @name handle for this task (lowercase, digits, - or _).",
        }),
      ),
      title: Type.String({ description: "Human-readable task title shown as @name: title." }),
      description: Type.String({ description: "What the claimed task will accomplish." }),
      kind: Type.Optional(
        Type.String({
          description: "research | plan | implement | review | ask | cue | interaction | generic",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description: "pending | ready | running | blocked",
        }),
      ),
      roleRef: Type.Optional(
        Type.String({
          description:
            'Optional builtin/project/user role spec id or ref from role({ action: "list" }), e.g. planner or role:builtin-planner. This is a preferred executor hint; task({ action: "run_ready" }) can also assign a role at dispatch.',
        }),
      ),
      plan: Type.Optional(taskPlanSchema()),
      todos: Type.Optional(Type.Array(Type.String({ description: "Task-local TODO item." }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const registry = await createSparkRoleRegistry(cwd);
      const input = normalizeSparkClaimTaskInput(params, registry);
      if (input.requestedStatus && !isUnfinishedTaskStatus(input.requestedStatus))
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${input.title}: task({ action: "claim" }) only accepts unfinished statuses (pending, ready, running, blocked). Use task completion/failure/cancellation flows instead of claiming with terminal status ${input.requestedStatus}.`,
            },
          ],
          details: {
            found: true,
            error: "terminal_status_not_allowed",
            status: input.requestedStatus,
          },
        };
      const status = input.requestedStatus ?? (input.roleRef ? "pending" : "running");
      const sessionKey = sparkSessionKey(ctx);
      const store = defaultTaskGraphStore(cwd);
      const claimed = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const project = await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const tasks = graph.tasks(project.ref);
          const existing =
            resolveSessionClaimedTask(graph, project.ref, sessionKey, input.name ?? input.title) ??
            tasks.find((task) => Boolean(input.name) && task.name === input.name) ??
            tasks.find((task) => task.title === input.title) ??
            resolveObviousTaskRenameCandidate(graph, project.ref, tasks);
          if (existing && taskClaimedBy(existing) && !isClaimOwnedBySession(existing, sessionKey))
            return { error: "claimed_by_other" as const, activeTask: existing };
          const activeClaim = findActiveSessionClaim(graph, project.ref, sessionKey, existing?.ref);
          if (isUnfinishedTaskStatus(status) && activeClaim)
            return { error: "active_claim_exists" as const, activeTask: activeClaim };
          const requestedName = taskNamePatchForClaim(existing, input.name, input.title);
          const namePatch = requestedName
            ? uniqueTaskNameForExistingTask(tasks, requestedName, existing?.ref)
            : undefined;
          const task = existing
            ? graph.updateTask(existing.ref, {
                ...(namePatch ? { name: namePatch } : {}),
                title: input.title,
                description: input.description,
                kind: input.kind,
                status,
                roleRef: input.roleRef,
                plan: normalizeTaskPlan(
                  input.plan ?? existing.plan,
                  input.description,
                  input.title,
                ),
              })
            : graph.createTask({
                projectRef: project.ref,
                name: input.name,
                title: input.title,
                description: input.description,
                kind: input.kind,
                status,
                roleRef: input.roleRef,
                plan: normalizeTaskPlan(input.plan, input.description, input.title),
              });
          if (isUnfinishedTaskStatus(status)) {
            graph.claimTask(task.ref, {
              kind: "main",
              claimedBy: sessionKey,
              sessionId: sessionKey,
              roleRef: input.roleRef,
              leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
            });
          }
          if (input.todos.length > 0) {
            graph.applyTodoOps(task.ref, [
              {
                op: "init",
                items: input.todos,
              },
            ]);
            await sparkTodoStore(cwd, ctx).save(graph);
          }
          return { task: graph.getTask(task.ref) };
        },
        { createIfMissing: false },
      );
      if (!claimed.graph || claimed.result.error === "no_project")
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
      if (
        claimed.result.error === "active_claim_exists" ||
        claimed.result.error === "claimed_by_other"
      )
        return {
          content: [
            {
              type: "text",
              text:
                claimed.result.error === "active_claim_exists"
                  ? `Cannot claim ${input.title}: this session already has unfinished claimed task ${claimed.result.activeTask.title} (${claimed.result.activeTask.ref}). Finish, fail, or cancel it before claiming another task.`
                  : `Cannot update ${input.title}: matching task is currently claimed by another session (${taskClaimSummary(claimed.result.activeTask)}).`,
            },
          ],
          details: {
            found: true,
            error: claimed.result.error,
            activeTask: compactTaskDetail(claimed.result.activeTask),
          },
        };
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: renderClaimedTaskText(claimed.result.task),
          },
        ],
        details: {
          task: claimed.result.task as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

function renderClaimedTaskText(task: Task): string {
  const plan = task.plan;
  const lines = [`Claimed Spark task: @${task.name}: ${task.title} (${task.ref})`, "", "Plan:"];
  if (!plan) {
    lines.push(
      "- objective: missing",
      "- successCriteria: missing",
      "- evidenceRequired: missing",
      "- steps: missing",
      "- constraints: missing",
    );
  } else {
    lines.push(
      `- objective: ${truncateInline(plan.objective, 220)}`,
      `- successCriteria: ${renderPlanList(plan.successCriteria)}`,
      `- evidenceRequired: ${renderPlanList(plan.evidenceRequired)}`,
      `- steps: ${renderPlanList(plan.steps)}`,
      `- constraints: ${renderPlanList(plan.constraints)}`,
    );
  }
  lines.push(
    "",
    'Next: execute this plan, and if useful create task-scoped TODOs with task({ action: "todo_update", scope: "task", ops: [{ op: "append", items: [...] }] }).',
  );
  return lines.join("\n");
}

function renderPlanList(items: readonly string[]): string {
  if (items.length === 0) return "none";
  if (items.length <= 3) return items.map((item) => truncateInline(item, 140)).join("; ");
  const head = items
    .slice(0, 3)
    .map((item) => truncateInline(item, 120))
    .join("; ");
  return `${head}; … +${items.length - 3} more`;
}

function resolveObviousTaskRenameCandidate(
  graph: TaskGraph,
  projectRef: ProjectRef,
  tasks: Task[],
): Task | undefined {
  const current = graph.currentTask(projectRef);
  if (current && isObviousTaskRenameCandidate(current)) return current;
  const candidates = tasks.filter(isObviousTaskRenameCandidate);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isObviousTaskRenameCandidate(task: Task): boolean {
  return (
    isUnfinishedTaskStatus(task.status) &&
    (isGenericInitialTaskTitle(task.title) || isGenericTaskNameForTitle(task.name, task.title))
  );
}

function uniqueTaskNameForExistingTask(
  tasks: Task[],
  preferred: string,
  existingTaskRef?: string,
): string {
  const existingNames = new Set(
    tasks.filter((task) => task.ref !== existingTaskRef).map((task) => task.name),
  );
  const base = preferred.trim();
  if (!existingNames.has(base)) return base;
  let index = 2;
  while (existingNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function taskNamePatchForClaim(
  existing: Task | undefined,
  requestedName: string | undefined,
  requestedTitle: string,
): string | undefined {
  if (!existing) return requestedName;
  if (requestedName && requestedName !== existing.name) return requestedName;
  if (!requestedName && isGenericTaskNameForTitle(existing.name, existing.title)) {
    return taskNameFromTitleForPrompt(requestedTitle);
  }
  return undefined;
}

export function isGenericTaskNameForTitle(name: string, title: string): boolean {
  return name === taskNameFromTitleForPrompt(title) || /^task-[a-f0-9]{16}$/.test(name);
}

function taskNameFromTitleForPrompt(title: string): string {
  const ascii = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return ascii || `task-${stableId(title)}`;
}
