import { Type } from "typebox";
import type { RoleRegistry } from "pi-roles";
import {
  stableId,
  type RoleRef,
  type Task,
  type TaskPlan,
  type ProjectRef,
  type TaskTodo,
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
  normalizeTaskKind,
  normalizeTaskPlanPatch,
  normalizeTaskStatus,
  taskKindDescription,
  taskPlanSchema,
} from "./task-plan-tool.ts";
import { currentSparkProject, sparkSessionKey, sparkTodoStore } from "./session-state.ts";
import { isGenericInitialTaskTitle } from "./spark-graph-invariants.ts";
import { findActiveSessionClaim, resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { taskClaimSummary } from "./task-display.ts";
import { isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

const MAIN_TASK_CLAIM_LEASE_MS = 10 * 60 * 1_000;

interface SparkClaimTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export interface NormalizedSparkClaimTaskInput {
  name?: string;
  title?: string;
  description?: string;
  kind?: NonNullable<ReturnType<typeof normalizeTaskKind>>;
  requestedStatus?: ReturnType<typeof normalizeTaskStatus>;
  roleRef?: RoleRef;
  plan?: Partial<TaskPlan>;
}

export function normalizeSparkClaimTaskInput(
  params: Record<string, unknown>,
  registry: RoleRegistry,
): NormalizedSparkClaimTaskInput {
  const roleRefInput = normalizeOptionalToolString(params.roleRef, "roleRef");
  return {
    name: normalizeOptionalToolString(params.name, "name"),
    title: normalizeOptionalToolString(params.title, "title"),
    description: normalizeOptionalToolString(params.description, "description"),
    kind: normalizeTaskKind(params.kind),
    requestedStatus: normalizeTaskStatus(params.status),
    roleRef: roleRefInput ? registry.select(roleRefInput).ref : undefined,
    plan: normalizeTaskPlanPatch(params.plan, "plan"),
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
      title: Type.Optional(
        Type.String({
          description:
            "Human-readable task title. Optional when claiming an existing task by name.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "What the claimed task will accomplish. Optional when an existing task or concrete plan already provides it.",
        }),
      ),
      kind: Type.Optional(
        Type.String({
          description: taskKindDescription(),
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
              text: `Cannot claim ${claimInputLabel(input)}: task({ action: "claim" }) only accepts unfinished statuses (pending, ready, running, blocked). Use task completion/failure/cancellation flows instead of claiming with terminal status ${input.requestedStatus}.`,
            },
          ],
          details: {
            found: true,
            error: "terminal_status_not_allowed",
            status: input.requestedStatus,
          },
        };
      const status = input.requestedStatus ?? (input.roleRef ? "pending" : "running");
      const providedPlan = input.plan !== undefined;
      const sessionKey = sparkSessionKey(ctx);
      const store = defaultTaskGraphStore(cwd);
      const existingGraph = await store.load();
      if (!existingGraph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      const claimed = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const project = await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const tasks = graph.tasks(project.ref);
          const existing =
            resolveSessionClaimedTask(graph, project.ref, sessionKey, input.name ?? input.title) ??
            tasks.find((task) => Boolean(input.name) && task.name === input.name) ??
            tasks.find((task) => Boolean(input.title) && task.title === input.title) ??
            resolveObviousTaskRenameCandidate(graph, project.ref, tasks);
          if (existing && taskClaimedBy(existing) && !isClaimOwnedBySession(existing, sessionKey))
            return { error: "claimed_by_other" as const, activeTask: existing };
          const activeClaim = findActiveSessionClaim(graph, project.ref, sessionKey, existing?.ref);
          if (isUnfinishedTaskStatus(status) && activeClaim)
            return { error: "active_claim_exists" as const, activeTask: activeClaim };
          if (!providedPlan && (!existing || !existing.plan))
            return { error: "task_plan_required" as const };
          const resolved = resolveClaimedTaskFields(input, existing);
          if (!resolved) return { error: "task_title_required" as const };
          const requestedName = taskNamePatchForClaim(existing, input.name, input.title);
          const namePatch = requestedName
            ? uniqueTaskNameForExistingTask(tasks, requestedName, existing?.ref)
            : undefined;
          const task = existing
            ? graph.updateTask(existing.ref, {
                ...(namePatch ? { name: namePatch } : {}),
                title: resolved.title,
                description: resolved.description,
                kind: resolved.kind,
                status,
                roleRef: input.roleRef ?? existing.roleRef,
                plan: normalizeTaskPlan(resolved.plan, resolved.description, resolved.title),
              })
            : graph.createTask({
                projectRef: project.ref,
                name: input.name,
                title: resolved.title,
                description: resolved.description,
                kind: resolved.kind,
                status,
                roleRef: input.roleRef,
                plan: normalizeTaskPlan(resolved.plan, resolved.description, resolved.title),
              });
          if (isUnfinishedTaskStatus(status)) {
            graph.claimTask(task.ref, {
              kind: "main",
              claimedBy: sessionKey,
              sessionId: sessionKey,
              roleRef: input.roleRef ?? task.roleRef,
              leaseMs: MAIN_TASK_CLAIM_LEASE_MS,
            });
          }
          const taskTodos = graph.taskTodos(task.ref);
          const hasActiveTodos = taskTodos.some(isActiveTaskTodo);
          return { task: graph.getTask(task.ref), hasActiveTodos };
        },
        { createIfMissing: false },
      );
      if (!claimed.graph || claimed.result.error === "no_project")
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (claimed.result.error === "task_plan_required")
        return {
          content: [
            {
              type: "text",
              text: `Cannot claim ${claimInputLabel(input)}: creating or claiming a task without a bound task.plan is not allowed. Provide a concrete plan with objective, success criteria, evidence requirements, and steps before claiming.`,
            },
          ],
          details: { found: true, error: "task_plan_required" },
        };
      if (claimed.result.error === "task_title_required")
        return {
          content: [
            {
              type: "text",
              text: "Cannot claim a new task without title or name. Provide title, or provide name so Spark can derive a readable title.",
            },
          ],
          details: { found: true, error: "task_title_required" },
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
                  ? `Cannot claim ${claimInputLabel(input)}: this session already has unfinished claimed task ${claimed.result.activeTask.title} (${claimed.result.activeTask.ref}). Finish, fail, or cancel it before claiming another task.`
                  : `Cannot update ${claimInputLabel(input)}: matching task is currently claimed by another session (${taskClaimSummary(claimed.result.activeTask)}).`,
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
            text: renderClaimedTaskText(claimed.result.task, claimed.result.hasActiveTodos),
          },
        ],
        details: {
          task: claimed.result.task as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

interface ResolvedClaimedTaskFields {
  title: string;
  description: string;
  kind: NonNullable<ReturnType<typeof normalizeTaskKind>>;
  plan: Partial<TaskPlan>;
}

function resolveClaimedTaskFields(
  input: NormalizedSparkClaimTaskInput,
  existing: Task | undefined,
): ResolvedClaimedTaskFields | undefined {
  const title = input.title ?? existing?.title ?? titleFromTaskName(input.name);
  if (!title) return undefined;
  const plan = input.plan ?? existing?.plan;
  if (!plan) return undefined;
  const description = input.description ?? existing?.description ?? plan.objective ?? title;
  return {
    title,
    description,
    kind: input.kind ?? existing?.kind ?? "implement",
    plan,
  };
}

function titleFromTaskName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const words = name.replace(/^@/u, "").split(/[-_]+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function claimInputLabel(input: NormalizedSparkClaimTaskInput): string {
  return input.title ?? (input.name ? `@${input.name}` : "task");
}

function isActiveTaskTodo(todo: TaskTodo): boolean {
  return todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted";
}

function renderClaimedTaskText(task: Task, hasActiveTodos: boolean): string {
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
  lines.push("");
  if (hasActiveTodos) {
    lines.push(
      'Task TODOs are present for this claim. Next: execute the task TODOs, and refine them with task({ action: "todo_update", scope: "task", ops: [...] }) if the breakdown is incomplete.',
    );
  } else {
    lines.push(
      'Next: set task-local TODOs with task({ action: "todo_update", scope: "task", ops: [{ op: "init", items: [...] }] }) before doing implementation work.',
    );
  }
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
  requestedTitle: string | undefined,
): string | undefined {
  if (!existing) return requestedName;
  if (requestedName && requestedName !== existing.name) return requestedName;
  if (
    requestedTitle &&
    !requestedName &&
    isGenericTaskNameForTitle(existing.name, existing.title)
  ) {
    return taskNameFromTitleForPrompt(requestedTitle);
  }
  return undefined;
}

export function isGenericTaskNameForTitle(name: string, title: string): boolean {
  return name === taskNameFromTitleForPrompt(title) || /^task-[a-f0-9]{16}$/.test(name);
}

function taskNameFromTitleForPrompt(title: string): string {
  const ascii = slugifyTaskName(title);
  return ascii || `task-${stableId(title)}`;
}

function slugifyTaskName(value: string): string {
  let output = "";
  let previousDash = false;
  for (const char of value.trim().toLowerCase()) {
    const allowed = (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_";
    if (allowed) {
      output += char;
      previousDash = false;
    } else if (output && !previousDash) {
      output += "-";
      previousDash = true;
    }
  }
  return output.endsWith("-") ? output.slice(0, -1) : output;
}
