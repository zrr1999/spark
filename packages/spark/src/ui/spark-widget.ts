import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SessionTodoEntry, SessionTodoStatus } from "@zendev-lab/pi-tasks";

export type { SessionTodoEntry, SessionTodoStatus } from "@zendev-lab/pi-tasks";

/**
 * spark-widget.ts — Above-editor widget showing durable Spark project/task state plus
 * the current task's TODO working set.
 *
 * Display model:
 *   ◆ Goal(●): active objective
 *   ◆ Session TODOs(pending=1)
 *   └─ ○ #3 independent session TODO
 *   ◆ Project title · Tasks(running=2 pending=1 failed=1): @agent-a, @agent-b
 *   ├─ ◐ @me/worker role-run task title
 *   │  ├─ ✓ #7 task TODO
 *   │  └─ ○ #12 task TODO
 */

export interface TaskEntry {
  title: string;
  status: "running" | "pending" | "blocked" | "done" | "failed" | "cancelled";
  claim?: "mine" | "role-run" | "other";
  animationFrame?: number;
  agentLabel?: string;
  backgroundOwner?: "session";
  /** True when a running agent is parked on user/input rather than actively working. */
  waitingForInput?: boolean;
  planSummary?: "missing";
  todos: SessionTodoEntry[];
}

export interface SparkDagWidgetEntry {
  status: "running" | "succeeded" | "failed" | "timed_out" | "stale";
  runRef?: string;
  scheduled: number;
  completed: number;
  active?: boolean;
}

export interface SparkRunWidgetEntry {
  status: "running" | "paused" | "blocked" | "done" | "failed" | "cancelled";
  runRef: string;
  focus?: string;
}

export interface SparkGoalWidgetEntry {
  status: "active" | "paused" | "complete";
  objective: string;
}

export interface SparkWidgetState {
  projectTitle?: string;
  dag?: SparkDagWidgetEntry;
  run?: SparkRunWidgetEntry;
  goal?: SparkGoalWidgetEntry;
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
    sessionTodos: "会话 TODO",
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
    sessionTodos: "Session TODOs",
    none: "none",
    more: "more",
  },
} as const;

const MAX_WIDGET_LINES = 12;
const RUNNING_TASK_SPINNER_FRAMES = ["⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸", "⠼"] as const;
const ACTIVE_GOAL_PULSE_FRAMES = ["●", "●", "◉", "◉", "◎", "◎", "◉", "◉"] as const;
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
    (state.projectTitle ||
      state.dag ||
      state.run ||
      state.goal ||
      state.tasks.length > 0 ||
      state.independentTodos.some(isVisibleIndependentTodo)),
  );
}

function hasAnimatedWidgetContent(state: SparkWidgetState | undefined): boolean {
  return Boolean(state?.goal?.status === "active" || hasAnimatedRunningTask(state));
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
  if (
    !state.projectTitle &&
    !state.dag &&
    !state.run &&
    !state.goal &&
    state.tasks.length === 0 &&
    visibleTodos.length === 0
  )
    return [];

  const l = L[state.outputLanguage] ?? L.en;
  const width = tui.terminal.columns;
  const trunc = (line: string) => truncateToWidth(line, Math.max(1, width), "…");

  const lines: string[] = [];
  const visibleTasks = state.tasks.filter(isVisibleTaskEntry);

  const goalLine = formatGoalLine(state.goal, theme, state.animationFrame ?? 0);
  const sessionTodosHeaderLine = formatSessionTodosHeaderLine(visibleTodos, l.sessionTodos, theme);
  const projectHeaderLine = formatProjectHeaderLine(state, visibleTasks, l.tasks, theme);
  const backgroundLine = hasSessionRunningAgent(visibleTasks)
    ? undefined
    : formatBackgroundLine(state.dag, state.run, theme);

  const tasks = visibleTasks.map((task) => ({
    ...task,
    animationFrame: task.animationFrame ?? state.animationFrame ?? 0,
  }));
  const sessionRows = flattenSessionTodoRows(visibleTodos);
  const projectRows = flattenTaskRows(tasks);
  const fixedLineCount = [
    goalLine,
    sessionTodosHeaderLine,
    projectHeaderLine,
    backgroundLine,
  ].filter(Boolean).length;
  const budget = Math.max(0, MAX_WIDGET_LINES - fixedLineCount);
  const visibleSessionRows = sessionRows.slice(0, budget);
  const visibleProjectRows = projectRows.slice(0, Math.max(0, budget - visibleSessionRows.length));
  const hidden =
    sessionRows.length + projectRows.length - visibleSessionRows.length - visibleProjectRows.length;

  if (goalLine) lines.push(trunc(goalLine));
  if (sessionTodosHeaderLine) lines.push(trunc(sessionTodosHeaderLine));
  appendFormattedRows(
    lines,
    visibleSessionRows,
    hidden > 0 && visibleProjectRows.length === 0,
    theme,
    trunc,
  );
  if (projectHeaderLine) lines.push(trunc(projectHeaderLine));
  if (backgroundLine) lines.push(trunc(backgroundLine));
  appendFormattedRows(lines, visibleProjectRows, hidden > 0, theme, trunc);
  if (hidden > 0) {
    lines.push(trunc(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} ${l.more}`)}`));
  }

  return lines;
}

