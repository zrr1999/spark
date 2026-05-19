/**
 * spark-widget.ts — Above-editor widget showing durable Spark thread/task state plus
 * the current task's TODO working set.
 *
 * Display model:
 *   ◆ Overview: background subagents: @agent-a, @agent-b
 *   ◆ Thread title (tasks: total / claimed / session)
 *   ├─ ◐ @agent task title
 *   │  ├─ ✓ #7 task TODO
 *   │  └─ ○ #12 task TODO
 *   └─ ◐ #3 independent session TODO
 */

export interface TaskEntry {
  title: string;
  status: "running" | "pending" | "blocked" | "done" | "failed" | "cancelled";
  claim?: "mine" | "subagent" | "other";
  agentLabel?: string;
  backgroundOwner?: "session";
  todos: SessionTodoEntry[];
}

export type SessionTodoStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled"
  | "deleted";

export interface SessionTodoEntry {
  id?: string;
  /** Permanent display number within the Pi session; not a row-position ordinal. */
  displayNumber?: number;
  content: string;
  status: SessionTodoStatus;
  notes?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SparkWidgetState {
  threadTitle?: string;
  tasks: TaskEntry[];
  independentTodos: SessionTodoEntry[];
  taskCountTotal: number;
  taskCountClaimed: number;
  taskCountClaimedBySession: number;
  outputLanguage: "zh" | "en";
}

export type SparkWidgetTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type SparkWidgetTui = {
  terminal: { columns: number };
  requestRender(): void;
};

const L = {
  zh: {
    running: "进行中",
    pending: "待处理",
    done: "已完成",
    failed: "失败",
    total: "总计",
    active: "进行中",
    doneLabel: "已完成",
    blocked: "受阻",
    task: "Task",
    tasks: "Tasks",
    claimed: "已认领",
    session: "当前会话",
    todos: "TODO",
    none: "无",
    more: "更多",
  },
  en: {
    running: "running",
    pending: "pending",
    done: "done",
    failed: "failed",
    total: "total",
    active: "active",
    doneLabel: "done",
    blocked: "blocked",
    task: "Task",
    tasks: "Tasks",
    claimed: "claimed",
    session: "session",
    todos: "TODO",
    none: "none",
    more: "more",
  },
} as const;

const MAX_WIDGET_LINES = 12;

export function renderSparkWidgetLines(
  state: SparkWidgetState,
  tui: SparkWidgetTui,
  theme: SparkWidgetTheme,
): string[] {
  const visibleTodos = state.independentTodos.filter(
    (todo) => todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted",
  );
  if (!state.threadTitle && state.tasks.length === 0 && visibleTodos.length === 0) return [];

  const l = L[state.outputLanguage] ?? L.en;
  const width = tui.terminal.columns;
  const trunc = (line: string) => (line.length <= width ? line : `${line.slice(0, width - 1)}…`);

  const lines: string[] = [];
  const background = currentSessionBackgroundSubagents(state.tasks);
  if (background.length > 0) {
    lines.push(trunc(formatOverviewLine(background, theme)));
  }

  if (state.threadTitle) {
    lines.push(
      trunc(
        `${theme.fg("accent", "◆")} ${theme.bold(state.threadTitle)} ${theme.fg(
          "dim",
          `(${l.tasks}: ${state.taskCountTotal}/${state.taskCountClaimed}/${state.taskCountClaimedBySession})`,
        )}`,
      ),
    );
  }

  const allRows = flattenWidgetRows(state.tasks, visibleTodos);
  const budget = Math.max(0, MAX_WIDGET_LINES - lines.length);
  const visibleRows = allRows.slice(0, budget);
  for (const row of visibleRows) {
    lines.push(trunc(formatWidgetRow(row, theme)));
  }
  const hidden = allRows.length - visibleRows.length;
  if (hidden > 0) {
    lines.push(trunc(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} ${l.more}`)}`));
  } else if (lines.length > 1) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace("├─", "└─");
  }

  return lines;
}

function formatOverviewLine(tasks: TaskEntry[], theme: SparkWidgetTheme): string {
  const labels = tasks.map((task) => `@${taskAgentLabel(task)}`);
  const shown = labels.slice(0, 4).join(", ");
  const hidden = labels.length > 4 ? ` +${labels.length - 4}` : "";
  return `${theme.fg("accent", "◆")} ${theme.bold("Overview:")} ${theme.fg(
    "accent",
    `background subagents (${tasks.length}): ${shown}${hidden}`,
  )}`;
}

