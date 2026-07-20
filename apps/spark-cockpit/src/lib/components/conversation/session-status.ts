import type { SparkModelRef, SparkSessionView } from "@zendev-lab/spark-protocol";

export interface SessionStatusBarLabels {
  bar: string;
  workingDirectory: string;
  branch: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  cacheHit: string;
  cost: string;
  context: string;
}

export interface SessionStatusSnapshot {
  cwd: string;
  gitBranch?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextTokenSource?: "reported" | "tokenizer" | "estimated";
  contextWindow?: number;
}

export interface SessionStatusUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextTokenSource?: "reported" | "tokenizer" | "estimated";
  contextWindow?: number;
}

export interface SessionStatusIdentityInput {
  sessionModel?: SparkModelRef;
  defaultModel?: SparkModelRef;
  sessionThinkingLevel?: string;
}

/** Prefer session-scoped control truth, then the canonical session snapshot, over global defaults. */
export function sessionStatusIdentity(
  session: SparkSessionView | null,
  control: SessionStatusIdentityInput,
): { model?: SparkModelRef; thinkingLevel?: string } {
  const model = control.sessionModel ?? session?.model ?? control.defaultModel;
  const thinkingLevel = control.sessionThinkingLevel ?? session?.thinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/** Merge the daemon snapshot baseline with run updates received after that snapshot. */
export function sessionStatusUsage(
  session: SparkSessionView | null,
  contextWindow?: number,
): SessionStatusUsage {
  const baseline = session?.usage;
  let usage: SessionStatusUsage = baseline ? { ...baseline } : {};
  for (const run of session?.runs ?? []) {
    if (run.kind !== "session") continue;
    const totals = recordValue(run.metadata.usageTotals);
    if (!totals) continue;
    const latestCacheHitPercent =
      numberValue(totals.latestCacheHitPercent) ?? usage.latestCacheHitPercent;
    const latestContextTokens = numberValue(totals.contextTokens) ?? usage.contextTokens;
    const latestContextTokenSource =
      totals.contextTokenSource === "reported" ||
      totals.contextTokenSource === "tokenizer" ||
      totals.contextTokenSource === "estimated"
        ? totals.contextTokenSource
        : usage.contextTokenSource;
    const latestContextWindow =
      contextWindow ?? numberValue(totals.contextWindow) ?? usage.contextWindow;
    usage = {
      inputTokens: (usage.inputTokens ?? 0) + (numberValue(totals.inputTokens) ?? 0),
      outputTokens: (usage.outputTokens ?? 0) + (numberValue(totals.outputTokens) ?? 0),
      cacheReadTokens: (usage.cacheReadTokens ?? 0) + (numberValue(totals.cacheReadTokens) ?? 0),
      cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + (numberValue(totals.cacheWriteTokens) ?? 0),
      costUsd: (usage.costUsd ?? 0) + (numberValue(totals.costUsd) ?? 0),
      ...(latestCacheHitPercent !== undefined ? { latestCacheHitPercent } : {}),
      ...(latestContextTokens !== undefined ? { contextTokens: latestContextTokens } : {}),
      ...(latestContextTokenSource ? { contextTokenSource: latestContextTokenSource } : {}),
      ...(latestContextWindow !== undefined ? { contextWindow: latestContextWindow } : {}),
    };
  }
  if (contextWindow) usage = { ...usage, contextWindow };
  return usage;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function trimDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

export function formatCompactTokenCount(value: number | undefined): string | undefined {
  const count = nonNegativeFinite(value);
  if (count === undefined) return undefined;

  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "k" },
  ] as const;
  const unit = units.find((candidate) => count >= candidate.threshold);
  if (!unit) return String(Math.round(count));

  const scaled = count / unit.threshold;
  const fractionDigits = scaled < 10 ? 1 : scaled < 100 && !Number.isInteger(scaled) ? 1 : 0;
  return `${trimDecimal(scaled.toFixed(fractionDigits))}${unit.suffix}`;
}

export function formatSessionStatusPercent(value: number | undefined): string | undefined {
  const percent = nonNegativeFinite(value);
  if (percent === undefined) return undefined;
  return `${trimDecimal(Math.min(percent, 100).toFixed(1))}%`;
}

export function formatSessionCost(value: number | undefined): string | undefined {
  const cost = nonNegativeFinite(value);
  if (cost === undefined) return undefined;
  const fractionDigits = cost >= 1 ? 3 : cost >= 0.01 ? 4 : 5;
  return `$${trimDecimal(cost.toFixed(fractionDigits))}`;
}

export function formatContextUsage(
  contextTokens: number | undefined,
  contextWindow: number | undefined,
): string | undefined {
  const window = nonNegativeFinite(contextWindow);
  if (window === undefined || window === 0) return undefined;

  const compactWindow = formatCompactTokenCount(window);
  const used = nonNegativeFinite(contextTokens);
  if (used === undefined) return `—/${compactWindow}`;
  return `${formatSessionStatusPercent((used / window) * 100)}/${compactWindow}`;
}

function detail(label: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return `${label}: ${value}`;
}

export function describeSessionStatus(
  labels: SessionStatusBarLabels,
  status: SessionStatusSnapshot,
): string {
  const context = formatContextUsage(status.contextTokens, status.contextWindow);
  return [
    labels.bar,
    detail(labels.workingDirectory, status.cwd.trim()),
    detail(labels.branch, status.gitBranch?.trim()),
    detail(labels.inputTokens, nonNegativeFinite(status.inputTokens)),
    detail(labels.outputTokens, nonNegativeFinite(status.outputTokens)),
    detail(labels.cacheReadTokens, nonNegativeFinite(status.cacheReadTokens)),
    detail(labels.cacheWriteTokens, nonNegativeFinite(status.cacheWriteTokens)),
    detail(labels.cacheHit, formatSessionStatusPercent(status.latestCacheHitPercent)),
    detail(labels.cost, formatSessionCost(status.costUsd)),
    detail(labels.context, context),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}
