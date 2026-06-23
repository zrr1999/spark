/**
 * Branch-tree helpers and /sessions command registration for Spark's native
 * Pi-compatible JSONL session records.
 *
 * Matching current Pi semantics: branches are not a separate persisted object;
 * they are the tree formed by entry `id`/`parentId`. Selecting a branch moves a
 * transient active leaf pointer in the running host. The next append will create
 * a child of that selected entry.
 */

import type { CommandConfig, ExtensionCommandContext } from "@zendev-lab/pi-extension-api";

import type {
  SparkLabelEntry,
  SparkSessionEntry,
  SparkSessionFileEntry,
  SparkSessionInfo,
  SparkSessionMessageEntry,
  SparkSessionRecord,
  SparkSessionStore,
} from "./session-store.ts";

export interface SparkSessionTreeNode {
  entry: SparkSessionEntry;
  children: SparkSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export type SparkSessionExportFormat = "jsonl" | "json" | "text";

export interface SparkSessionTreeRow {
  id: string;
  depth: number;
  active: boolean;
  label: string;
  description: string;
  entry: SparkSessionEntry;
}

export interface SparkSessionNavigationState {
  record: SparkSessionRecord;
  activeLeafId: string | null;
}

export interface SparkSessionsCommandOptions {
  store: SparkSessionStore;
  getNavigationState: () => SparkSessionNavigationState | undefined;
  setActiveLeafId?: (leafId: string | null) => void;
}

export interface SparkSessionsCommandHost {
  registerCommand(name: string, config: CommandConfig): void;
}

export function buildSparkSessionTree(record: SparkSessionRecord): SparkSessionTreeNode[] {
  const labels = collectLabels(record.entries);
  const nodeMap = new Map<string, SparkSessionTreeNode>();
  const roots: SparkSessionTreeNode[] = [];

  for (const entry of record.entries) {
    const label = labels.get(entry.id);
    nodeMap.set(entry.id, {
      entry,
      children: [],
      label: label?.label,
      labelTimestamp: label?.timestamp,
    });
  }

  for (const entry of record.entries) {
    const node = nodeMap.get(entry.id)!;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodeMap.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  sortTreeByTimestamp(roots);
  return roots;
}

export function getSparkSessionLeafId(record: SparkSessionRecord): string | null {
  return record.entries.at(-1)?.id ?? null;
}

export function getSparkSessionBranch(
  record: SparkSessionRecord,
  leafId: string | null = getSparkSessionLeafId(record),
): SparkSessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(record.entries.map((entry) => [entry.id, entry]));
  const leaf = byId.get(leafId);
  if (!leaf) throw new Error(`Session entry not found: ${leafId}`);

  const branch: SparkSessionEntry[] = [];
  let current: SparkSessionEntry | undefined = leaf;
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

export function flattenSparkSessionTree(
  record: SparkSessionRecord,
  activeLeafId: string | null = getSparkSessionLeafId(record),
): SparkSessionTreeRow[] {
  const rows: SparkSessionTreeRow[] = [];
  const visit = (node: SparkSessionTreeNode, depth: number): void => {
    rows.push({
      id: node.entry.id,
      depth,
      active: node.entry.id === activeLeafId,
      label: node.label ?? summarizeEntry(node.entry),
      description: describeEntry(node.entry),
      entry: node.entry,
    });
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of buildSparkSessionTree(record)) visit(root, 0);
  return rows;
}

export function switchSparkSessionLeaf(
  record: SparkSessionRecord,
  leafId: string | null,
): string | null {
  if (leafId === null) return null;
  if (!record.entries.some((entry) => entry.id === leafId)) {
    throw new Error(`Session entry not found: ${leafId}`);
  }
  return leafId;
}

export function exportSparkSessionRecord(
  record: SparkSessionRecord,
  options: { format?: SparkSessionExportFormat; leafId?: string | null } = {},
): string {
  const format = options.format ?? "jsonl";
  const entries = entriesForExport(record, options.leafId);
  if (format === "json") return JSON.stringify({ header: record.header, entries }, null, 2);
  if (format === "text") return formatSessionReplayEntries(entries);
  return jsonLines([record.header, ...entries]);
}

export function formatSessionReplay(
  record: SparkSessionRecord,
  leafId: string | null = getSparkSessionLeafId(record),
): string {
  return formatSessionReplayEntries(getSparkSessionBranch(record, leafId));
}

export function readSparkSessionExportFormat(raw: string): SparkSessionExportFormat {
  if (raw === "jsonl" || raw === "json" || raw === "text") return raw;
  throw new Error(`invalid session export format: ${raw}`);
}

export function registerSparkSessionsCommand(
  host: SparkSessionsCommandHost,
  options: SparkSessionsCommandOptions,
): void {
  host.registerCommand("sessions", {
    description: "List sessions or navigate the current session branch tree",
    handler: (args, ctx) => runSparkSessionsCommand(args, ctx, options),
  });
}

export async function runSparkSessionsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  options: SparkSessionsCommandOptions,
): Promise<void> {
  const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (subcommand === "list") {
    const sessions = await options.store.list();
    notify(ctx, formatSessionList(sessions));
    return;
  }

  const state = options.getNavigationState();
  if (!state) {
    notify(ctx, "No active Spark session record is loaded", "warning");
    return;
  }

  if (subcommand === "branch") {
    const rows = flattenSparkSessionTree(state.record, state.activeLeafId);
    notify(ctx, formatBranchRows(rows));
    return;
  }

  if (subcommand === "switch") {
    const leafId = parseLeafArg(rest[0]);
    if (leafId === undefined) {
      notify(ctx, "Usage: /sessions switch <entry-id|root>", "warning");
      return;
    }
    try {
      const activeLeafId = switchSparkSessionLeaf(state.record, leafId);
      options.setActiveLeafId?.(activeLeafId);
      notify(ctx, `Active session branch: ${activeLeafId ?? "root"}`);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }

  if (subcommand === "replay") {
    try {
      notify(ctx, formatSessionReplay(state.record, parseLeafArg(rest[0], state.activeLeafId)));
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }

  if (subcommand === "export") {
    try {
      const format = readSparkSessionExportFormat(rest[0] ?? "jsonl");
      const leafId = parseLeafArg(rest[1]);
      notify(
        ctx,
        exportSparkSessionRecord(state.record, {
          format,
          ...(leafId !== undefined ? { leafId } : {}),
        }),
      );
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }

  notify(
    ctx,
    "Usage: /sessions [list|branch|switch <entry-id|root>|replay [entry-id|root]|export [jsonl|json|text] [entry-id|root]]",
    "warning",
  );
}

export function formatSessionList(sessions: SparkSessionInfo[]): string {
  if (sessions.length === 0) return "No Spark sessions found";
  return sessions
    .map((session) => {
      const name = session.name ? ` ${session.name}` : "";
      const first = session.firstMessage ? ` — ${session.firstMessage}` : "";
      return `${session.id}${name} (${session.messageCount} messages)${first}`;
    })
    .join("\n");
}

export function formatBranchRows(rows: SparkSessionTreeRow[]): string {
  if (rows.length === 0) return "Session branch tree is empty";
  return rows
    .map((row) => {
      const marker = row.active ? "*" : " ";
      return `${marker} ${"  ".repeat(row.depth)}${row.id} ${row.label}`;
    })
    .join("\n");
}

function entriesForExport(
  record: SparkSessionRecord,
  leafId: string | null | undefined,
): SparkSessionEntry[] {
  return leafId === undefined ? record.entries : getSparkSessionBranch(record, leafId);
}

function formatSessionReplayEntries(entries: SparkSessionEntry[]): string {
  if (entries.length === 0) return "Session replay is empty";
  return entries
    .map((entry, index) => `${index + 1}. ${entry.id} ${summarizeEntry(entry)}`)
    .join("\n");
}

function jsonLines(entries: SparkSessionFileEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseLeafArg(
  raw: string | undefined,
  fallback?: string | null,
): string | null | undefined {
  if (raw === undefined) return fallback;
  return raw === "root" ? null : raw;
}

function collectLabels(
  entries: SparkSessionEntry[],
): Map<string, { label?: string; timestamp: string }> {
  const labels = new Map<string, { label?: string; timestamp: string }>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    const labelEntry = entry as SparkLabelEntry;
    if (labelEntry.label)
      labels.set(labelEntry.targetId, { label: labelEntry.label, timestamp: labelEntry.timestamp });
    else labels.delete(labelEntry.targetId);
  }
  return labels;
}

function sortTreeByTimestamp(nodes: SparkSessionTreeNode[]): void {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort(
      (a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
    );
    stack.push(...node.children);
  }
}

function summarizeEntry(entry: SparkSessionEntry): string {
  if (entry.type === "message") return summarizeMessageEntry(entry as SparkSessionMessageEntry);
  if (entry.type === "model_change") return `model ${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return `thinking ${entry.thinkingLevel}`;
  if (entry.type === "branch_summary") return `branch summary: ${entry.summary}`;
  if (entry.type === "custom") return `custom ${entry.customType}`;
  if (entry.type === "custom_message") return `custom message ${entry.customType}`;
  if (entry.type === "session_info") return `session info ${entry.name ?? ""}`.trim();
  if (entry.type === "label") return `label ${entry.targetId}`;
  return entry.type;
}

function summarizeMessageEntry(entry: SparkSessionMessageEntry): string {
  const content = entry.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type: "text"; text: string } =>
              Boolean(
                part &&
                typeof part === "object" &&
                part.type === "text" &&
                typeof part.text === "string",
              ),
            )
            .map((part) => part.text)
            .join(" ")
        : "";
  const trimmed = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return `${entry.message.role}${trimmed ? `: ${trimmed}` : ""}`;
}

function describeEntry(entry: SparkSessionEntry): string {
  return `${entry.type} • ${entry.timestamp}`;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" | "success" = "info",
): void {
  ctx.ui?.notify?.(message, level);
}
