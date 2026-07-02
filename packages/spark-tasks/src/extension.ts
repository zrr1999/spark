import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-extension-api";

export type PiTaskReadAction =
  | "task_status"
  | "project_status"
  | "workspace_status"
  | "project_list"
  | "run_status";
export type PiTaskWriteAction =
  | "project_use"
  | "project_rename"
  | "project_metadata_update"
  | "claim"
  | "plan"
  | "finish"
  | "recover"
  | "todo_update"
  | "cache_cleanup";
export type PiTaskAssignAction = "assign";
export type PiTaskAction = PiTaskReadAction | PiTaskWriteAction | PiTaskAssignAction;

type ToolExecute = ToolConfig["execute"];
type ToolOnUpdate = Parameters<ToolExecute>[3];
type ToolContext = Parameters<ToolExecute>[4];

export type PiTaskToolResult = Awaited<ReturnType<ToolExecute>>;

export interface PiTaskActionHandlerArgs {
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onUpdate: ToolOnUpdate;
  ctx: ToolContext;
}

export type PiTaskActionHandler = (args: PiTaskActionHandlerArgs) => Promise<PiTaskToolResult>;

export type PiTaskToolHandlers = Partial<Record<PiTaskAction, PiTaskActionHandler>>;

export interface PiTaskExtensionApi {
  registerTool(config: ToolConfig): void;
}

export interface PiTaskToolOptions {
  handlers: PiTaskToolHandlers;
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [
      this.text.length > width ? `${this.text.slice(0, Math.max(0, width - 1))}…` : this.text,
    ];
  }
}

const TASK_READ_ACTIONS: readonly PiTaskReadAction[] = [
  "task_status",
  "project_status",
  "workspace_status",
  "project_list",
  "run_status",
];

const TASK_WRITE_ACTIONS: readonly PiTaskWriteAction[] = [
  "project_use",
  "project_rename",
  "project_metadata_update",
  "claim",
  "plan",
  "finish",
  "recover",
  "todo_update",
  "cache_cleanup",
];

