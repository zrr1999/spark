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
  return renderToolCall(toolName, formatGenericArgs(args), theme);
}

export function truncateInline(value: string, width: number): string {
  return truncateToWidth(value.replace(/\s+/gu, " ").trim(), Math.max(1, width), "…");
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

function formatGenericArgs(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => formatGenericArg(key, value))
    .filter((value): value is string => Boolean(value));
}

function formatGenericArg(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return `${key}=${truncateToWidth(value, 60, "…")}`;
  if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
  if (Array.isArray(value)) return `${key}=${value.length}`;
  return `${key}=…`;
}
