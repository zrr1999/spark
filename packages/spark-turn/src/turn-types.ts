import type { ResolvedToolPolicy, ToolConfig } from "@zendev-lab/spark-core";

export interface SparkTurnRegisteredTool {
  config: ToolConfig;
  /** Host-resolved immutable policy. Compatibility hosts may omit it. */
  policy?: ResolvedToolPolicy;
  active: boolean;
}

/** How a session satisfies `requiresApproval` tool gates. Default: `auto`. */
export type SparkToolApprovalMethod = "skip" | "human" | "auto";

/** When `auto` review does not approve: escalate to ask, or deny the tool call. */
export type SparkToolApprovalRejectAction = "ask" | "deny";
