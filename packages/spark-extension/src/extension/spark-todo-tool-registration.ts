import { Type } from "typebox";
import {
  applyIndependentTodoOps,
  defaultTaskGraphStore,
  isDeletedSessionTodo,
  type SessionTodoEntry,
  type TaskTodoOp,
} from "@zendev-lab/spark-tasks";
import { currentSparkProject, sparkSessionKey } from "./session-state.ts";
import { loadIndependentTodos, saveIndependentTodos } from "./session-todos.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { normalizeOptionalToolString, normalizeToolStringArray } from "./task-plan-tool.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkTodoToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

type SparkTaskPlanItemOp = TaskTodoOp;

/** Action-style ops for the session-bound `todo` tool that map onto a single TODO op. */
const TODO_OP_ACTIONS = new Set<TaskTodoOp["op"]>([
  "init",
  "append",
  "start",
  "done",
  "upsert_done",
  "block",
  "cancel",
  "delete",
  "restore",
  "remove",
  "note",
]);

export function normalizeSparkTodoOps(
  value: unknown,
  path = "ops",
): SparkTaskPlanItemOp[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be a non-empty array`);
  if (value.length === 0) return undefined;
  return value.map((op, index) => normalizeSparkTodoOp(op, `${path}[${index}]`));
}

/**
 * Build a single TODO op from the session-bound `todo` tool's action-style params.
 * Returns undefined for the read-only `list` action.
 */
export function sparkTodoOpFromAction(
  action: string,
  params: Record<string, unknown>,
): SparkTaskPlanItemOp | undefined {
  if (action === "list") return undefined;
  if (!TODO_OP_ACTIONS.has(action as TaskTodoOp["op"]))
    throw new Error(`todo.action must be a valid checklist op, got: ${action}`);
  return normalizeSparkTodoOp({ ...params, op: action }, "todo");
}

export function registerSparkTodoTools(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkTodoToolDependencies,
): void {
  registerSparkTool({
    name: "impl_todo",
    label: "Spark Session TODOs",
    description:
      "Implementation for the session-bound todo tool: view or update the current session's standalone TODO checklist. These TODOs are not tied to a claimed task and survive reload/restart for this session.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | init | append | start | done | upsert_done | block | cancel | delete | restore | remove | note",
      }),
      id: Type.Optional(Type.String()),
      item: Type.Optional(Type.String()),
      items: Type.Optional(Type.Array(Type.String())),
      text: Type.Optional(Type.String()),
      blockedBy: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const action = normalizeOptionalToolString(params.action, "action") ?? "list";
      if (action === "list") {
        const todos = await loadIndependentTodos(cwd, ctx);
        return renderSessionTodos(todos, `Session TODOs: ${visibleCount(todos)} active.`);
      }
      const op = sparkTodoOpFromAction(action, params);
      if (!op)
        return {
          content: [{ type: "text", text: "todo op is required." }],
          details: { error: "missing_op" },
        };
      const todos = applyIndependentTodoOps(await loadIndependentTodos(cwd, ctx), [op]);
      await saveIndependentTodos(cwd, ctx, todos);
      await deps.refreshSparkWidget(cwd, ctx);
      return renderSessionTodos(todos, `Updated ${visibleCount(todos)} active session TODO(s).`);
    },
  });

  registerSparkTool({
    name: "impl_update_task_plan_items",
    label: "Spark Update Task plan items",
    description:
      "Implementation for task_write({ action: 'plan_update', scope: 'task' }): update plan items attached to this session's one currently claimed unfinished task. Only claimed unfinished tasks can have task plan items modified.",
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
      const taskSelector = normalizeOptionalToolString(params.task, "task");
      const ops = normalizeSparkTodoOps(params.ops);
      if (!ops)
        return {
          content: [{ type: "text", text: "plan item ops are required." }],
          details: { found: true, error: "missing_ops" },
        };
      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          const project = await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const task = resolveSessionClaimedTask(
            graph,
            project.ref,
            sparkSessionKey(ctx),
            taskSelector,
          );
          if (!task) return { error: "no_matching_claimed_task" as const };
          graph.applyTodoOps(task.ref, ops);
          return { task: graph.getTask(task.ref) };
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
            text: `Updated plan items for ${updated.result.task.title} (${updated.result.task.ref}).`,
          },
        ],
        details: {
          task: updated.result.task as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

function visibleCount(todos: SessionTodoEntry[]): number {
  return todos.filter((todo) => !isDeletedSessionTodo(todo)).length;
}

function renderSessionTodos(todos: SessionTodoEntry[], header: string) {
  const visible = todos.filter((todo) => !isDeletedSessionTodo(todo));
  const lines = [header];
  for (const todo of visible)
    lines.push(`  - [${todo.status}] ${todo.id ?? ""} ${todo.content}`.replace(/\s+/g, " ").trim());
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { todos: todos as unknown as Record<string, unknown>[] },
  };
}

function normalizeSparkTodoOp(value: unknown, path: string): SparkTaskPlanItemOp {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const op: SparkTaskPlanItemOp = { op: normalizeSparkTodoOpKind(value.op, `${path}.op`) };
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

function normalizeSparkTodoOpKind(value: unknown, path: string): SparkTaskPlanItemOp["op"] {
  if (
    value === "init" ||
    value === "append" ||
    value === "start" ||
    value === "done" ||
    value === "upsert_done" ||
    value === "block" ||
    value === "cancel" ||
    value === "delete" ||
    value === "restore" ||
    value === "remove" ||
    value === "note"
  )
    return value;
  throw new Error(
    `${path} must be init, append, start, done, upsert_done, block, cancel, delete, restore, remove, or note`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