function hasSessionRunningAgent(tasks: TaskEntry[]): boolean {
  return tasks.some(
    (task) =>
      task.status === "running" && task.claim === "role-run" && task.backgroundOwner === "session",
  );
}

function formatGoalLine(
  goal: SparkGoalWidgetEntry | undefined,
  theme: SparkWidgetTheme,
  animationFrame: number,
): string | undefined {
  if (!goal) return undefined;
  const status = theme.fg(
    goalStatusColor(goal.status),
    goalStatusSymbol(goal.status, animationFrame),
  );
  const summary = `${theme.fg("dim", "Goal(")}${status}${theme.fg("dim", `): ${goal.objective}`)}`;
  return `${theme.fg("accent", "◆")} ${summary}`;
}

function goalStatusSymbol(status: SparkGoalWidgetEntry["status"], animationFrame: number): string {
  if (status === "active") {
    const frame = Number.isInteger(animationFrame) ? Math.max(0, animationFrame) : 0;
    return ACTIVE_GOAL_PULSE_FRAMES[frame % ACTIVE_GOAL_PULSE_FRAMES.length];
  }
  if (status === "paused") return "⏸";
  return "✓";
}

function goalStatusColor(status: SparkGoalWidgetEntry["status"]): string {
  if (status === "active") return "accent";
  if (status === "paused") return "warning";
  return "success";
}

function formatSessionTodosHeaderLine(
  todos: SessionTodoEntry[],
  sessionTodosLabel: string,
  theme: SparkWidgetTheme,
): string | undefined {
  if (todos.length === 0) return undefined;
  return `${theme.fg("accent", "◆")} ${theme.fg(
    "dim",
    `${sessionTodosLabel}(${formatTodoStatusSummary(todos)})`,
  )}`;
}

