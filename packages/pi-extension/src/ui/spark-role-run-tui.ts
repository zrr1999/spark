import { truncateToWidth } from "@zendev-lab/spark-text";

import type { TaskRef } from "@zendev-lab/spark-core";
import type {
  SparkRoleRunObservedStatus,
  SparkRoleRunRegistryEntry,
  SparkRoleRunRegistrySnapshot,
} from "../extension/spark-role-run-observability.ts";
import { shortRoleLabel } from "../extension/task-ownership.ts";

export interface SparkRoleRunTaskInfo {
  name?: string;
  title?: string;
}

export type SparkRoleRunTaskInfoByRef = Partial<Record<TaskRef, SparkRoleRunTaskInfo>>;

export interface SparkRoleRunTuiTheme {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface SparkRoleRunTuiRenderOptions {
  width: number;
  maxLines?: number;
  now?: string;
  includeCompletedRecentMs?: number;
}

const MAX_ROLE_RUN_BOARD_LINES = 8;
const RECENT_TERMINAL_MS = 10 * 60_000;
const TERMINAL_STATUSES = new Set<SparkRoleRunObservedStatus>(["done", "failed", "cancelled"]);
const PROBLEM_STATUSES = new Set<SparkRoleRunObservedStatus>([
  "failed",
  "cancelled",
  "interrupted",
  "stale",
]);
const ACTIVE_STATUSES = new Set<SparkRoleRunObservedStatus>(["queued", "waiting", "running"]);

export function formatSparkRoleRunStatusSummary(
  snapshot: SparkRoleRunRegistrySnapshot,
): string | undefined {
  const visible = visibleRoleRunEntries(snapshot, { now: snapshot.generatedAt });
  if (visible.length === 0) return undefined;
  const parts = (
    ["running", "waiting", "queued", "failed", "stale", "interrupted", "cancelled", "done"] as const
  )
    .map((status) => {
      const count = visible.filter((entry) => entry.status === status).length;
      return count > 0 ? `${status}=${count}` : undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `roles: ${parts.join(" ")}` : undefined;
}

export function renderSparkRoleRunBoardLines(
  snapshot: SparkRoleRunRegistrySnapshot,
  taskInfoByRef: SparkRoleRunTaskInfoByRef = {},
  options: SparkRoleRunTuiRenderOptions,
  theme: SparkRoleRunTuiTheme = {},
): string[] {
  const entries = visibleRoleRunEntries(snapshot, options);
  if (entries.length === 0) return [];
  const maxLines = Math.max(1, options.maxLines ?? MAX_ROLE_RUN_BOARD_LINES);
  const width = Math.max(1, options.width);
  const trunc = (line: string) => truncateToWidth(line, width, "…");
  const lines: string[] = [];
  const header = formatRoleRunHeader(entries, theme);
  lines.push(trunc(header));
  const rowBudget = Math.max(0, maxLines - 1);
  const shown = entries.slice(0, rowBudget);
  const hidden = entries.length - shown.length;
  shown.forEach((entry, index) => {
    const branch = hidden === 0 && index === shown.length - 1 ? "└─" : "├─";
    lines.push(
      trunc(formatRoleRunRow(entry, taskInfoByRef[entry.taskRef], branch, options, theme)),
    );
  });
  if (hidden > 0)
    lines.push(trunc(`${dim(theme, "└─")} ${dim(theme, `+${hidden} more role run(s)`)}`));
  return lines.slice(0, maxLines);
}

export function roleRunCompletionMessageContent(entry: SparkRoleRunRegistryEntry): string {
  const role = entry.roleRef ? shortRoleLabel(entry.roleRef) : "role";
  const status = entry.status === "done" ? "completed" : entry.status;
  return `${role} ${status}: ${shortRunRef(entry.runRef)}`;
}

export function renderSparkRoleRunCompletionMessageLines(
  details: unknown,
  options: { expanded?: boolean; width: number },
  theme: SparkRoleRunTuiTheme = {},
): string[] {
  const entry = isRegistryEntry(details) ? details : undefined;
  if (!entry) return ["Spark role run update"];
  const width = Math.max(1, options.width);
  const trunc = (line: string) => truncateToWidth(line, width, "…");
  const icon = statusIcon(entry.status, theme);
  const role = entry.roleRef ? shortRoleLabel(entry.roleRef) : "unknown";
  const title = `${icon} ${bold(theme, role)} ${statusLabel(entry.status)} ${dim(theme, shortRunRef(entry.runRef))}`;
  const lines = [trunc(title)];
  const activity = lastActivityText(entry);
  if (activity) lines.push(trunc(`  ⎿ ${activity}`));
  if (entry.outputArtifacts.length > 0)
    lines.push(trunc(`  artifacts: ${entry.outputArtifacts.join(", ")}`));
  if (entry.errorMessage) lines.push(trunc(`  error: ${entry.errorMessage}`));
  const usage = usageText(entry);
  if (usage) lines.push(trunc(`  ${dim(theme, usage)}`));
  if (options.expanded) {
    lines.push(trunc(`  task: ${entry.taskRef}`));
    if (entry.runName) lines.push(trunc(`  runName: ${entry.runName}`));
    if (entry.ownerSessionId) lines.push(trunc(`  owner: ${entry.ownerSessionId}`));
    for (const event of entry.events.slice(-6)) {
      const label = event.toolName ?? event.message ?? event.type;
      lines.push(trunc(`  - ${event.type} ${dim(theme, event.at)}${label ? ` · ${label}` : ""}`));
    }
  }
  return lines;
}

function visibleRoleRunEntries(
  snapshot: SparkRoleRunRegistrySnapshot,
  options: { now?: string; includeCompletedRecentMs?: number },
): SparkRoleRunRegistryEntry[] {
  const now = Date.parse(options.now ?? snapshot.generatedAt);
  const recentMs = options.includeCompletedRecentMs ?? RECENT_TERMINAL_MS;
  return snapshot.entries.filter((entry) => {
    if (ACTIVE_STATUSES.has(entry.status) || PROBLEM_STATUSES.has(entry.status)) return true;
    if (!TERMINAL_STATUSES.has(entry.status)) return true;
    const finished = Date.parse(entry.finishedAt ?? entry.updatedAt);
    return Number.isFinite(now) && Number.isFinite(finished) && now - finished <= recentMs;
  });
}

function formatRoleRunHeader(
  entries: SparkRoleRunRegistryEntry[],
  theme: SparkRoleRunTuiTheme,
): string {
  const counts = new Map<SparkRoleRunObservedStatus, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const summary = (["running", "waiting", "queued", "failed", "stale", "done"] as const)
    .map((status) => {
      const count = counts.get(status) ?? 0;
      return count > 0 ? `${status}=${count}` : undefined;
    })
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return `${accent(theme, "◆")} ${bold(theme, "Role runs")}${summary ? ` ${dim(theme, `(${summary})`)}` : ""}`;
}

function formatRoleRunRow(
  entry: SparkRoleRunRegistryEntry,
  taskInfo: SparkRoleRunTaskInfo | undefined,
  branch: "├─" | "└─",
  options: SparkRoleRunTuiRenderOptions,
  theme: SparkRoleRunTuiTheme,
): string {
  const icon = statusIcon(entry.status, theme);
  const role = entry.roleRef ? shortRoleLabel(entry.roleRef) : "unknown";
  const task = taskInfo?.name ? `@${taskInfo.name}` : (taskInfo?.title ?? entry.taskRef);
  const elapsed = elapsedText(entry, options.now);
  const activity = lastActivityText(entry);
  const usage = usageText(entry);
  const badges = [
    elapsed,
    usage,
    entry.outputArtifacts.length > 0 ? `artifacts=${entry.outputArtifacts.length}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const activitySuffix = activity ? ` ${dim(theme, `⎿ ${activity}`)}` : "";
  const badgeSuffix = badges ? ` ${dim(theme, `· ${badges}`)}` : "";
  return `${dim(theme, branch)} ${icon} ${accent(theme, role)} ${task}${badgeSuffix}${activitySuffix}`;
}

function lastActivityText(entry: SparkRoleRunRegistryEntry): string | undefined {
  const reversed = [...entry.events].reverse();
  const event =
    reversed.find(
      (candidate) =>
        candidate.provenance.source !== "recovery" && (candidate.message || candidate.toolName),
    ) ??
    reversed.find(
      (candidate) => candidate.message || candidate.toolName || candidate.type !== "started",
    );
  if (!event) return undefined;
  if (event.toolName) return `tool ${event.toolName}`;
  if (event.message) return event.message.replace(/\s+/gu, " ").trim();
  if (event.type === "completed") return "done";
  if (event.type === "failed") return "failed";
  if (event.type === "stopped") return "stopped";
  if (event.type === "waiting_for_user") return "waiting for user";
  return event.type.replace(/_/gu, " ");
}

function elapsedText(
  entry: SparkRoleRunRegistryEntry,
  now = new Date().toISOString(),
): string | undefined {
  if (!entry.startedAt) return undefined;
  const end = Date.parse(entry.finishedAt ?? now);
  const start = Date.parse(entry.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function usageText(entry: SparkRoleRunRegistryEntry): string | undefined {
  const usage = entry.usage;
  if (!usage) return undefined;
  const parts = [];
  if (usage.totalTokens !== undefined) parts.push(`${formatCount(usage.totalTokens)} tok`);
  else {
    if (usage.inputTokens !== undefined) parts.push(`↑${formatCount(usage.inputTokens)}`);
    if (usage.outputTokens !== undefined) parts.push(`↓${formatCount(usage.outputTokens)}`);
  }
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (usage.model) parts.push(usage.model);
  return parts.join(" · ") || undefined;
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function statusIcon(status: SparkRoleRunObservedStatus, theme: SparkRoleRunTuiTheme): string {
  switch (status) {
    case "running":
      return accent(theme, "⠹");
    case "queued":
    case "waiting":
      return fg(theme, "warning", "◼");
    case "done":
      return fg(theme, "success", "✓");
    case "failed":
    case "stale":
      return fg(theme, "error", "✗");
    case "cancelled":
    case "interrupted":
      return dim(theme, "■");
  }
}

function statusLabel(status: SparkRoleRunObservedStatus): string {
  if (status === "done") return "completed";
  if (status === "cancelled") return "stopped";
  return status;
}

function shortRunRef(runRef: string): string {
  const match = /^run:([0-9a-f]{8})/iu.exec(runRef);
  return match ? `run:${match[1]}` : runRef;
}

function isRegistryEntry(value: unknown): value is SparkRoleRunRegistryEntry {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { runRef?: unknown }).runRef === "string" &&
    typeof (value as { status?: unknown }).status === "string" &&
    Array.isArray((value as { events?: unknown }).events),
  );
}

function fg(theme: SparkRoleRunTuiTheme, color: string, text: string): string {
  return theme.fg ? theme.fg(color, text) : text;
}

function accent(theme: SparkRoleRunTuiTheme, text: string): string {
  return fg(theme, "accent", text);
}

function dim(theme: SparkRoleRunTuiTheme, text: string): string {
  return fg(theme, "dim", text);
}

function bold(theme: SparkRoleRunTuiTheme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}
