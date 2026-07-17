import { basename } from "node:path";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import {
  Key,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectListTheme,
} from "./pi-tui-adapter.ts";
import {
  selectListThemeFromTheme,
  type SparkModelSelectorCustomUi,
  type SparkModelSelectorTheme,
} from "./model-selector.ts";

export const CREATE_SPARK_SESSION_SELECTION = "__spark_create_session__";

const UNTITLED_SESSION_LABEL = "New conversation";

/** Match the daemon and Cockpit default list boundary: archived sessions are opt-in. */
export function isSelectableSparkSession(session: SparkSessionRegistryRecord): boolean {
  return session.status !== "archived";
}

const plain = (text: string): string => text;

const PLAIN_SESSION_SELECTOR_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface SparkSessionSelectorWorkspace {
  id: string;
  canonicalId: string;
  displayName: string;
  localPath: string;
}

export interface SparkSessionSelectorOptions {
  sessions: SparkSessionRegistryRecord[];
  workspaceId: string;
  workspaceLabel: string;
  workspaces?: SparkSessionSelectorWorkspace[];
  title?: string;
  maxVisible?: number;
}

export async function runNativeSparkSessionSelector(
  options: SparkSessionSelectorOptions,
): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  let resolveSelection: ((selection: string | null) => void) | undefined;
  const selection = new Promise<string | null>((resolve) => {
    resolveSelection = resolve;
  });
  const component = createSparkSessionSelectorComponent({
    ...options,
    onSelect: (value) => resolveSelection?.(value),
    onCancel: () => resolveSelection?.(null),
    requestRender: () => tui.requestRender(),
  });
  tui.addChild(component);
  tui.setFocus(component);
  terminal.setTitle("Select Spark Session");
  tui.start();
  tui.requestRender(true);
  try {
    return await selection;
  } finally {
    tui.stop();
    await terminal.drainInput();
  }
}

export async function selectSparkSessionFromCustomUi(
  ui: SparkModelSelectorCustomUi,
  options: SparkSessionSelectorOptions,
): Promise<string | null> {
  if (typeof ui.custom !== "function") return null;
  return await ui.custom<string | null>(
    (tui, theme, _keybindings, done) =>
      createSparkSessionSelectorComponent({
        ...options,
        theme: selectListThemeFromTheme(theme as SparkModelSelectorTheme),
        onSelect: done,
        onCancel: () => done(null),
        requestRender: () => tui.requestRender(),
      }),
    {
      overlay: true,
      overlayOptions: { width: "72%", minWidth: 56, maxHeight: "82%" },
    },
  );
}

export interface SparkSessionSelectorComponentOptions extends SparkSessionSelectorOptions {
  theme?: SelectListTheme;
  onSelect: (selection: string) => void;
  onCancel?: () => void;
  requestRender?: () => void;
}

export function createSparkSessionSelectorComponent(
  options: SparkSessionSelectorComponentOptions,
): Component {
  return new SparkSessionSelectorComponent(options);
}

interface SparkSessionSelectionItem {
  value: string;
  label: string;
  description: string;
}

interface SparkSessionSelectionGroup {
  key: string;
  label: string;
  tabLabel: string;
  items: SparkSessionSelectionItem[];
}

class SparkSessionSelectorComponent implements Component {
  private readonly title: string;
  private readonly requestRender?: () => void;
  private readonly onSelect: (selection: string) => void;
  private readonly onCancel?: () => void;
  private readonly theme: SelectListTheme;
  private readonly groups: SparkSessionSelectionGroup[];
  private readonly selectedByGroup = new Map<string, number>();
  private readonly maxVisible: number;
  private activeGroupIndex = 0;

