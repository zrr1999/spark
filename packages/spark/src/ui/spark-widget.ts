import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * spark-widget.ts — Above-editor widget showing durable Spark thread/task state plus
 * the current task's TODO working set.
 *
 * Display model:
 *   ◆ Tasks(running=2 pending=1 failed=1): @agent-a, @agent-b
 *   ◆ Thread title
 *   ├─ ◐ @me/worker role-run task title
 *   │  ├─ ✓ #7 task TODO
 *   │  └─ ○ #12 task TODO
 *   └─ ◐ #3 independent session TODO
 */

export interface TaskEntry {
  title: string;
  status: "running" | "pending" | "blocked" | "done" | "failed" | "cancelled";
  claim?: "mine" | "role-run" | "other";
  animationFrame?: number;
  agentLabel?: string;
  /** @deprecated use agentLabel until UI naming fully migrates. */
  roleLabel?: string;
  backgroundOwner?: "session";
  /** True when a running agent is parked on user/input rather than actively working. */
  waitingForInput?: boolean;
  planIssueSummary?: string;
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
  /** Animation frame for running task spinners. Omit for the first/static frame. */
  animationFrame?: number;
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
const RUNNING_TASK_SPINNER_FRAMES = ["⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸", "⠼"] as const;
const RUNNING_TASK_WAITING_ICON = "◼";
const RUNNING_TASK_SPINNER_INTERVAL_MS = 140;

const EMPTY_WIDGET_STATE: SparkWidgetState = {
  tasks: [],
  independentTodos: [],
  taskCountTotal: 0,
  taskCountClaimed: 0,
  taskCountClaimedBySession: 0,
  outputLanguage: "en",
  animationFrame: 0,
};

function isVisibleIndependentTodo(todo: SessionTodoEntry): boolean {
  return todo.status !== "done" && todo.status !== "cancelled" && todo.status !== "deleted";
}

function isVisibleTaskTodo(todo: SessionTodoEntry): boolean {
  return todo.status !== "deleted";
}

function hasWidgetContent(state: SparkWidgetState | undefined): state is SparkWidgetState {
  return Boolean(
    state &&
    (state.threadTitle ||
      state.tasks.length > 0 ||
      state.independentTodos.some(isVisibleIndependentTodo)),
  );
}

function hasAnimatedRunningTask(state: SparkWidgetState | undefined): boolean {
  return Boolean(
    state?.tasks.some(
      (task) =>
        task.status === "running" &&
        task.claim === "role-run" &&
        task.waitingForInput !== true &&
        task.backgroundOwner === "session",
    ),
  );
}

export function renderSparkWidgetLines(
  state: SparkWidgetState,
  tui: SparkWidgetTui,
  theme: SparkWidgetTheme,
): string[] {
  const visibleTodos = state.independentTodos.filter(isVisibleIndependentTodo);
  if (!state.threadTitle && state.tasks.length === 0 && visibleTodos.length === 0) return [];

  const l = L[state.outputLanguage] ?? L.en;
  const width = tui.terminal.columns;
  const trunc = (line: string) => truncateToWidth(line, Math.max(1, width), "…");

  const lines: string[] = [];
  const visibleTasks = state.tasks.filter(isVisibleTaskEntry);

  const summaryLine = formatTaskSummaryLine(state, visibleTasks, l.tasks, theme);
  if (summaryLine) lines.push(trunc(summaryLine));

  if (state.threadTitle) {
    lines.push(trunc(`${theme.fg("accent", "◆")} ${theme.bold(state.threadTitle)}`));
  }

  const tasks = visibleTasks.map((task) => ({
    ...task,
    animationFrame: task.animationFrame ?? state.animationFrame ?? 0,
  }));
  const allRows = flattenWidgetRows(tasks, visibleTodos);
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

function formatTaskSummaryLine(
  state: SparkWidgetState,
  visibleTasks: TaskEntry[],
  tasksLabel: string,
  theme: SparkWidgetTheme,
): string | undefined {
  if (state.taskCountTotal === 0 && visibleTasks.length === 0) return undefined;
  if (visibleTasks.length === 0 && state.tasks.length > 0) return undefined;
  const taskSummary = formatTaskSummary(state, visibleTasks);
  const agentSummary = formatRunningAgentSummary(visibleTasks);
  const suffix = agentSummary ? `${taskSummary}: ${agentSummary}` : taskSummary;
  return `${theme.fg("accent", "◆")} ${theme.fg("dim", `${tasksLabel}(${suffix})`)}`;
}

function formatTaskSummary(state: SparkWidgetState, visibleTasks: TaskEntry[]): string {
  const activeTasks = visibleTasks.filter((task) =>
    ["running", "pending", "blocked", "failed"].includes(task.status),
  );
  if (activeTasks.length === 0) {
    return `total=${state.taskCountTotal} claimed=${state.taskCountClaimed}/${state.taskCountClaimedBySession}`;
  }
  const counts = new Map<TaskEntry["status"], number>();
  for (const task of activeTasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return (["running", "pending", "blocked", "failed"] as const)
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? `${status}=${count}` : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function formatRunningAgentSummary(tasks: TaskEntry[]): string | undefined {
  const runningLabels = dedupeTaskAgentLabels(
    tasks
      .filter(
        (task) =>
          task.status === "running" &&
          task.claim === "role-run" &&
          task.backgroundOwner === "session",
      )
      .map(taskAgentLabel),
  );
  if (runningLabels.length === 0) return undefined;
  const shown = runningLabels
    .slice(0, 4)
    .map((label) => `@${label}`)
    .join(", ");
  const hidden = runningLabels.length > 4 ? ` +${runningLabels.length - 4}` : "";
  return `${shown}${hidden}`;
}

function isVisibleTaskEntry(task: TaskEntry): boolean {
  if (isFinishedTaskStatus(task.status) && isOtherSessionAgentLabel(task.agentLabel)) return false;
  return true;
}

function isFinishedTaskStatus(status: TaskEntry["status"]): boolean {
  return status === "done" || status === "cancelled";
}

function isOtherSessionAgentLabel(label: string | undefined): boolean {
  const normalized = label?.trim();
  return Boolean(
    normalized &&
    normalized !== "unassigned" &&
    normalized !== "me" &&
    !normalized.startsWith("me/"),
  );
}

function dedupeTaskAgentLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}

function taskIcon(task: TaskEntry, theme: SparkWidgetTheme): string {
  switch (task.status) {
    case "running":
      return theme.fg("accent", runningTaskIcon(task));
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

function runningTaskIcon(task: TaskEntry): string {
  if (task.waitingForInput) return RUNNING_TASK_WAITING_ICON;
  if (task.claim === "other") return RUNNING_TASK_WAITING_ICON;
  if (task.claim !== "role-run") return "→";
  if (task.backgroundOwner !== "session") return RUNNING_TASK_WAITING_ICON;
  const frame = taskAnimationFrame(task);
  return RUNNING_TASK_SPINNER_FRAMES[frame % RUNNING_TASK_SPINNER_FRAMES.length];
}

function taskAnimationFrame(task: TaskEntry): number {
  return Number.isInteger(task.animationFrame) ? Math.max(0, task.animationFrame ?? 0) : 0;
}

function taskAgentLabel(task: TaskEntry): string {
  if ((task.agentLabel ?? task.roleLabel)?.trim())
    return (task.agentLabel ?? task.roleLabel)?.trim() ?? "";
  switch (task.claim) {
    case "mine":
      return "me";
    case "other":
      return "other";
    case "role-run":
    default:
      return "unassigned";
  }
}

function formatTaskTitle(task: TaskEntry, theme: SparkWidgetTheme): string {
  const actorLabel = taskActorLabel(task);
  const title = task.title.trim() || "Untitled task";
  const base = actorLabel
    ? `${theme.fg(task.claim === "other" ? "dim" : "accent", actorLabel)} ${title}`
    : title;
  if (task.status === "done" || task.status === "cancelled")
    return theme.fg("dim", theme.strikethrough(base));
  const withPlanIssue = task.planIssueSummary
    ? `${base} ${theme.fg("warning", `plan:${task.planIssueSummary}`)}`
    : base;
  if (task.status === "failed") return theme.fg("error", withPlanIssue);
  if (task.status === "running") return theme.bold(withPlanIssue);
  return withPlanIssue;
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
    for (const todo of sortTodosForVisibility(task.todos.filter(isVisibleTaskTodo)))
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
  if (task.status === "running" && task.backgroundOwner === "session") return 0;
  if (task.status === "blocked") return 1;
  if (task.status === "running") return 2;
  if (task.status === "pending") return 3;
  if (task.status === "failed") return 4;
  if (task.status === "done") return 5;
  return 6; // cancelled
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

function taskActorLabel(task: TaskEntry): string | undefined {
  const agentLabel = taskAgentLabel(task);
  if (task.claim === "role-run") {
    if (agentLabel.includes("/")) return `@${agentLabel}`;
    return task.backgroundOwner === "session" ? `@me/${agentLabel}` : `@${agentLabel}`;
  }
  if (task.claim === "mine" && (task.agentLabel ?? task.roleLabel)?.trim()) return `@${agentLabel}`;
  if (task.claim === "other") return `@${agentLabel}`;
  return undefined;
}

function formatWidgetRow(row: WidgetRow, theme: SparkWidgetTheme): string {
  switch (row.kind) {
    case "task":
      return `${theme.fg("dim", "├─")} ${taskIcon(row.task, theme)} ${formatTaskTitle(row.task, theme)}`;
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
      return theme.fg("warning", "⏸");
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
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private animationFrame = 0;
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
    if (!hasWidgetContent(state)) {
      if (this.registered) {
        this.registerWidget("spark-status", undefined);
        this.registered = false;
        this.tui = undefined;
      }
      this.clearSpinnerTimer();
      return;
    }

    if (!this.registered) {
      this.registerWidget("spark-status", (tui, theme) => {
        this.tui = tui;
        return {
          render: () =>
            renderSparkWidgetLines(
              {
                ...(this.readState() ?? EMPTY_WIDGET_STATE),
                animationFrame: this.animationFrame,
              },
              tui,
              theme,
            ),
          invalidate: () => {},
        };
      });
      this.registered = true;
    } else if (this.tui) {
      this.tui.requestRender();
    }

    this.updateSpinnerTimer(state);
  }

  private updateSpinnerTimer(state: SparkWidgetState | undefined): void {
    if (hasAnimatedRunningTask(state)) {
      if (this.spinnerTimer) return;
      this.spinnerTimer = setInterval(() => {
        this.animationFrame = (this.animationFrame + 1) % RUNNING_TASK_SPINNER_FRAMES.length;
        this.tui?.requestRender();
      }, RUNNING_TASK_SPINNER_INTERVAL_MS);
      this.spinnerTimer.unref?.();
      return;
    }
    this.clearSpinnerTimer();
  }

  private clearSpinnerTimer(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.animationFrame = 0;
  }

  dispose() {
    if (this.registered) this.registerWidget("spark-status", undefined);
    this.registered = false;
    this.tui = undefined;
    this.clearSpinnerTimer();
  }
}
