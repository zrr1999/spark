/**
 * spark-widget.ts — Above-editor widget showing Spark thread / task / TODO state.
 *
 * Display model (one line per task + active TODO):
 *   ● Thread title
 *     → Task: current task       [running]
 *       ○ TODO: active todo item
 *     ◼ Task: in-progress task   [in_progress]
 *     ✓ Task: done task          [done]
 *     ◻ Task: pending task       [pending]
 *   N total  M active  P pending  Q done
 */

export interface TaskEntry {
  title: string;
  status: "running" | "pending" | "done" | "failed";
  todoActive?: string;
  todosDone: number;
  todosTotal: number;
}

export interface SparkWidgetState {
  threadTitle?: string;
  tasks: TaskEntry[];
  todosTotal: number;
  todosInProgress: number;
  todosPending: number;
  todosDone: number;
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
    task: "任务",
    todo: "TODO",
  },
  en: {
    running: "running",
    pending: "pending",
    done: "done",
    failed: "failed",
    total: "total",
    active: "active",
    doneLabel: "done",
    task: "Task",
    todo: "TODO",
  },
} as const;

export function renderSparkWidgetLines(
  state: SparkWidgetState,
  tui: SparkWidgetTui,
  theme: SparkWidgetTheme,
): string[] {
  if (!state.threadTitle || state.tasks.length === 0) return [];

  const l = L[state.outputLanguage] ?? L.en;
  const w = tui.terminal.columns;
  const trunc = (line: string) => (line.length <= w ? line : `${line.slice(0, w - 1)}…`);

  const statusOrder: Record<string, number> = { running: 0, pending: 1, done: 2, failed: 3 };

  // Sort: running first, then pending, then done, then failed
  const sorted = [...state.tasks].sort(
    (a, b) => (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0),
  );

  const parts: string[] = [];
  if (state.todosDone > 0) parts.push(`${state.todosDone} ${l.doneLabel}`);
  if (state.todosInProgress > 0) parts.push(`${state.todosInProgress} ${l.active}`);
  if (state.todosPending > 0) parts.push(`${state.todosPending} ${l.pending}`);
  const counts = parts.length > 0 ? ` ${parts.join(", ")}` : "";

  const lines: string[] = [];
  lines.push(trunc(`${theme.fg("accent", "●")} ${theme.bold(state.threadTitle)}${counts}`));

  for (const task of sorted) {
    let icon: string;
    let style: (text: string) => string;

    switch (task.status) {
      case "running":
        icon = theme.fg("accent", "→");
        style = (text) => theme.bold(text);
        break;
      case "pending":
        icon = "◻";
        style = (text) => text;
        break;
      case "done":
        icon = theme.fg("success", "✓");
        style = (text) => theme.fg("dim", theme.strikethrough(text));
        break;
      case "failed":
        icon = theme.fg("error", "✗");
        style = (text) => theme.fg("dim", text);
        break;
    }

    const statusLabel = l[task.status];
    const todoInfo = task.todosTotal > 0 ? ` [${task.todosDone}/${task.todosTotal}]` : "";
    const label = `  ${icon} ${style(task.title)}${todoInfo}`;

    // Show active TODO under the current task
    if (task.status === "running" && task.todoActive) {
      lines.push(trunc(label));
      lines.push(trunc(`    ${theme.fg("dim", "○")} ${l.todo}: ${task.todoActive}`));
    } else {
      lines.push(trunc(label));
    }
  }

  const stat = [
    `${state.todosTotal} ${l.total}`,
    `${state.todosInProgress} ${l.active}`,
    `${state.todosPending} ${l.pending}`,
    `${state.todosDone} ${l.doneLabel}`,
  ].join("  ");
  lines.push(trunc(`  ${theme.fg("dim", stat)}`));

  return lines;
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
    if (!state || !state.threadTitle || state.tasks.length === 0) {
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
