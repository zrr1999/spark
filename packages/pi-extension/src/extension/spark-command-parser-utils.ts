import type { RunRef } from "@zendev-lab/spark-extension-api";

export function compactInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

export function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index]?.trim() === "") return index;
  }
  return -1;
}

export function isLowerAlphaNumeric(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
}

export function isWorkflowId(value: string): boolean {
  if (!value) return false;
  const first = value[0];
  if (!first || !isLowerAlphaNumeric(first)) return false;
  for (const char of value.slice(1)) {
    if (!isLowerAlphaNumeric(char) && char !== "-") return false;
  }
  return true;
}

export function parseWorkflowCommandArgs(args: string): { selector?: string; focus: string } {
  const trimmed = args.trim();
  if (!trimmed) return { focus: "" };
  const firstWhitespace = firstWhitespaceIndex(trimmed);
  const candidate = firstWhitespace < 0 ? trimmed : trimmed.slice(0, firstWhitespace);
  const rest = firstWhitespace < 0 ? "" : trimmed.slice(firstWhitespace + 1).trim();
  const separator = candidate.indexOf(":");
  if (separator < 0) return { focus: trimmed };
  const source = candidate.slice(0, separator);
  const id = candidate.slice(separator + 1);
  if ((source === "builtin" || source === "workspace" || source === "user") && isWorkflowId(id)) {
    return { selector: source + ":" + id, focus: rest };
  }
  return { focus: trimmed };
}

export function parseGoalCommandArgs(args: string): string {
  return args.trim();
}

export function parseLoopCommandAction(
  args: string,
): { action: "continue"; objective: string } | { action: "clear" } | { action: "removed" } {
  const trimmed = args.trim();
  const normalized = trimmed.toLocaleLowerCase();
  if (["stop", "halt", "停止", "停下"].includes(normalized)) {
    return { action: "clear" };
  }
  if (["pause", "暂停"].includes(normalized)) {
    return { action: "removed" };
  }
  return { action: "continue", objective: trimmed };
}

export function parseDynamicWorkflowRunRefArg(command: string, args: string): RunRef {
  const runRef = args.trim().split(/\s+/u)[0] ?? "";
  if (!/^run:[a-zA-Z0-9-]+$/u.test(runRef)) {
    throw new Error(`/${command} requires a runRef like run:<id>`);
  }
  return runRef as RunRef;
}