function formatTodoStatusSummary(todos: SessionTodoEntry[]): string {
  const counts = new Map<SessionTodoStatus, number>();
  for (const todo of todos) counts.set(todo.status, (counts.get(todo.status) ?? 0) + 1);
  return (["in_progress", "blocked", "pending"] as const)
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? `${status}=${count}` : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function formatBackgroundLine(
  dag: SparkDagWidgetEntry | undefined,
  run: SparkRunWidgetEntry | undefined,
  theme: SparkWidgetTheme,
): string | undefined {
  if (!dag && !run) return undefined;
  const body = dag ? formatBackgroundDagSummary(dag) : formatBackgroundRunSummary(run);
  return `${theme.fg("accent", "◆")} ${theme.fg("dim", body)}`;
}

function formatBackgroundDagSummary(dag: SparkDagWidgetEntry): string {
  const status = dag.active ? "running" : dag.status;
  const statusLabel = formatBackgroundStatusLabel(status);
  const ref = dag.runRef ? ` · ${shortDagRunRef(dag.runRef)}` : "";
  return `Background work: ${dag.completed}/${dag.scheduled} tasks finished · ${statusLabel}${ref}`;
}

function formatBackgroundRunSummary(run: SparkRunWidgetEntry | undefined): string {
  if (!run) return "Background work";
  const focus = run.focus ? ` · focus: ${run.focus}` : "";
  return `Background work: ${formatBackgroundStatusLabel(run.status)} · ${shortDagRunRef(run.runRef)}${focus}`;
}

function formatBackgroundStatusLabel(
  status: SparkDagWidgetEntry["status"] | SparkRunWidgetEntry["status"],
): string {
  if (status === "succeeded" || status === "done") return "done";
  if (status === "timed_out") return "timed out";
  return status;
}

function shortDagRunRef(runRef: string): string {
  const match = /^run:([0-9a-f]{8})/i.exec(runRef);
  return match ? `run:${match[1]}` : runRef;
}

function formatProjectHeaderLine(
  state: SparkWidgetState,
  visibleTasks: TaskEntry[],
  tasksLabel: string,
  theme: SparkWidgetTheme,
): string | undefined {
  const taskSummary = formatTaskSummaryHeader(state, visibleTasks, tasksLabel);
  const suffix = taskSummary ? `${theme.fg("dim", "·")} ${theme.fg("dim", taskSummary)}` : "";
  if (!state.projectTitle) {
    return taskSummary ? `${theme.fg("accent", "◆")} ${theme.fg("dim", taskSummary)}` : undefined;
  }
  return `${theme.fg("accent", "◆")} ${theme.bold(state.projectTitle)}${suffix ? ` ${suffix}` : ""}`;
}

function formatTaskSummaryHeader(
  state: SparkWidgetState,
  visibleTasks: TaskEntry[],
  tasksLabel: string,
): string | undefined {
  if (state.taskCountTotal === 0 && visibleTasks.length === 0) return undefined;
  if (visibleTasks.length === 0 && state.tasks.length > 0) return undefined;
  const taskSummary = formatTaskSummary(state, visibleTasks);
  const agentSummary = formatRunningAgentSummary(visibleTasks);
  const suffix = agentSummary ? `${taskSummary}: ${agentSummary}` : taskSummary;
  return `${tasksLabel}(${suffix})`;
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
  const runningRoles = tasks
    .filter(
      (task) =>
        task.status === "running" &&
        task.claim === "role-run" &&
        task.backgroundOwner === "session",
    )
    .map(taskAgentRoleLabel);
  if (runningRoles.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const role of runningRoles) counts.set(role, (counts.get(role) ?? 0) + 1);
  const shown = [...counts]
    .slice(0, 4)
    .map(([role, count]) => (count > 1 ? `${role}×${count}` : role))
    .join(", ");
  const hidden = counts.size > 4 ? ` +${counts.size - 4}` : "";
  return `agents ${shown}${hidden}`;
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

function compactRoleRunName(label: string): string {
  return label.replace(/-[0-9a-f]{6,}$/iu, "");
}

function compactTaskAgentLabel(label: string): string {
  const parts = label.split("/");
  const role = parts.pop();
  if (!role) return compactRoleRunName(label);
  return [...parts, compactRoleRunName(role)].join("/");
}

function taskAgentRoleLabel(task: TaskEntry): string {
  const label = compactTaskAgentLabel(taskAgentLabel(task));
  return label.split("/").pop() || label;
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
  if (task.agentLabel?.trim()) return task.agentLabel.trim();
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
  const withPlanSummary =
    task.planSummary === "missing" ? `${base} ${theme.fg("warning", "plan:missing")}` : base;
  if (task.status === "failed") return theme.fg("error", withPlanSummary);
  if (task.status === "running") return theme.bold(withPlanSummary);
  return withPlanSummary;
}

type WidgetRow =
  | { kind: "task"; task: TaskEntry }
  | { kind: "task-todo"; todo: SessionTodoEntry; fallbackNumber: number }
  | { kind: "independent-todo"; todo: SessionTodoEntry; fallbackNumber: number };

function flattenSessionTodoRows(independentTodos: SessionTodoEntry[]): WidgetRow[] {
  return sortTodosForVisibility(independentTodos).map((todo, index) => ({
    kind: "independent-todo",
    todo,
    fallbackNumber: index + 1,
  }));
}

function flattenTaskRows(tasks: TaskEntry[]): WidgetRow[] {
  const rows: WidgetRow[] = [];
  let todoIndex = 1;
  for (const task of sortTasksForVisibility(tasks))
    todoIndex = appendTaskRows(rows, task, todoIndex);
  return rows;
}

function appendTaskRows(rows: WidgetRow[], task: TaskEntry, todoIndex: number): number {
  rows.push({ kind: "task", task });
  if (task.status === "done" || task.status === "cancelled") return todoIndex;
  for (const todo of sortTodosForVisibility(task.todos.filter(isVisibleTaskTodo)))
    rows.push({ kind: "task-todo", todo, fallbackNumber: todoIndex++ });
  return todoIndex;
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
  const agentLabel = compactTaskAgentLabel(taskAgentLabel(task));
  if (task.claim === "role-run") {
    if (agentLabel.includes("/")) return `@${agentLabel}`;
    return task.backgroundOwner === "session" ? `@me/${agentLabel}` : `@${agentLabel}`;
  }
  if (task.claim === "mine" && task.agentLabel?.trim()) return `@${agentLabel}`;
  if (task.claim === "other") return `@${agentLabel}`;
  return undefined;
}

function appendFormattedRows(
  lines: string[],
  rows: WidgetRow[],
  hasFollowingRows: boolean,
  theme: SparkWidgetTheme,
  trunc: (line: string) => string,
): void {
  rows.forEach((row, index) => {
    const isLast = !hasFollowingRows && index === rows.length - 1;
    lines.push(trunc(formatWidgetRow(row, theme, isLast ? "└─" : "├─")));
  });
}

function formatWidgetRow(row: WidgetRow, theme: SparkWidgetTheme, branch: "├─" | "└─"): string {
  switch (row.kind) {
    case "task":
      return `${theme.fg("dim", branch)} ${taskIcon(row.task, theme)} ${formatTaskTitle(row.task, theme)}`;
    case "task-todo":
      return `${theme.fg("dim", `│  ${branch}`)} ${todoIcon(row.todo.status, theme)} #${todoDisplayNumber(row.todo, row.fallbackNumber)} ${formatTodoContent(row.todo, theme)}`;
    case "independent-todo":
      return `${theme.fg("dim", branch)} ${todoIcon(row.todo.status, theme)} #${todoDisplayNumber(row.todo, row.fallbackNumber)} ${formatTodoContent(row.todo, theme)}`;
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
    if (hasAnimatedWidgetContent(state)) {
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
