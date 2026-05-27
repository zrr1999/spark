import { truncateToWidth } from "@earendil-works/pi-tui";

export interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export function renderSparkToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ToolCallRenderTheme,
  _context: unknown,
): ToolCallComponent {
  switch (toolName) {
    case "spark_status":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.showFinished === true ? "full" : args.view, { fallback: "active" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          formatStringArg(args.format, { prefix: "format=" }),
        ],
        theme,
      );
    case "spark_update_todos":
      return renderToolCall(toolName, [formatOpsSummary(args.ops)], theme);
    case "spark_update_task_todos":
      return renderToolCall(
        toolName,
        [formatStringArg(args.task, { prefix: "task=" }), formatOpsSummary(args.ops)],
        theme,
      );
    case "spark_finish_task":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.task, { prefix: "task=" }),
          formatStringArg(args.status, { fallback: "done" }),
        ],
        theme,
      );
    case "spark_claim_task":
      return renderToolCall(
        toolName,
        [
          formatTaskNameArg(args.name),
          formatStringArg(args.title, { maxLength: 80 }),
          formatStringArg(args.status, { prefix: "status=" }),
          formatStringArg(args.kind, { prefix: "kind=" }),
          formatStringArg(args.roleRef, { prefix: "role=" }),
          formatArrayCount(args.todos, "todos"),
        ],
        theme,
      );
    case "spark_rename_thread":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.thread, { prefix: "thread=" }),
          formatStringArg(args.title, { prefix: "title=", maxLength: 80 }),
          formatStringArg(args.outputLanguage, { prefix: "lang=" }),
        ],
        theme,
      );
    case "spark_use_thread":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.thread, { prefix: "thread=" }),
          formatStringArg(args.title, { prefix: "title=", maxLength: 80 }),
          formatStringArg(args.outputLanguage, { prefix: "lang=" }),
        ],
        theme,
      );
    case "spark_plan_tasks":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.dryRun === true ? "dry-run" : undefined),
          formatTaskPlanSummary(args.tasks),
        ],
        theme,
      );
    case "spark_run_ready_tasks":
      return renderToolCall(
        toolName,
        [
          args.dryRun === false ? "run" : "dry-run",
          formatNumberArg(args.maxConcurrency, { prefix: "max=" }),
          formatNumberArg(args.timeoutMs, { prefix: "timeout=", suffix: "ms" }),
        ],
        theme,
      );
    case "spark_dag_manager":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.action, { fallback: "status" }),
          formatStringArg(args.runRef, { prefix: "run=" }),
        ],
        theme,
      );
    case "spark_ask":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.mode ?? args.kind, { fallback: "clarification" }),
          formatStringArg(args.title ?? args.question, { maxLength: 100 }),
          formatArrayCount(args.questions, "questions") ??
            formatArrayCount(args.options, "options"),
          args.multiSelect === true ? "multi" : undefined,
          formatStringArg(args.defaultOptionId, { prefix: "default=" }),
        ],
        theme,
      );
    case "spark_ask_replay":
      return renderToolCall(
        toolName,
        [formatStringArg(args.artifactRef, { prefix: "artifact=" })],
        theme,
      );
    case "spark_list_artifacts":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.kind, { prefix: "kind=" }),
          formatStringArg(args.producer, { prefix: "producer=" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
        ],
        theme,
      );
    case "spark_get_artifact":
      return renderToolCall(
        toolName,
        [
          formatStringArg(args.artifactRef, { prefix: "artifact=" }),
          args.full === true ? "full" : undefined,
          formatNumberArg(args.maxChars, { prefix: "max=" }),
        ],
        theme,
      );
    default:
      return renderToolCall(toolName, formatGenericArgs(args), theme);
  }
}

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const renderedArgs = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${renderedArgs}`.trimEnd());
}

function formatTaskNameArg(value: unknown): string | undefined {
  const name = formatStringArg(value);
  if (!name) return undefined;
  return name.startsWith("@") ? name : `@${name}`;
}

function formatOpsSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const ops = value
    .map((entry) => (isRecord(entry) && typeof entry.op === "string" ? entry.op : undefined))
    .filter((op): op is string => Boolean(op));
  const opSuffix = ops.length ? ` ${ops.slice(0, 4).join(",")}${ops.length > 4 ? ",…" : ""}` : "";
  return `${value.length} ops${opSuffix}`;
}

function formatTaskPlanSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      if (typeof entry.name === "string" && entry.name.trim()) return `@${entry.name.trim()}`;
      if (typeof entry.title === "string" && entry.title.trim())
        return truncateInline(entry.title, 30);
      return undefined;
    })
    .filter((label): label is string => Boolean(label));
  const suffix = labels.length
    ? ` ${labels.slice(0, 3).join(",")}${labels.length > 3 ? ",…" : ""}`
    : "";
  return `${value.length} tasks${suffix}`;
}

function formatArrayCount(value: unknown, noun: string): string | undefined {
  return Array.isArray(value) ? `${value.length} ${noun}` : undefined;
}

function formatGenericArgs(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => formatGenericArg(key, value))
    .filter((part): part is string => Boolean(part));
}

function formatGenericArg(key: string, value: unknown): string | undefined {
  if (typeof value === "string") return formatStringArg(value, { prefix: `${key}=` });
  if (typeof value === "number") return formatNumberArg(value, { prefix: `${key}=` });
  if (typeof value === "boolean") return `${key}=${value}`;
  if (Array.isArray(value)) return `${key}=[${value.length}]`;
  if (isRecord(value)) return `${key}={…}`;
  return undefined;
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = needsQuoting(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? 80)}`;
}

function formatNumberArg(
  value: unknown,
  options: { prefix?: string; suffix?: string } = {},
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}${options.suffix ?? ""}`;
}

function needsQuoting(value: string): boolean {
  return /\s|["'`]/.test(value);
}

export function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