export function registerPiTaskTool(pi: PiTaskExtensionApi, options: PiTaskToolOptions): void {
  pi.registerTool({
    name: "task_read",
    label: "Task Read",
    description:
      "Read-only project/task/TODO/run graph capability. Use action=task_status for one task, project_status for one project, workspace_status for the broad workspace summary, project_list for project lists, or run_status for task-run status.",
    promptGuidelines: [
      "Use task_read for project/task/TODO/run graph inspection only.",
      "Use task_write for project/task/TODO graph mutations.",
      "Use assign for explicit role-run spawning; task_read never schedules or controls child runs.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "task_status | project_status | workspace_status | project_list | run_status",
      }),
      project: Type.Optional(Type.String({ description: "Project selector/ref/title." })),
      projectRef: Type.Optional(Type.String({ description: "Project ref filter or selector." })),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(Type.String({ description: "Task ref/name/title selector." })),
      status: Type.Optional(Type.String({ description: "Project-list status filter." })),
      includeHistory: Type.Optional(Type.Boolean({ description: "Include terminal run history." })),
      includeWorkspaceSummary: Type.Optional(
        Type.Boolean({
          description: "For scoped status actions, include broad workspace summary.",
        }),
      ),
      includeStateSummary: Type.Optional(
        Type.Boolean({ description: "For status actions, include Spark state/cache summary." }),
      ),
      runRef: Type.Optional(Type.String({ description: "Run ref selector." })),
      runAction: Type.Optional(
        Type.String({ description: "For run_status: status | list | inspect | reconcile." }),
      ),
      view: Type.Optional(
        Type.String({
          description: "For workspace_status/project_status/task_status: active | summary.",
        }),
      ),
      format: Type.Optional(
        Type.String({
          description: "For workspace_status/project_status/task_status: text | json.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Bounded row/list limit." })),
    }),
    renderCall(args, theme) {
      return renderTaskCall("task_read", args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizePiTaskReadAction(params.action);
      return executePiTaskAction("task_read", action, options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });

  pi.registerTool({
    name: "task_write",
    label: "Task Write",
    description:
      "Project/task/TODO graph mutation capability. Use intent-specific actions to select/finish/rename/update projects, claim/plan/finish tasks, update TODOs, or clean task-owned caches.",
    promptGuidelines: [
      "Use task_write for project/task/TODO graph mutations.",
      "Creating or claiming a task is plan-locked: every task must have a bound task.plan before claim/creation completes.",
      "Use assign for explicit role-run spawning; task_write does not expose run_ready or run_control.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "project_use | project_rename | project_metadata_update | claim | plan | finish | recover | todo_update | cache_cleanup",
      }),
      scope: Type.Optional(Type.String({ description: "For todo_update: task plan items only." })),
      project: Type.Optional(Type.String({ description: "Project selector/ref/title." })),
      projectRef: Type.Optional(Type.String({ description: "Project ref filter or selector." })),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(Type.String({ description: "Task ref/name/title selector." })),
      title: Type.Optional(Type.String({ description: "Project/task title." })),
      description: Type.Optional(Type.String({ description: "Project/task description." })),
      purpose: Type.Optional(Type.String({ description: "Project purpose." })),
      name: Type.Optional(Type.String({ description: "Stable @task name for claim/plan." })),
      kind: Type.Optional(
        Type.String({
          description:
            "Project kind id for project_use/project_metadata_update, or optional task executor hint: research | implement | review. Omit for normal work.",
        }),
      ),
      kindState: Type.Optional(
        Type.Any({
          description: "Project-kind-specific JSON state for project_use/project_metadata_update.",
        }),
      ),
      status: Type.Optional(
        Type.String({ description: "Task status for task finish/creation paths." }),
      ),
      outputLanguage: Type.Optional(Type.String({ description: "Project output language." })),
      roleRef: Type.Optional(
        Type.String({
          description:
            "Executor role ref for hosts that bind reusable role specs; omit for normal task planning.",
        }),
      ),
      plan: Type.Optional(Type.Any({ description: "Task plan patch or plan metadata." })),
      tasks: Type.Optional(Type.Array(Type.Any({ description: "Concrete task plan entries." }))),
      dependsOn: Type.Optional(
        Type.Array(Type.String({ description: "Task dependency selectors." })),
      ),
      todos: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Initial task plan items for task-creation handlers that explicitly support them; plan-aware handlers may also derive plan items from task.plan.",
          }),
        ),
      ),
      ops: Type.Optional(
        Type.Array(
          Type.Any({
            description:
              "Plan-item operation entries, e.g. init/append/start/done/upsert_done/block/cancel/delete/restore/remove/note.",
          }),
        ),
      ),
      items: Type.Optional(Type.Array(Type.String({ description: "TODO item text list." }))),
      item: Type.Optional(Type.String({ description: "TODO item text." })),
      id: Type.Optional(Type.String({ description: "TODO id." })),
      text: Type.Optional(
        Type.String({ description: "TODO note/free text or completion summary." }),
      ),
      summary: Type.Optional(Type.String({ description: "Task completion/failure summary." })),
      evidenceRefs: Type.Optional(
        Type.Array(Type.String({ description: "Artifact refs that evidence task completion." })),
      ),
      evidence: Type.Optional(
        Type.Any({
          description:
            "Optional structured finish evidence. Spark can turn validationCommands, changedFiles, sourceRefs, and notes into a bounded task evidence artifact automatically.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Dry-run for task-owned cache cleanup actions." }),
      ),
      olderThanDays: Type.Optional(Type.Number({ description: "cache_cleanup staleness cutoff." })),
      includeBroken: Type.Optional(
        Type.Boolean({ description: "cache_cleanup malformed-cache flag." }),
      ),
    }),
    renderCall(args, theme) {
      return renderTaskCall("task_write", args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizePiTaskWriteAction(params.action);
      return executePiTaskAction("task_write", action, options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });

  pi.registerTool({
    name: "assign",
    label: "Assign",
    description:
      "Explicit Spark assignment/spawn capability. Schedule the ready task frontier through the workflow runtime; dry-run by default.",
    promptGuidelines: [
      "Use assign only when ready Spark work should be dispatched to role runs.",
      "Prefer workflow runtime for parallel/scripted execution; assign is the explicit spawn surface for Spark ready-task frontiers.",
      "Use task_read for inspection and task_write for graph mutations before assigning work.",
    ],
    parameters: Type.Object({
      dryRun: Type.Optional(
        Type.Boolean({
          description: "Dry-run assignment without spawning child role runs. Default true.",
        }),
      ),
      maxConcurrency: Type.Optional(Type.Number({ description: "Assignment concurrency limit." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Foreground wait budget." })),
    }),
    renderCall(args, theme) {
      const dryRun = args.dryRun === false ? "spawn" : "dry-run";
      const concurrency =
        typeof args.maxConcurrency === "number" ? `max=${args.maxConcurrency}` : undefined;
      const text = ["assign", dryRun, concurrency].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executePiTaskAction("assign", "assign", options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });
}

function executePiTaskAction(
  toolName: string,
  action: PiTaskAction,
  options: PiTaskToolOptions,
  args: PiTaskActionHandlerArgs,
): Promise<PiTaskToolResult> {
  const handler = options.handlers[action];
  if (!handler) throw new Error(`${toolName} action is not available in this host: ${action}`);
  return handler(args);
}

function renderTaskCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : undefined;
  const task =
    typeof args.task === "string"
      ? args.task
      : typeof args.taskRef === "string"
        ? args.taskRef
        : undefined;
  const project = typeof args.project === "string" ? args.project : undefined;
  const text = [toolName, action && `action=${action}`, task ?? project].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}

function normalizePiTaskReadAction(value: unknown): PiTaskReadAction {
  if (TASK_READ_ACTIONS.includes(value as PiTaskReadAction)) return value as PiTaskReadAction;
  throw new Error(`task_read.action must be one of: ${TASK_READ_ACTIONS.join(", ")}`);
}

function normalizePiTaskWriteAction(value: unknown): PiTaskWriteAction {
  if (TASK_WRITE_ACTIONS.includes(value as PiTaskWriteAction)) return value as PiTaskWriteAction;
  throw new Error(`task_write.action must be one of: ${TASK_WRITE_ACTIONS.join(", ")}`);
}
