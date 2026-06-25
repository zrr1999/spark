import { truncateToWidth } from "@zendev-lab/spark-tui/text";

import type { SessionTodoEntry, SessionTodoStatus } from "@zendev-lab/pi-tasks";
import {
  sparkActiveLensDriveMode,
  sparkActiveLensPhase,
  type SparkDriveMode,
  type SparkDriveModeInput,
} from "../extension/spark-drive-state.ts";

export type { SessionTodoEntry, SessionTodoStatus } from "@zendev-lab/pi-tasks";

/**
 * spark-widget.ts — Above-editor widget showing durable Spark project/task state plus
 * claimed task TODO working sets.
 *
 * Display model:
 *   ◆ Goal(●): active objective
 *   ◆ Loop(●): active objective
 *   ◆ Project title · Phase: implement
 *   ├─ ◐ @me/worker role-run task title
 *   │  ├─ ✓ #7 task plan item
 *   │  └─ ○ #12 task plan item
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

export interface SparkWorkflowRunWidgetEntry {
  status: "running" | "succeeded" | "failed" | "timed_out" | "stale";
  runRef?: string;
  scheduled: number;
  completed: number;
  active?: boolean;
}

export interface SparkDynamicWorkflowRunWidgetEntry {
  status: "running" | "paused" | "succeeded" | "failed" | "stale" | "stopped";
  runRef: string;
  name: string;
  completedNodes: number;
  totalNodes: number;
  active?: boolean;
  delivery?: "result" | "error";
}

export interface SparkLoopScheduleWidgetEntry {
  label: string;
  scheduledAtMs: number;
  nextRunAtMs: number;
}

export interface SparkGoalWidgetEntry {
  status: "active" | "paused" | "complete";
  objective: string;
}

export interface SparkLoopWidgetEntry {
  status: "active";
  objective: string;
  schedule?: SparkLoopScheduleWidgetEntry;
}

export interface SparkProjectKindWidgetPanel {
  label: string;
  render: "text" | "progress" | "counts" | "list";
  text: string;
}

export interface SparkProjectKindWidgetEntry {
  kind: string;
  title: string;
  badge?: string;
  panels: SparkProjectKindWidgetPanel[];
}

export interface SparkWidgetActiveLens {
  phase: "research" | "plan" | "implement";
  /** Read-only derived drive mode. */
  mode?: SparkDriveMode | "research" | "plan" | "implement";
  drive?: SparkDriveModeInput;
  /** @deprecated Use drive/mode. */
  driver?: SparkDriveModeInput;
}

