import { detectCopyLanguage, type CopyLanguage } from "pi-extension-api";
import { escapeYamlLine } from "./task-plan-tool.ts";

export interface SparkInitClarificationData {
  workingTitle?: string;
  outputLanguage?: CopyLanguage;
  sparkFocus?: string;
  objective?: string;
  targetUser?: string;
  smallestSlice?: string;
  successSignal?: string;
  nonGoals?: string;
  deliveryMode?: string;
  nextAction?: string;
}

export function titleFromIdea(idea: string): string {
  const firstLine = idea.split(/\r?\n/, 1)[0]?.trim() ?? "Spark project";
  return normalizeProjectTitle(firstLine);
}

export function normalizeProjectTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim() || "Spark project";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

export function renderSparkMd(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const language = input.clarification?.outputLanguage ?? detectCopyLanguage(input.idea);
  return language === "zh" ? renderSparkMdZh(input) : renderSparkMdEn(input);
}

export function describeDeliveryMode(value: string | undefined, language: CopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "clarify_only":
        return "只澄清意图，不继续扩展交付。";
      case "document":
        return "澄清并写入文档。";
      case "document_and_execute":
        return "澄清、写入文档并继续执行。";
      case "execute":
        return "直接进入执行。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "clarify_only":
      return "Clarification only.";
    case "document":
      return "Clarification and documentation.";
    case "document_and_execute":
      return "Clarification, documentation, and continued execution.";
    case "execute":
      return "Proceed directly to execution.";
    default:
      return "To be confirmed.";
  }
}

function renderSparkMdEn(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryEn(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## Origin");
  sections.push("");
  sections.push(shortSummaryEn(input.idea));
  sections.push("");
  sections.push("## Working title");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.sparkFocus) {
    sections.push("");
    sections.push("## Spark focus");
    sections.push("");
    sections.push(`- ${describeSparkFocus(input.clarification.sparkFocus, "en")}`);
  }
  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## Delivery mode");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "en")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## Target users");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## Objective");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## Smallest slice");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## Success signal");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## Non-goals");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## Open questions");
  sections.push("");
  sections.push(
    "- Does the current interaction task reflect the latest confirmed intent?<!-- dynamically maintained -->",
  );
  sections.push(
    "- Is the next concrete action specific enough to execute?<!-- dynamically maintained -->",
  );
  sections.push("");
  sections.push("## Revision history");
  sections.push("");
  sections.push(`- ${date}: Generated during Spark initialization.`);
  return `${sections.join("\n")}\n`;
}

function renderSparkMdZh(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryZh(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## 起源");
  sections.push("");
  sections.push(shortSummaryZh(input.idea));
  sections.push("");
  sections.push("## 当前工作标题");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.sparkFocus) {
    sections.push("");
    sections.push("## Spark 重点");
    sections.push("");
    sections.push(`- ${describeSparkFocus(input.clarification.sparkFocus, "zh")}`);
  }
  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## 交付方式");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "zh")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## 目标用户");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## 目标");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## 最小切片");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## 成功信号");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## 非目标");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## 开放问题");
  sections.push("");
  sections.push("- 当前交互 task 是否准确反映了最新确认的意图？<!-- 动态维护 -->");
  sections.push("- 下一个具体动作是否已经明确到可执行？<!-- 动态维护 -->");
  sections.push("");
  sections.push("## 修订记录");
  sections.push("");
  sections.push(`- ${date}：由 Spark 初始化生成。`);
  return `${sections.join("\n")}\n`;
}

function describeSparkFocus(value: string | undefined, language: CopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "audit":
        return "审计差距。";
      case "light_refactor":
        return "轻量重构。";
      case "docs_alignment":
        return "文档对齐。";
      case "execute_change":
        return "执行改动。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "audit":
      return "Audit gaps.";
    case "light_refactor":
      return "Light refactor.";
    case "docs_alignment":
      return "Docs alignment.";
    case "execute_change":
      return "Execute change.";
    default:
      return "To be confirmed.";
  }
}

function shortSummaryEn(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function shortSummaryZh(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
