/**
 * pi-extension-api — shared contract surface (types only).
 *
 * This package centralises the ExtensionAPI shape that pi-spark's extensions
 * speak to. Both the upstream pi-coding-agent runtime and the spark-cli native
 * pi-tui host implement (a superset of) this surface; extensions stay
 * portable as long as they only depend on the names exported from here.
 *
 * Runtime impact: zero. The package contains type declarations only.
 *
 * Design rules:
 *   - Every method is `optional` so extensions must guard each call. This lets
 *     a host implement only the slice it cares about while still satisfying the
 *     contract (e.g. a roles-only host might omit `registerTool`).
 *   - ExtensionContext is a union of capabilities observed across pi-coding-agent
 *     and spark-cli; consumers should only read what they need.
 *   - Adding a method here is a contract change. Update both hosts and the
 *     ExtensionAPI contract tests in the same change set.
 */

export interface ExtensionAPI {
  registerCommand?(name: string, config: CommandConfig): void;
  registerTool?(config: ToolConfig): void;
  on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
  getAllTools?(): ToolInfo[];
  setActiveTools?(names: string[]): void;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

export interface CommandConfig {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

export interface ToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolRenderTheme,
    context: unknown,
  ) => ToolRenderComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: ExtensionContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

export interface ToolRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface ToolRenderComponent {
  render(width: number): string[];
}

export interface ToolInfo {
  name: string;
}

export type ExtensionUiNotifyLevel = "info" | "warning" | "error" | "success";

export interface ExtensionUi {
  notify?: (message: string, level?: ExtensionUiNotifyLevel) => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  selectWithCustom?: (
    title: string,
    input: { options: string[]; customLabel: string },
  ) => Promise<{ value?: string; customText?: string } | string | undefined>;
  setStatus?: (key: string, text: string | undefined) => void;
  setWidget?: (
    key: string,
    callback: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
  setTitle?: (title: string) => void;
  custom?: (...args: unknown[]) => unknown;
}

export interface ExtensionContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: ExtensionUi;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}
