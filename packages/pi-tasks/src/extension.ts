import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent, ToolRenderTheme } from "pi-extension-api";

export type PiTaskAction =
  | "status"
  | "project_list"
  | "project_use"
  | "project_update"
  | "claim"
  | "plan"
  | "finish"
  | "todo_update"
  | "run_ready"
  | "run_status"
  | "run_control"
  | "cache_cleanup";

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

const TASK_ACTIONS: readonly PiTaskAction[] = [
  "status",
  "project_list",
  "project_use",
  "project_update",
  "claim",
  "plan",
  "finish",
  "todo_update",
  "run_ready",
  "run_status",
  "run_control",
  "cache_cleanup",
];

export function registerPiTaskTool(pi: PiTaskExtensionApi, options: PiTaskToolOptions): void {
  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Canonical project/task/TODO/run graph capability. Use action to list/use/update projects, plan/claim/finish tasks, update TODOs, and inspect/control task runs.",
    promptGuidelines: [
      "Use task as the canonical task/project/TODO/run tool instead of Spark-specific task aliases.",
      "Use todo_update with scope=session or scope=task; TODOs are not a separate package/tool.",
      "Use run_control only with explicit runRef/taskRef/all:true selectors; broad destructive operations must never be implicit.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "status | project_list | project_use | project_update | claim | plan | finish | todo_update | run_ready | run_status | run_control | cache_cleanup",
      }),
      scope: Type.Optional(Type.String({ description: "For todo_update: session | task." })),
      project: Type.Optional(Type.String({ description: "Project selector/ref/title." })),
      projectRef: Type.Optional(Type.String({ description: "Project ref filter or selector." })),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(Type.String({ description: "Task ref/name/title selector." })),
      title: Type.Optional(Type.String({ description: "Project/task title." })),
      description: Type.Optional(Type.String({ description: "Project/task description." })),
      name: Type.Optional(Type.String({ description: "Stable @task name for claim/plan." })),
      kind: Type.Optional(Type.String({ description: "Task kind." })),
      status: Type.Optional(
        Type.String({ description: "Task/project/status view depending on action." }),
      ),
      outputLanguage: Type.Optional(Type.String({ description: "Project output language." })),
      roleRef: Type.Optional(Type.String({ description: "Preferred role ref for a task." })),
      plan: Type.Optional(Type.Any({ description: "Task plan patch or plan metadata." })),
      tasks: Type.Optional(Type.Array(Type.Any({ description: "Concrete task plan entries." }))),
      dependsOn: Type.Optional(
        Type.Array(Type.String({ description: "Task dependency selectors." })),
      ),
      todos: Type.Optional(Type.Array(Type.String({ description: "Initial task TODOs." }))),
      ops: Type.Optional(Type.Array(Type.Any({ description: "TODO operation entries." }))),
      items: Type.Optional(Type.Array(Type.String({ description: "TODO item text list." }))),
      item: Type.Optional(Type.String({ description: "TODO item text." })),
      id: Type.Optional(Type.String({ description: "TODO id." })),
      text: Type.Optional(
        Type.String({ description: "TODO note/free text or completion summary." }),
      ),
      summary: Type.Optional(Type.String({ description: "Task completion/failure summary." })),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Dry-run for scheduling/cleanup actions." }),
      ),
      maxConcurrency: Type.Optional(Type.Number({ description: "run_ready concurrency limit." })),
      timeoutMs: Type.Optional(Type.Number({ description: "run_ready foreground wait budget." })),
      includeHistory: Type.Optional(Type.Boolean({ description: "Include terminal run history." })),
      includeDetails: Type.Optional(Type.Boolean({ description: "Expand task/run records." })),
      runRef: Type.Optional(Type.String({ description: "Run ref selector." })),
      runAction: Type.Optional(
        Type.String({ description: "For run_status: status | list | inspect | reconcile." }),
      ),
      control: Type.Optional(
        Type.String({ description: "For run_control: kill | reconcile | ack." }),
      ),
      signal: Type.Optional(Type.String({ description: "Kill signal for run_control kill." })),
      forceAfterMs: Type.Optional(Type.Number({ description: "Kill force delay." })),
      all: Type.Optional(Type.Boolean({ description: "Explicit broad run_control selector." })),
      view: Type.Optional(Type.String({ description: "For status: active | summary | full." })),
      format: Type.Optional(Type.String({ description: "For status: text | json." })),
      limit: Type.Optional(Type.Number({ description: "Bounded row/list limit." })),
      showFinished: Type.Optional(Type.Boolean({ description: "Deprecated full status alias." })),
      olderThanDays: Type.Optional(Type.Number({ description: "cache_cleanup staleness cutoff." })),
      includeBroken: Type.Optional(
        Type.Boolean({ description: "cache_cleanup malformed-cache flag." }),
      ),
    }),
    renderCall(args, theme) {
      return renderTaskCall(args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizePiTaskAction(params.action);
      const handler = options.handlers[action];
      if (!handler) throw new Error(`task action is not available in this host: ${action}`);
      return handler({ toolCallId, params, signal, onUpdate, ctx });
    },
  });
}

function renderTaskCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const task =
    typeof args.task === "string"
      ? args.task
      : typeof args.taskRef === "string"
        ? args.taskRef
        : undefined;
  const project = typeof args.project === "string" ? args.project : undefined;
  const text = ["task", action, task ?? project].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}

function normalizePiTaskAction(value: unknown): PiTaskAction {
  if (TASK_ACTIONS.includes(value as PiTaskAction)) return value as PiTaskAction;
  throw new Error(`task.action must be one of: ${TASK_ACTIONS.join(", ")}`);
}