function currentSessionBackgroundSubagents(tasks: TaskEntry[]): TaskEntry[] {
  const seen = new Set<string>();
  const result: TaskEntry[] = [];
  for (const task of tasks) {
    if (
      task.status !== "running" ||
      task.claim !== "subagent" ||
      task.backgroundOwner !== "session"
    )
      continue;
    const label = taskAgentLabel(task);
    const key = `${label}\u0000${task.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(task);
  }
  return result;
}

function taskIcon(status: TaskEntry["status"], theme: SparkWidgetTheme): string {
  switch (status) {
    case "running":
      return theme.fg("accent", "→");
    case "pending":
      return theme.fg("dim", "◻");
    case "blocked":
      return theme.fg("warning", "⏸");
    case "done":
      return theme.fg("success", "✓");
    case "cancelled":
      return theme.fg("dim", "⊘");
    case "failed":
      return theme.fg("error", "✗");
  }
}

function taskAgentLabel(task: TaskEntry): string {
  if (task.agentLabel?.trim()) return task.agentLabel.trim();
  switch (task.claim) {
    case "mine":
      return "me";
    case "other":
      return "other";
    case "subagent":
    default:
      return "unassigned";
  }
}

function formatTaskTitle(task: TaskEntry, theme: SparkWidgetTheme): string {
  const agentLabel = taskAgentLabel(task);
  const title = task.title.trim() || "Untitled task";
  const base = `${theme.fg(task.claim === "other" ? "dim" : "accent", `@${agentLabel}`)} ${title}`;
  if (task.status === "done" || task.status === "cancelled")
    return theme.fg("dim", theme.strikethrough(base));
  if (task.status === "failed") return theme.fg("error", base);
  if (task.status === "running") return theme.bold(base);
  return base;
}

type WidgetRow =
  | { kind: "task"; task: TaskEntry }
  | { kind: "task-todo"; todo: SessionTodoEntry; fallbackNumber: number }
  | { kind: "independent-todo"; todo: SessionTodoEntry; fallbackNumber: number };

function flattenWidgetRows(tasks: TaskEntry[], independentTodos: SessionTodoEntry[]): WidgetRow[] {
  const rows: WidgetRow[] = [];
  let todoIndex = 1;
  const visibleTasks = sortTasksForVisibility(tasks);
  for (const task of visibleTasks) {
    rows.push({ kind: "task", task });
    if (task.status === "done" || task.status === "cancelled") continue;
    for (const todo of sortTodosForVisibility(task.todos))
      rows.push({ kind: "task-todo", todo, fallbackNumber: todoIndex++ });
  }
  for (const todo of sortTodosForVisibility(independentTodos))
    rows.push({ kind: "independent-todo", todo, fallbackNumber: todoIndex++ });
  return rows;
}

function sortTasksForVisibility(tasks: TaskEntry[]): TaskEntry[] {
  return [...tasks].sort((a, b) => taskVisibilityRank(a) - taskVisibilityRank(b));
}

function taskVisibilityRank(task: TaskEntry): number {
  if (task.status === "running") return 0;
  if (task.status === "blocked") return 1;
  if (task.status === "pending") return 2;
  if (task.status === "failed") return 3;
  if (task.status === "done") return 4;
  return 5; // cancelled
}

function sortTodosForVisibility(todos: SessionTodoEntry[]): SessionTodoEntry[] {
  return [...todos].sort((a, b) => todoVisibilityRank(a) - todoVisibilityRank(b));
}

function todoVisibilityRank(todo: SessionTodoEntry): number {
  if (todo.status === "in_progress") return 0;
  if (todo.status === "blocked") return 1;
  if (todo.status === "pending") return 2;
  if (todo.status === "done") return 3;
  return 4; // cancelled/deleted
}

function formatWidgetRow(row: WidgetRow, theme: SparkWidgetTheme): string {
  switch (row.kind) {
    case "task":
      return `${theme.fg("dim", "├─")} ${taskIcon(row.task.status, theme)} ${formatTaskTitle(row.task, theme)}`;
    case "task-todo":
      return `${theme.fg("dim", "│  ├─")} ${todoIcon(row.todo.status, theme)} #${todoDisplayNumber(row.todo, row.fallbackNumber)} ${formatTodoContent(row.todo, theme)}`;
    case "independent-todo":
      return `${theme.fg("dim", "├─")} ${todoIcon(row.todo.status, theme)} #${todoDisplayNumber(row.todo, row.fallbackNumber)} ${formatTodoContent(row.todo, theme)}`;
  }
}

function todoDisplayNumber(todo: SessionTodoEntry, fallbackNumber: number): number {
  return Number.isInteger(todo.displayNumber) && (todo.displayNumber ?? 0) > 0
    ? (todo.displayNumber ?? fallbackNumber)
    : fallbackNumber;
}

function todoIcon(status: SessionTodoStatus, theme: SparkWidgetTheme): string {
  switch (status) {
    case "in_progress":
      return theme.fg("accent", "◐");
    case "blocked":
      return theme.fg("warning", "⛔");
    case "done":
      return theme.fg("success", "✓");
    case "cancelled":
    case "deleted":
      return theme.fg("error", "✗");
    case "pending":
      return theme.fg("dim", "○");
  }
}

function formatTodoContent(todo: SessionTodoEntry, theme: SparkWidgetTheme): string {
  if (todo.status === "done" || todo.status === "cancelled" || todo.status === "deleted") {
    return theme.fg("dim", theme.strikethrough(todo.content));
  }
  if (todo.status === "pending") return theme.fg("dim", todo.content);
  return todo.content;
}

export class SparkWidget {
  private registered = false;
  private tui: SparkWidgetTui | undefined;
  private readState: () => SparkWidgetState | undefined;
  private registerWidget: (
    key: string,
    cb:
      | ((
          tui: SparkWidgetTui,
          theme: SparkWidgetTheme,
        ) => { render(): string[]; invalidate(): void })
      | undefined,
  ) => void;

  constructor(
    readState: () => SparkWidgetState | undefined,
    registerWidget: (
      key: string,
      cb:
        | ((
            tui: SparkWidgetTui,
            theme: SparkWidgetTheme,
          ) => { render(): string[]; invalidate(): void })
        | undefined,
    ) => void,
  ) {
    this.readState = readState;
    this.registerWidget = registerWidget;
  }

  update() {
    const state = this.readState();
    if (
      !state ||
      (!state.threadTitle && state.tasks.length === 0 && state.independentTodos.length === 0)
    ) {
      if (this.registered) {
        this.registerWidget("spark-status", undefined);
        this.registered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.registered) {
      this.registerWidget("spark-status", (tui, theme) => {
        this.tui = tui;
        return {
          render: () =>
            renderSparkWidgetLines(this.readState() ?? ({} as SparkWidgetState), tui, theme),
          invalidate: () => {},
        };
      });
      this.registered = true;
    } else if (this.tui) {
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.registered) this.registerWidget("spark-status", undefined);
    this.registered = false;
    this.tui = undefined;
  }
}
