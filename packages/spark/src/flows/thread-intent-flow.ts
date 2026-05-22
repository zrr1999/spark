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
  const request: SparkAskToolParams = {
    mode: "clarification",
    flow: "thread-intent-refinement",
    title: `Clarify thread intent: ${input.title}`,
    context: [
      `Thread title: ${input.title}`,
      `Thread description: ${input.description?.trim() || input.title}`,
      "This looks like a generic or placeholder thread. Clarify the intended related task collection before planning concrete work.",
    ].join("\n"),
    questions: [
      {
        id: "intent",
        prompt: "What related work should this thread collect?",
        type: "freeform",
        required: false,
      },
      {
        id: "doneWhen",
        prompt: "When should this thread be considered complete?",
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
