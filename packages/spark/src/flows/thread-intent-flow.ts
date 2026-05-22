import { type ArtifactRef } from "spark-core";
import { runSparkAskTool, type SparkAskToolParams, type SparkAskToolUi } from "spark-ask";

export interface ThreadIntentClarificationResult {
  asked: boolean;
  artifactRef?: ArtifactRef;
  summary?: string;
  blocked: boolean;
}

export function shouldClarifyThreadIntent(input: {
  title: string;
  description?: string;
  explicitThread?: string;
}): boolean {
  if (input.explicitThread?.trim()) return false;
  const title = input.title.trim();
  const description = input.description?.trim() ?? "";
  if (!title) return false;
  if (description && description !== title) return false;
  return isGenericThreadTitle(title);
}

export async function clarifyThreadIntentIfNeeded(input: {
  cwd: string;
  title: string;
  description?: string;
  explicitThread?: string;
  ui?: SparkAskToolUi;
}): Promise<ThreadIntentClarificationResult> {
  if (!shouldClarifyThreadIntent(input)) return { asked: false, blocked: false };
  const copy = threadIntentAskCopy(input.title, input.description);
  const request: SparkAskToolParams = {
    mode: "clarification",
    flow: "thread-intent-refinement",
    title: `Clarify thread intent for “${copy.title}”`,
    context: [
      `Proposed thread title: ${copy.title}`,
      `Current description: ${copy.description}`,
      `Reason for asking: “${copy.title}” does not yet identify the related work this thread should group.`,
    ].join("\n"),
    questions: [
      {
        id: "intent",
        prompt: `For the placeholder thread “${copy.title}”, which concrete workstream, feature, bug, or decision family should its tasks belong to?`,
        type: "freeform",
        required: false,
      },
      {
        id: "doneWhen",
        prompt: `For that “${copy.title}” workstream, what observable outcome would make this thread complete enough to close?`,
        type: "freeform",
        required: false,
      },
    ],
  };
  const response = await runSparkAskTool(request, { cwd: input.cwd, ui: input.ui });
  const details = response.details as {
    artifactRef?: ArtifactRef;
    blocked?: boolean;
    summary?: string;
  };
  return {
    asked: true,
    artifactRef: details.artifactRef,
    summary: details.summary,
    blocked: details.blocked === true,
  };
}

function threadIntentAskCopy(
  title: string,
  description: string | undefined,
): { title: string; description: string } {
  const normalizedTitle = summarizeThreadText(title) || "untitled thread";
  const normalizedDescription = summarizeThreadText(description) || normalizedTitle;
  return { title: normalizedTitle, description: normalizedDescription };
}

function summarizeThreadText(value: string | undefined): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  if (compact.length <= 100) return compact;
  return `${compact.slice(0, 97).trimEnd()}…`;
}

function isGenericThreadTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "spark thread" ||
    normalized === "new thread" ||
    normalized === "thread" ||
    normalized === "todo" ||
    normalized === "tasks" ||
    normalized === "整理一下" ||
    normalized === "自定义输入" ||
    normalized === "「自定义输入」" ||
    /^thread[-_ ]?\d*$/.test(normalized) ||
    /^task[-_ ]?\d*$/.test(normalized)
  );
}
