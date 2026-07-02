import type { ArtifactRef } from "@zendev-lab/spark-extension-api";
import {
  runSparkAskTool,
  type SparkAskToolParams,
  type SparkAskToolUi,
} from "../extension/spark-ask-tool.ts";

export interface ProjectPurposeClarificationResult {
  asked: boolean;
  artifactRef?: ArtifactRef;
  summary?: string;
  blocked: boolean;
}

export function shouldClarifyProjectPurpose(input: {
  title: string;
  description?: string;
  explicitProject?: string;
}): boolean {
  if (input.explicitProject?.trim()) return false;
  const title = input.title.trim();
  const description = input.description?.trim() ?? "";
  if (!title) return false;
  if (description && description !== title) return false;
  return isGenericProjectTitle(title);
}

export async function clarifyProjectPurposeIfNeeded(input: {
  cwd: string;
  title: string;
  description?: string;
  explicitProject?: string;
  ui?: SparkAskToolUi;
}): Promise<ProjectPurposeClarificationResult> {
  if (!shouldClarifyProjectPurpose(input)) return { asked: false, blocked: false };
  const copy = projectPurposeAskCopy(input.title, input.description);
  const request: SparkAskToolParams = {
    mode: "clarification",
    flow: "project-purpose-refinement",
    title: `Clarify workstream for “${copy.title}”`,
    context: [
      `Proposed project label: ${copy.title}`,
      `Current description: ${copy.description}`,
      `Reason for asking: “${copy.title}” does not yet identify the concrete work this project should group.`,
    ].join("\n"),
    questions: [
      {
        id: "purpose",
        prompt: `For “${copy.title}”, which concrete workstream, feature, bug, or decision family should its tasks belong to?`,
        type: "freeform",
        required: false,
      },
      {
        id: "doneWhen",
        prompt: `For that “${copy.title}” workstream, what observable outcome would make it complete enough to close?`,
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

function projectPurposeAskCopy(
  title: string,
  description: string | undefined,
): { title: string; description: string } {
  const normalizedTitle = summarizeProjectText(title) || "untitled project";
  const normalizedDescription = summarizeProjectText(description) || normalizedTitle;
  return { title: normalizedTitle, description: normalizedDescription };
}

function summarizeProjectText(value: string | undefined): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  if (compact.length <= 100) return compact;
  return `${compact.slice(0, 97).trimEnd()}…`;
}

function isGenericProjectTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "spark project" ||
    normalized === "new project" ||
    normalized === "project" ||
    normalized === "todo" ||
    normalized === "tasks" ||
    normalized === "整理一下" ||
    normalized === "自定义输入" ||
    normalized === "「自定义输入」" ||
    /^project[-_ ]?\d*$/.test(normalized) ||
    /^task[-_ ]?\d*$/.test(normalized)
  );
}