export interface SparkWidgetState {
  projectTitle?: string;
  activeLens?: SparkWidgetActiveLens;
  workflowRun?: SparkWorkflowRunWidgetEntry;
  dynamicWorkflowRun?: SparkDynamicWorkflowRunWidgetEntry;
  goal?: SparkGoalWidgetEntry;
  loop?: SparkLoopWidgetEntry;
  projectKind?: SparkProjectKindWidgetEntry;
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

function isVisibleTaskTodo(todo: SessionTodoEntry): boolean {
  return todo.status !== "deleted";
}

function hasWidgetContent(state: SparkWidgetState | undefined): state is SparkWidgetState {
  return Boolean(
    state &&
    (state.projectTitle ||
      isRunningBackgroundRun(state.workflowRun) ||
      state.dynamicWorkflowRun ||
      state.goal ||
      state.loop ||
      (state.projectKind?.panels.length ?? 0) > 0 ||
      state.tasks.length > 0),
  );
}

function hasAnimatedWidgetContent(state: SparkWidgetState | undefined): boolean {
  return Boolean(
    state?.goal?.status === "active" ||
    state?.loop?.status === "active" ||
    hasAnimatedRunningTask(state),
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
  if (
    !state.projectTitle &&
    !isRunningBackgroundRun(state.workflowRun) &&
    !state.dynamicWorkflowRun &&
    !state.goal &&
    !state.loop &&
    (state.projectKind?.panels.length ?? 0) === 0 &&
    state.tasks.length === 0
  )
    return [];

  const l = L[state.outputLanguage] ?? L.en;
  const width = tui.terminal.columns;
  const trunc = (line: string) => truncateToWidth(line, Math.max(1, width), "…");

  const lines: string[] = [];
  const visibleTasks = state.tasks.filter(isVisibleTaskEntry);

  const goalLine = formatForegroundDriverLine(
    state.goal,
    state.loop,
    theme,
    state.animationFrame ?? 0,
  );
  const projectHeaderLine = formatProjectHeaderLine(state, theme);
  const projectKindLines = formatProjectKindLines(state.projectKind, theme);
  const backgroundLine = hasSessionRunningAgent(visibleTasks)
    ? undefined
    : formatBackgroundLine(state.workflowRun, theme);
  const dynamicWorkflowLine = formatDynamicWorkflowLine(state.dynamicWorkflowRun, theme);

  const tasks = visibleTasks.map((task) => ({
    ...task,
    animationFrame: task.animationFrame ?? state.animationFrame ?? 0,
  }));
  const projectRows = flattenTaskRows(tasks);
  const fixedLineCount =
    [goalLine, projectHeaderLine, backgroundLine, dynamicWorkflowLine].filter(Boolean).length +
    projectKindLines.length;
  const budget = Math.max(0, MAX_WIDGET_LINES - fixedLineCount);
  const visibleProjectRows = projectRows.slice(0, budget);
  const hidden = projectRows.length - visibleProjectRows.length;

  if (goalLine) lines.push(trunc(goalLine));
  if (projectHeaderLine) lines.push(trunc(projectHeaderLine));
  for (const line of projectKindLines) lines.push(trunc(line));
  if (backgroundLine) lines.push(trunc(backgroundLine));
  if (dynamicWorkflowLine) lines.push(trunc(dynamicWorkflowLine));
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

function formatForegroundDriverLine(
  goal: SparkGoalWidgetEntry | undefined,
  loop: SparkLoopWidgetEntry | undefined,
  theme: SparkWidgetTheme,
  animationFrame: number,
): string | undefined {
  if (loop) return formatLoopLine(loop, theme, animationFrame);
  return formatGoalLine(goal, theme, animationFrame);
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

function formatLoopLine(
  loop: SparkLoopWidgetEntry,
  theme: SparkWidgetTheme,
  animationFrame: number,
): string {
  const statusContent =
    loop.status === "active" && loop.schedule
      ? loopScheduleProgress(loop.schedule)
      : goalStatusSymbol(loop.status, animationFrame);
  const status = theme.fg(goalStatusColor(loop.status), statusContent);
  const summary = `${theme.fg("dim", "Loop(")}${status}${theme.fg("dim", `): ${loop.objective}`)}`;
  return `${theme.fg("accent", "◆")} ${summary}`;
}

function loopScheduleProgress(schedule: SparkLoopScheduleWidgetEntry): string {
  const total = Math.max(1, schedule.nextRunAtMs - schedule.scheduledAtMs);
  const elapsed = Math.min(total, Math.max(0, Date.now() - schedule.scheduledAtMs));
  const segments = 5;
  const filled = Math.min(segments, Math.max(0, Math.floor((elapsed / total) * segments)));
  return `${"▰".repeat(filled)}${"▱".repeat(segments - filled)} ${schedule.label}`;
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

function formatBackgroundLine(
  workflowRun: SparkWorkflowRunWidgetEntry | undefined,
  theme: SparkWidgetTheme,
): string | undefined {
  if (!isRunningBackgroundRun(workflowRun)) return undefined;
  const body = formatBackgroundRunSummary(workflowRun);
  return `${theme.fg("accent", "◆")} ${theme.fg("dim", body)}`;
}

function isRunningBackgroundRun(
  workflowRun: SparkWorkflowRunWidgetEntry | undefined,
): workflowRun is SparkWorkflowRunWidgetEntry {
  return workflowRun?.status === "running" && workflowRun.active === true;
}

function formatBackgroundRunSummary(workflowRun: SparkWorkflowRunWidgetEntry): string {
  const status = workflowRun.active ? "running" : workflowRun.status;
  const statusLabel = formatBackgroundStatusLabel(status);
  const ref = workflowRun.runRef ? ` · ${shortRunRef(workflowRun.runRef)}` : "";
  return `Background work: ${workflowRun.completed}/${workflowRun.scheduled} tasks finished · ${statusLabel}${ref}`;
}

function formatBackgroundStatusLabel(status: SparkWorkflowRunWidgetEntry["status"]): string {
  if (status === "succeeded") return "done";
  if (status === "timed_out") return "timed out";
  return status;
}

function formatDynamicWorkflowLine(
  workflowRun: SparkDynamicWorkflowRunWidgetEntry | undefined,
  theme: SparkWidgetTheme,
): string | undefined {
  if (!workflowRun) return undefined;
  const status = workflowRun.active ? "running" : workflowRun.status;
  const progress =
    workflowRun.totalNodes > 0
      ? `${workflowRun.completedNodes}/${workflowRun.totalNodes} nodes`
      : "no nodes";
  const label =
    workflowRun.delivery === "result"
      ? "Dynamic workflow result"
      : workflowRun.delivery === "error"
        ? "Dynamic workflow error"
        : "Dynamic workflow";
  return `${theme.fg("accent", "◆")} ${theme.fg(
    "dim",
    `${label}: ${workflowRun.name} · ${status} · ${progress} · ${shortRunRef(workflowRun.runRef)}`,
  )}`;
}

function shortRunRef(runRef: string): string {
  const match = /^run:([0-9a-f]{8})/i.exec(runRef);
  return match ? `run:${match[1]}` : runRef;
}

function formatProjectHeaderLine(
  state: SparkWidgetState,
  theme: SparkWidgetTheme,
): string | undefined {
  const phaseSummary = formatPhaseSummary(state.activeLens);
  const kindSummary = state.projectKind?.badge ? `Kind: ${state.projectKind.badge}` : undefined;
  const summaries = [phaseSummary, kindSummary].filter((part): part is string => Boolean(part));
  const suffix = summaries
    .map((summary) => `${theme.fg("dim", "·")} ${theme.fg("dim", summary)}`)
    .join(" ");
  if (!state.projectTitle) {
    return summaries.length > 0
      ? `${theme.fg("accent", "◆")} ${theme.fg("dim", summaries.join(" · "))}`
      : undefined;
  }
  return `${theme.fg("accent", "◆")} ${theme.bold(state.projectTitle)}${suffix ? ` ${suffix}` : ""}`;
}

function formatPhaseSummary(lens: SparkWidgetActiveLens | undefined): string {
  const phase = sparkActiveLensPhase(lens);
  const mode = sparkActiveLensDriveMode(lens);
  const modeSuffix = mode === "assist" ? "" : ` · Mode: ${mode}`;
  return `Phase: ${phase}${modeSuffix}`;
}

function formatProjectKindLines(
  projectKind: SparkProjectKindWidgetEntry | undefined,
  theme: SparkWidgetTheme,
): string[] {
  if (!projectKind || projectKind.panels.length === 0) return [];
  return projectKind.panels.map((panel) => {
    const badge = projectKind.badge ? `[${projectKind.badge}] ` : "";
    return `${theme.fg("dim", "◇")} ${theme.fg("dim", badge)}${theme.fg(
      "dim",
      `${panel.label}: ${panel.text}`,
    )}`;
  });
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
  | { kind: "task-todo"; todo: SessionTodoEntry; fallbackNumber: number };

function flattenTaskRows(tasks: TaskEntry[]): WidgetRow[] {
  const rows: WidgetRow[] = [];
  let todoIndex = 1;
  for (const task of sortTasksForVisibility(tasks))
    todoIndex = appendTaskRows(rows, task, todoIndex);
  return rows;
}

function appendTaskRows(rows: WidgetRow[], task: TaskEntry, todoIndex: number): number {
  rows.push({ kind: "task", task });
  if (!shouldShowTaskTodos(task)) return todoIndex;
  for (const todo of sortTodosForVisibility(task.todos.filter(isVisibleTaskTodo)))
    rows.push({ kind: "task-todo", todo, fallbackNumber: todoIndex++ });
  return todoIndex;
}

function shouldShowTaskTodos(task: TaskEntry): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (task.claim === "mine") return true;
  return task.claim === "role-run" && task.backgroundOwner === "session";
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
