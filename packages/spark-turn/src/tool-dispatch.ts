/**
 * Tool policy / dispatch helpers for SparkAgentLoop.
 */
import {
  resolveToolPolicy,
  type ResolvedToolPolicy,
  type ToolConfig,
} from "@zendev-lab/spark-core";
import type { AssistantMessage, Tool, ToolCall, ToolResultMessage } from "@zendev-lab/spark-ai";
import {
  compactToolResultContent,
  type SparkToolResultRawRecoveryDecision,
  type SparkToolResultRawRecoveryPath,
} from "./tool-result-compaction.ts";
import type { SparkTurnRegisteredTool } from "./turn-types.ts";
import type { SparkToolApprovalMethod, SparkToolApprovalRejectAction } from "./turn-types.ts";

export type ToolResultRawRecoveryRecord = {
  evidenceRef: string;
  reason: SparkToolResultRawRecoveryDecision["reason"];
  omittedChars: number;
  bodyChars: number;
  recoveryPath: SparkToolResultRawRecoveryPath;
  readHint: string;
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function mergeToolResultDetails(
  originalDetails: unknown,
  compaction: ReturnType<typeof compactToolResultContent>["details"],
  rawRecovery: ToolResultRawRecoveryRecord | undefined,
): unknown {
  if (!compaction && !rawRecovery) return originalDetails;
  return {
    ...(isPlainRecord(originalDetails) ? originalDetails : {}),
    ...(compaction ? { toolResultCompaction: compaction } : {}),
    ...(rawRecovery
      ? {
          toolResultRawRecovery: {
            evidenceRef: rawRecovery.evidenceRef,
            reason: rawRecovery.reason,
            omittedChars: rawRecovery.omittedChars,
            bodyChars: rawRecovery.bodyChars,
            recoveryPath: rawRecovery.recoveryPath,
            readHint: rawRecovery.readHint,
          },
        }
      : {}),
  };
}

export function rawToolResultRecoveryPath(evidenceRef: string): SparkToolResultRawRecoveryPath {
  return {
    kind: "evidence",
    evidenceRef,
    readTool: "evidence",
    readArgs: { action: "read", evidenceRef, maxChars: 20_000 },
  };
}

export function appendRawRecoveryHint(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  hint: string,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  const index = content.findLastIndex(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  const hintText = `[recovery] ${hint}`;
  if (index < 0) return [...content, { type: "text", text: hintText }];
  return content.map((part, partIndex) =>
    partIndex === index ? { ...part, text: `${part.text}\n\n${hintText}` } : part,
  );
}

export function rawToolResultEvidenceBody(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
): { format: "text" | "json"; body: string | Record<string, unknown>; bodyChars: number } {
  if (content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    return { format: "text", body: content[0].text, bodyChars: content[0].text.length };
  }
  const body = { schemaVersion: 1, content: jsonSafe(content) };
  return { format: "json", body, bodyChars: JSON.stringify(body).length };
}

export function rawToolOutputProducer(toolName: string): "spark" | "cue" {
  return toolName.startsWith("cue_") || toolName === "script_run" || toolName === "script_eval"
    ? "cue"
    : "spark";
}

export function evidenceRefFromToolResult(result: {
  content?: unknown;
  details?: unknown;
}): string | undefined {
  const details = isPlainRecord(result.details) ? result.details : undefined;
  const refs = isPlainRecord(details?.refs) ? details.refs : undefined;
  const fromRefs = stringField(refs, "evidenceRef");
  if (fromRefs?.startsWith("evidence:")) return fromRefs;
  const evidence = isPlainRecord(details?.evidence) ? details.evidence : undefined;
  const fromEvidence = stringField(evidence, "ref");
  if (fromEvidence?.startsWith("evidence:")) return fromEvidence;
  const text = Array.isArray(result.content)
    ? result.content
        .map((part) => (isPlainRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
  return text.match(/evidence:[A-Za-z0-9._:-]+/u)?.[0];
}

export function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol")
    return value.description ? `[Symbol:${value.description}]` : "[Symbol]";
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      jsonSafe(child, seen),
    ]),
  );
}

export function collectToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

export function resolvedRegisteredToolPolicy(tool: SparkTurnRegisteredTool): ResolvedToolPolicy {
  const policy = tool.policy ?? resolveToolPolicy(tool.config);
  if (!legacyApprovalPolicyRequiresApproval(tool.config) || policy.approval === "required") {
    return policy;
  }
  return Object.freeze({
    ...policy,
    executionMode: "sequential",
    approval: "required",
  });
}

export function toolRequiresApproval(tool: SparkTurnRegisteredTool): boolean {
  return resolvedRegisteredToolPolicy(tool).approval === "required";
}

export function legacyApprovalPolicyRequiresApproval(config: ToolConfig): boolean {
  const approvalPolicy = (config as { approvalPolicy?: unknown }).approvalPolicy;
  if (approvalPolicy === true || approvalPolicy === "always") return true;
  return Boolean(
    approvalPolicy &&
    typeof approvalPolicy === "object" &&
    (approvalPolicy as { mode?: unknown }).mode === "always",
  );
}

export function safeSelectedSkills(
  getSelectedSkills: (() => readonly string[]) | undefined,
): readonly string[] {
  if (!getSelectedSkills) return [];
  try {
    const selected = getSelectedSkills();
    return Array.isArray(selected)
      ? selected.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function normalizeApprovalMethod(
  value: SparkToolApprovalMethod | undefined,
): SparkToolApprovalMethod {
  if (value === "skip" || value === "human" || value === "auto") return value;
  return "auto";
}

export function normalizeApprovalRejectAction(
  value: SparkToolApprovalRejectAction | undefined,
): SparkToolApprovalRejectAction {
  if (value === "ask" || value === "deny") return value;
  return "ask";
}

export function toToolDefinition(config: ToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters as Tool["parameters"],
  };
}

export function errorToolResult(toolCall: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message }],
    isError: true,
    timestamp: Date.now(),
  };
}
