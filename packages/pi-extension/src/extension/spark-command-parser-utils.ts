import type { RunRef } from "@zendev-lab/spark-core";

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

export type ForegroundDriverCommandAction = "start" | "status" | "stop" | "restart";

export interface ParsedForegroundDriverCommandArgs {
  action: ForegroundDriverCommandAction;
  objective: string;
  explicitAction: boolean;
}

export function parseForegroundDriverCommandArgs(args: string): ParsedForegroundDriverCommandArgs {
  const trimmed = args.trim();
  if (!trimmed) return { action: "start", objective: "", explicitAction: false };
  const firstWhitespace = firstWhitespaceIndex(trimmed);
  const first = firstWhitespace < 0 ? trimmed : trimmed.slice(0, firstWhitespace);
  const rest = firstWhitespace < 0 ? "" : trimmed.slice(firstWhitespace + 1).trim();
  const normalized = first.toLocaleLowerCase();
  const action = foregroundDriverCommandAction(normalized);
  if (action) return { action, objective: rest, explicitAction: true };
  return { action: "start", objective: trimmed, explicitAction: false };
}

function foregroundDriverCommandAction(value: string): ForegroundDriverCommandAction | undefined {
  if (value === "start" || value === "开始") return "start";
  if (value === "status" || value === "状态") return "status";
  if (
    value === "stop" ||
    value === "clear" ||
    value === "halt" ||
    value === "停止" ||
    value === "停下"
  )
    return "stop";
  if (value === "restart" || value === "重新开始" || value === "重启") return "restart";
  return undefined;
}

export function parseGoalCommandAction(args: string): ParsedForegroundDriverCommandArgs {
  return parseForegroundDriverCommandArgs(args);
}

export function parseGoalCommandArgs(args: string): string {
  return parseGoalCommandAction(args).objective;
}

export function parseLoopCommandAction(
  args: string,
):
  | { action: "continue" | "restart"; objective: string }
  | { action: "status" | "clear" | "removed" } {
  const trimmed = args.trim();
  const normalized = trimmed.toLocaleLowerCase();
  if (["pause", "暂停"].includes(normalized)) return { action: "removed" };
  const parsed = parseForegroundDriverCommandArgs(trimmed);
  if (parsed.action === "status") return { action: "status" };
  if (parsed.action === "stop") return { action: "clear" };
  if (parsed.action === "restart") return { action: "restart", objective: parsed.objective };
  return { action: "continue", objective: parsed.objective };
}

export type ParsedReproCommandAction = ForegroundDriverCommandAction;

export interface ParsedReproCommandArgs extends ParsedForegroundDriverCommandArgs {
  action: ParsedReproCommandAction;
}

export function parseReproCommandArgs(args: string): ParsedReproCommandArgs {
  return parseForegroundDriverCommandArgs(args);
}

export function parseDynamicWorkflowRunRefArg(command: string, args: string): RunRef {
  const runRef = args.trim().split(/\s+/u)[0] ?? "";
  if (!/^run:[a-zA-Z0-9-]+$/u.test(runRef)) {
    throw new Error(`/${command} requires a runRef like run:<id>`);
  }
  return runRef as RunRef;
}