  constructor(options: SparkSessionSelectorComponentOptions) {
    this.title = options.title ?? "Open Spark Session";
    this.requestRender = options.requestRender;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.theme = options.theme ?? PLAIN_SESSION_SELECTOR_THEME;
    this.groups = sessionSelectionGroups(options);
    this.maxVisible = Math.max(1, options.maxVisible ?? 14);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) || data === "h") {
      this.moveGroup(-1);
    } else if (matchesKey(data, Key.right) || data === "l") {
      this.moveGroup(1);
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.moveSelection(-1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.moveSelection(1);
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.activeGroup().items[this.selectedIndex()];
      if (selected) this.onSelect(selected.value);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
    this.requestRender?.();
  }

  render(width: number): string[] {
    const group = this.activeGroup();
    const visibleItems = this.visibleItems(group);
    const lines = [
      truncateToWidth(this.title, width),
      this.renderGroupTabs(width),
      truncateToWidth("".padEnd(Math.min(width, 80), "─"), width),
      ...visibleItems.map((item) => this.renderItem(item, width)),
    ];
    if (group.items.length > visibleItems.length) {
      lines.push(this.theme.scrollInfo(`  (${this.selectedIndex() + 1}/${group.items.length})`));
    }
    lines.push(truncateToWidth("←→ group • ↑↓ session • enter open • esc exit", width));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private activeGroup(): SparkSessionSelectionGroup {
    return this.groups[this.activeGroupIndex]!;
  }

  private selectedIndex(group = this.activeGroup()): number {
    return Math.min(this.selectedByGroup.get(group.key) ?? 0, group.items.length - 1);
  }

  private moveGroup(step: number): void {
    this.activeGroupIndex =
      (this.activeGroupIndex + step + this.groups.length) % this.groups.length;
  }

  private moveSelection(step: number): void {
    const group = this.activeGroup();
    if (group.items.length === 0) return;
    const selected = (this.selectedIndex(group) + step + group.items.length) % group.items.length;
    this.selectedByGroup.set(group.key, selected);
  }

  private visibleItems(group: SparkSessionSelectionGroup): SparkSessionSelectionItem[] {
    if (group.items.length <= this.maxVisible) return group.items;
    const selected = this.selectedIndex(group);
    let start = Math.max(0, selected - Math.floor(this.maxVisible / 2));
    start = Math.min(start, group.items.length - this.maxVisible);
    return group.items.slice(start, start + this.maxVisible);
  }

  private renderGroupTabs(width: number): string {
    const tabs = this.groups.map((group, index) => {
      const count = sessionGroupCount(group);
      const label = `${group.tabLabel} (${count})`;
      return index === this.activeGroupIndex
        ? this.theme.selectedText(`[${label}]`)
        : this.theme.description(label);
    });
    const allTabs = `← ${tabs.join("  ")} →`;
    if (visibleWidth(allTabs) <= width) return allTabs;
    const active = tabs[this.activeGroupIndex]!;
    return truncateToWidth(
      `← ${active} →  ${this.activeGroupIndex + 1}/${this.groups.length}`,
      width,
    );
  }

  private renderItem(item: SparkSessionSelectionItem, width: number): string {
    const selected = item.value === this.activeGroup().items[this.selectedIndex()]?.value;
    const prefix = selected ? "→ " : "  ";
    const labelWidth =
      width > 56 ? Math.min(48, Math.max(24, Math.floor(width * 0.45))) : width - 4;
    const label = truncateToWidth(`  ${item.label}`, Math.max(1, labelWidth), "");
    const padded = `${prefix}${label}${" ".repeat(Math.max(2, labelWidth - visibleWidth(label) + 2))}`;
    const descriptionWidth = Math.max(0, width - visibleWidth(padded) - 1);
    const description =
      descriptionWidth > 10 ? truncateToWidth(item.description, descriptionWidth, "") : "";
    const line = `${padded}${description}`;
    return selected ? this.theme.selectedText(line) : line;
  }
}

export function formatSparkSessionListByWorkspace(options: SparkSessionSelectorOptions): string {
  const groups = sessionSelectionGroups(options)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.value !== CREATE_SPARK_SESSION_SELECTION),
    }))
    .filter((group) => group.items.length > 0);
  if (groups.length === 0) return "No managed Spark sessions in daemon.";
  return [
    "Spark daemon sessions:",
    ...groups.flatMap((group) => [
      `${group.label} (${group.items.length})`,
      ...group.items.map((item) => `  ${item.label} • ${item.description}`),
    ]),
  ].join("\n");
}

