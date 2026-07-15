import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import {
  ProcessTerminal,
  SelectList,
  TUI,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "./pi-tui-adapter.ts";
import {
  selectListThemeFromTheme,
  type SparkModelSelectorCustomUi,
  type SparkModelSelectorTheme,
} from "./model-selector.ts";

export const CREATE_SPARK_SESSION_SELECTION = "__spark_create_session__";

/**
 * Legacy message-platform conversations may be recognizable only by their stored
 * `channel <adapter>:<scope>:<id>` title when an explicit binding is unavailable.
 */
const CHANNEL_SESSION_TITLE_RE =
  /^channel\s+(?:infoflow|qqbot|feishu):(?:group|user|c2c|channel|chat):.+$/iu;
const UNTITLED_SESSION_LABEL = "New conversation";

/**
 * Keep naming aligned with Cockpit while applying the native picker's narrower
 * policy: only local, non-archived sessions are attachable here.
 */
export function isSelectableSparkSession(session: SparkSessionRegistryRecord): boolean {
  if (session.status === "archived") return false;
  if (session.bindings.length > 0) return false;
  return !CHANNEL_SESSION_TITLE_RE.test(session.title?.trim() ?? "");
}

const plain = (text: string): string => text;

const PLAIN_SESSION_SELECTOR_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface SparkSessionSelectorOptions {
  sessions: SparkSessionRegistryRecord[];
  workspaceLabel: string;
  title?: string;
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

class SparkSessionSelectorComponent implements Component {
  private readonly title: string;
  private readonly workspaceLabel: string;
  private readonly requestRender?: () => void;
  private readonly selectList: SelectList;

  constructor(options: SparkSessionSelectorComponentOptions) {
    this.title = options.title ?? "Open Spark Session";
    this.workspaceLabel = options.workspaceLabel;
    this.requestRender = options.requestRender;
    const items = sessionSelectItems(options.sessions);
    this.selectList = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), 12),
      options.theme ?? PLAIN_SESSION_SELECTOR_THEME,
      { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 64 },
    );
    this.selectList.onSelect = (item) => options.onSelect(item.value);
    this.selectList.onCancel = () => options.onCancel?.();
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
    this.requestRender?.();
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.title, width),
      truncateToWidth(this.workspaceLabel, width),
      truncateToWidth("".padEnd(Math.min(width, 80), "─"), width),
      ...this.selectList.render(width),
      truncateToWidth("↑↓ navigate • enter open • esc exit", width),
    ].map((line) => truncateToWidth(line, width));
  }
}

function sessionSelectItems(sessions: SparkSessionRegistryRecord[]): SelectItem[] {
  return [
    {
      value: CREATE_SPARK_SESSION_SELECTION,
      label: "+ New session",
      description: "Create a daemon-managed session in this workspace",
    },
    ...sessions.filter(isSelectableSparkSession).map((session) => ({
      value: session.sessionId,
      label: session.title?.trim() || UNTITLED_SESSION_LABEL,
      description: [
        session.sessionId,
        session.model ? `${session.model.providerName}/${session.model.modelId}` : undefined,
        session.thinkingLevel ? `thinking=${session.thinkingLevel}` : undefined,
        relativeSessionUpdate(session.updatedAt),
      ]
        .filter(Boolean)
        .join(" • "),
    })),
  ];
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
