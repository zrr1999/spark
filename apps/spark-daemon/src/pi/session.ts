import { join } from "node:path";
import {
  createSparkHeadlessSessionExecutor,
  type SparkHeadlessSessionRunResult,
} from "@zendev-lab/spark-tui-app/headless-role-executor";
import type { SparkPaths } from "@zendev-lab/spark-system";

export type SparkDaemonPromptEvent = unknown;

export interface RunPiPromptOptions {
  cwd: string;
  prompt: string;
  paths: SparkPaths;
  tools: string[];
  invocationId: string;
  persistSession?: boolean;
  onEvent?: (event: SparkDaemonPromptEvent) => void;
}

/**
 * Compatibility entry point for older daemon callers.
 *
 * Despite the historical name, this now runs through Spark's own host/turn
 * stack via the headless Spark session executor. The daemon no longer creates
 * a pi-coding-agent AgentSession for core prompt execution.
 */
export async function runPiPrompt(
  options: RunPiPromptOptions,
): Promise<SparkHeadlessSessionRunResult> {
  const sparkHome = options.paths.piAgentDir ?? join(options.paths.dataDir, "pi-agent");
  const executeSession = createSparkHeadlessSessionExecutor({ sparkHome });
  return await executeSession({
    cwd: options.cwd,
    sparkHome,
    sessionId: options.persistSession
      ? safeSegment(options.invocationId)
      : `transient-${safeSegment(options.invocationId)}`,
    prompt: options.prompt,
    onEvent: options.onEvent,
  });
}

export function extractTextDelta(event: SparkDaemonPromptEvent): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  if (record.type === "stream_event" && record.event && typeof record.event === "object") {
    return textDeltaFromRecord(record.event as Record<string, unknown>);
  }

  if (record.type === "message_update" && record.assistantMessageEvent) {
    return textDeltaFromRecord(record.assistantMessageEvent as Record<string, unknown>);
  }

  return textDeltaFromRecord(record);
}

function textDeltaFromRecord(record: Record<string, unknown>): string | null {
  return record.type === "text_delta" && typeof record.delta === "string" ? record.delta : null;
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
