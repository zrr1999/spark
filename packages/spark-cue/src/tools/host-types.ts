/** Host/tool registration types and policies for spark-cue. */

import type { ToolEffect, ToolExecutionMode, ToolPolicy } from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-tui/text";
import type { CueClient } from "../client/cue-client.ts";

export interface SparkCueHostApi {
  registerTool(config: SparkCueToolConfig): void;
  on?(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export type SparkCueNotifyLevel = "info" | "warning" | "error" | "success";

export interface SparkCueToolContext {
  cwd?: string;
  sessionId?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  env?: Record<string, string | undefined>;
  cueClient?: CueClient;
  ui?: { notify?: (msg: string, level: SparkCueNotifyLevel) => void };
}

export interface SparkCueToolConfig {
  name: string;
  label?: string;
  description: string;
  policy?: ToolPolicy;
  /** Legacy mirrors populated from policy for Pi/current Spark turn hosts. */
  effect?: ToolEffect;
  executionMode?: ToolExecutionMode;
  /** Cue exec family tools require host approval gated by session approvalMethod. */
  requiresApproval?: boolean;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkCueToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

export const CUE_EXECUTION_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "execution"],
  phases: ["implement"],
  // Temporary: skip host approve/ask gates for cue exec while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_JOBS_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "jobs"],
  phases: ["implement"],
  // Temporary: skip host approve/ask gates for cue jobs while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_RESOURCES_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "resources"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_SCHEDULE_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "schedules"],
  phases: ["implement"],
  // Temporary: skip host approve/ask gates for cue schedule while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_SCOPE_TOOL_POLICY = {
  // cue_scope combines inspection with cwd/env mutation, so the whole action
  // surface is conservatively stateful until actions gain parameter policies.
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "scope"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_HISTORY_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "history"],
  phases: ["plan", "implement"],
  approval: "none",
} as const satisfies ToolPolicy;

export function registerCueTool(pi: SparkCueHostApi, config: SparkCueToolConfig): void {
  const effect = config.effect ?? config.policy?.effect;
  const executionMode = config.executionMode ?? config.policy?.executionMode;
  const requiresApproval =
    config.requiresApproval ?? (config.policy?.approval === "required" ? true : undefined);
  pi.registerTool({
    ...config,
    ...(effect ? { effect } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(requiresApproval === true ? { requiresApproval } : {}),
  });
}

export interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface ToolCallComponent {
  render(width: number): string[];
}

export class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}