function sessionSelectionGroups(
  options: SparkSessionSelectorOptions,
): SparkSessionSelectionGroup[] {
  const byKey = new Map<string, SparkSessionSelectionGroup>();
  const currentKey = `workspace:${options.workspaceId}`;
  byKey.set(currentKey, {
    key: currentKey,
    label: options.workspaceLabel,
    tabLabel: currentWorkspaceTabLabel(options),
    items: [
      {
        value: CREATE_SPARK_SESSION_SELECTION,
        label: "+ New session",
        description: "Create a daemon-managed session in this workspace",
      },
    ],
  });

  for (const session of options.sessions.filter(isSelectableSparkSession)) {
    const identity = sessionGroupIdentity(session, options);
    const group = byKey.get(identity.key) ?? {
      key: identity.key,
      label: identity.label,
      tabLabel: identity.tabLabel,
      items: [],
    };
    group.items.push(sessionSelectionItem(session));
    byKey.set(identity.key, group);
  }
  return [...byKey.values()];
}

function sessionGroupCount(group: SparkSessionSelectionGroup): number {
  return group.items.filter((item) => item.value !== CREATE_SPARK_SESSION_SELECTION).length;
}

function currentWorkspaceTabLabel(options: SparkSessionSelectorOptions): string {
  return options.workspaceLabel.split(" • ")[0]?.trim() || options.workspaceId;
}

function sessionGroupIdentity(
  session: SparkSessionRegistryRecord,
  options: SparkSessionSelectorOptions,
): { key: string; label: string; tabLabel: string } {
  if (session.scope.kind === "daemon") {
    return {
      key: "tui-only",
      label: "TUI only",
      tabLabel: "TUI only",
    };
  }
  const workspaceId = session.scope.workspaceId;
  if (workspaceId === options.workspaceId) {
    return {
      key: `workspace:${workspaceId}`,
      label: options.workspaceLabel,
      tabLabel: currentWorkspaceTabLabel(options),
    };
  }
  const workspace = options.workspaces?.find((candidate) => candidate.id === workspaceId);
  if (workspace?.canonicalId === options.workspaceId) {
    return {
      key: `workspace:${options.workspaceId}`,
      label: options.workspaceLabel,
      tabLabel: currentWorkspaceTabLabel(options),
    };
  }
  if (workspace) {
    return {
      key: `workspace:${workspace.canonicalId}`,
      label: `${workspace.displayName} • ${workspace.localPath}`,
      tabLabel: workspace.displayName,
    };
  }
  if (!session.cwd) {
    return { key: `workspace:${workspaceId}`, label: workspaceId, tabLabel: workspaceId };
  }
  const workspaceName = basename(session.cwd);
  return {
    key: `workspace:${workspaceId}`,
    label:
      workspaceName === workspaceId
        ? `${workspaceId} • ${session.cwd}`
        : `${workspaceName} • ${workspaceId} • ${session.cwd}`,
    tabLabel: workspaceName,
  };
}

function sessionSelectionItem(session: SparkSessionRegistryRecord): SparkSessionSelectionItem {
  const channel = session.bindings[0];
  return {
    value: session.sessionId,
    label: session.title?.trim() || UNTITLED_SESSION_LABEL,
    description: [
      session.sessionId,
      channel ? channel.adapter : undefined,
      session.status === "running" ? session.status : undefined,
      session.model ? `${session.model.providerName}/${session.model.modelId}` : undefined,
      session.thinkingLevel ? `thinking=${session.thinkingLevel}` : undefined,
      relativeSessionUpdate(session.updatedAt),
    ]
      .filter(Boolean)
      .join(" • "),
  };
}

function relativeSessionUpdate(updatedAt: string): string {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return updatedAt;
  const seconds = Math.max(0, Math.floor((Date.now() - updated) / 1_000));
  if (seconds < 60) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}
