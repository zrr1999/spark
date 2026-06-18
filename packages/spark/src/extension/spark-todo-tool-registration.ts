import { Type } from "typebox";
import {
  applyIndependentTodoOps,
  defaultTaskGraphStore,
  type TaskGraph,
  type TaskTodoOp,
} from "@zendev-lab/pi-tasks";
import type { Task } from "@zendev-lab/pi-extension-api";
import { currentSparkProject, sparkSessionKey, sparkTodoStore } from "./session-state.ts";
import { loadIndependentTodos, saveIndependentTodos } from "./session-todos.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { normalizeOptionalToolString, normalizeToolStringArray } from "./task-plan-tool.ts";
import { syncTaskTodosFromPlan } from "./task-plan-todos.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkTodoToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

type SparkTaskTodoOp = TaskTodoOp | ({ op: "sync_from_plan" } & Partial<Omit<TaskTodoOp, "op">>);

export function normalizeSparkTodoOps(value: unknown, path = "ops"): SparkTaskTodoOp[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be a non-empty array`);
  if (value.length === 0) return undefined;
  return value.map((op, index) => normalizeSparkTodoOp(op, `${path}[${index}]`));
}

export function registerSparkTodoTools(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkTodoToolDependencies,
): void {
  registerSparkTool({
    name: "spark_update_todos",
    label: "Spark Update TODOs",
    description:
      'Compatibility surface for task_write({ action: "todo_update", scope: "session" }): update independent session TODOs. These TODOs are not tied to a claimed task and survive reload/restart for this session.',
    parameters: Type.Object({
      ops: Type.Array(
        Type.Object({
          op: Type.String({
            description:
              "init | append | start | done | upsert_done | block | cancel | delete | restore | remove | note",
          }),
          id: Type.Optional(Type.String()),
          item: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(Type.String())),
          text: Type.Optional(Type.String()),
          blockedBy: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const ops = normalizeSparkTodoOps(params.ops);
      if (!ops)
        return {
          content: [{ type: "text", text: "TODO ops are required." }],
          details: { error: "missing_ops" },
        };
      const sessionOps = rejectPlanTodoOpsForSession(ops);
      const todos = applyIndependentTodoOps(await loadIndependentTodos(cwd, ctx), sessionOps);
      await saveIndependentTodos(cwd, ctx, todos);
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [{ type: "text", text: `Updated ${todos.length} independent Spark TODO(s).` }],
        details: { todos: todos as unknown as Record<string, unknown>[] },
      };
    },
  });

  registerSparkTool({
    name: "spark_update_task_todos",
    label: "Spark Update Task TODOs",
    description:
      'Compatibility surface for task_write({ action: "todo_update", scope: "task" }): update TODOs attached to this session\'s one currently claimed unfinished task. Only claimed unfinished tasks can have task TODOs modified; use task_write({ action: "todo_update", scope: "session" }) for independent session TODOs.',
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      ops: Type.Array(
        Type.Object({
          op: Type.String({
            description:
              "init | append | start | done | upsert_done | sync_from_plan | block | cancel | delete | restore | remove | note",
          }),
          id: Type.Optional(Type.String()),
          item: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(Type.String())),
          text: Type.Optional(Type.String()),
          blockedBy: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const taskSelector = normalizeOptionalToolString(params.task, "task");
      const ops = normalizeSparkTodoOps(params.ops);
      if (!ops)
        return {
          content: [{ type: "text", text: "TODO ops are required." }],
          details: { found: true, error: "missing_ops" },
        };
      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          await sparkTodoStore(cwd, ctx).hydrate(graph);
          const project = await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const task = resolveSessionClaimedTask(
            graph,
            project.ref,
            sparkSessionKey(ctx),
            taskSelector,
          );
          if (!task) return { error: "no_matching_claimed_task" as const };
          const syncedFromPlan = applyTaskTodoOpsWithPlanSync(graph, task, ops);
          await sparkTodoStore(cwd, ctx).save(graph);
          return { task: graph.getTask(task.ref), syncedFromPlan };
        },
        { createIfMissing: false },
      );
      if (!updated.graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (updated.result.error === "no_project")
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (updated.result.error === "no_matching_claimed_task")
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Updated TODOs for ${updated.result.task.title} (${updated.result.task.ref}).`,
          },
        ],
        details: {
          task: updated.result.task as unknown as Record<string, unknown>,
          syncedFromPlan: updated.result.syncedFromPlan,
        },
      };
    },
  });
}

function rejectPlanTodoOpsForSession(ops: SparkTaskTodoOp[]): TaskTodoOp[] {
  const invalid = ops.find((op) => op.op === "sync_from_plan");
  if (invalid)
    throw new Error("sync_from_plan is only supported for task TODOs with a bound task.plan");
  return ops as TaskTodoOp[];
}

function applyTaskTodoOpsWithPlanSync(
  graph: TaskGraph,
  task: Task,
  ops: SparkTaskTodoOp[],
): string[] {
  const syncedFromPlan: string[] = [];
  for (const op of ops) {
    if (op.op === "sync_from_plan") {
      syncedFromPlan.push(...syncTaskTodosFromPlan(graph, graph.getTask(task.ref)));
      continue;
    }
    graph.applyTodoOps(task.ref, [op]);
  }
  return syncedFromPlan;
}

function normalizeSparkTodoOp(value: unknown, path: string): SparkTaskTodoOp {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const op: SparkTaskTodoOp = { op: normalizeSparkTodoOpKind(value.op, `${path}.op`) };
  const id = normalizeOptionalToolString(value.id, `${path}.id`);
  const item = normalizeOptionalToolString(value.item, `${path}.item`);
  const items = normalizeToolStringArray(value.items, `${path}.items`);
  const text = normalizeOptionalToolString(value.text, `${path}.text`);
  const blockedBy = normalizeToolStringArray(value.blockedBy, `${path}.blockedBy`);
  if (id !== undefined) op.id = id;
  if (item !== undefined) op.item = item;
  if (items !== undefined) op.items = items;
  if (text !== undefined) op.text = text;
  if (blockedBy !== undefined) op.blockedBy = blockedBy;
  return op;
}

function normalizeSparkTodoOpKind(value: unknown, path: string): SparkTaskTodoOp["op"] {
  if (
    value === "init" ||
    value === "append" ||
    value === "start" ||
    value === "done" ||
    value === "upsert_done" ||
    value === "sync_from_plan" ||
    value === "block" ||
    value === "cancel" ||
    value === "delete" ||
    value === "restore" ||
    value === "remove" ||
    value === "note"
  )
    return value;
  throw new Error(
    `${path} must be init, append, start, done, upsert_done, sync_from_plan, block, cancel, delete, restore, remove, or note`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
