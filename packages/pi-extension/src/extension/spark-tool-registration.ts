import type { ToolCallComponent, ToolCallRenderTheme } from "./tool-rendering.ts";
import type { SparkDriveMode, SparkDriveModeInput } from "./spark-drive-state.ts";

export interface SparkRegisteredToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkToolContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export type SparkToolRegistrar = (config: SparkRegisteredToolConfig) => void;

export interface SparkSessionModelRef {
  provider?: unknown;
  id?: unknown;
}

export interface SparkToolContext {
  cwd: string;
  model?: SparkSessionModelRef;
  sparkActiveLens?: {
    phase: "research" | "plan" | "implement";
    drive?: SparkDriveModeInput;
  };
  isIdle?: () => boolean;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  hasUI?: boolean;
  askAutoAnswer?: "reviewer";
  askAutoAnswerResolver?: (request: unknown, ctx: any) => Promise<unknown>;

  sparkAutonomousGoalTurn?: { goalId: string };
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    selectWithCustom?: (
      title: string,
      input: { options: string[]; customLabel: string },
    ) => Promise<{ value?: string; customText?: string } | string | undefined>;
    setWidget?: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    setEditorText?: (text: string) => void;
    custom?: (...args: unknown[]) => unknown;
  };
}
