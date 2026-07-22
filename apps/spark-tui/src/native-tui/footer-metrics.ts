/** Footer metrics helpers for the native TUI. */

import type { SparkRunView } from "@zendev-lab/spark-protocol";

import { isRecord, numberFromRecord } from "./message-view.ts";
import type { SparkNativeFooterMetrics } from "./types.ts";

export function runTimeMs(run: SparkRunView): number {
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : NaN;
  if (Number.isFinite(completedAt)) return completedAt;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return startedAt;
  return 0;
}
export function footerMetricsFromRun(run: SparkRunView): SparkNativeFooterMetrics {
  const fromMetadata = footerMetricsFromRecord(run.metadata);
  const fromUsageTotals = footerMetricsFromRecord(
    isRecord(run.metadata.usageTotals) ? run.metadata.usageTotals : {},
  );
  const fromSummary = footerMetricsFromSummary(run.summary);
  return mergeFooterMetrics(mergeFooterMetrics(fromSummary, fromMetadata), fromUsageTotals);
}

export function footerMetricsFromRecord(record: Record<string, unknown>): SparkNativeFooterMetrics {
  return {
    inputTokens: numberFromRecord(record, "inputTokens") ?? numberFromRecord(record, "input"),
    outputTokens: numberFromRecord(record, "outputTokens") ?? numberFromRecord(record, "output"),
    cacheRead:
      numberFromRecord(record, "cacheRead") ??
      numberFromRecord(record, "cacheReadTokens") ??
      numberFromRecord(record, "promptCacheReadTokens"),
    cacheWrite:
      numberFromRecord(record, "cacheWrite") ??
      numberFromRecord(record, "cacheWriteTokens") ??
      numberFromRecord(record, "promptCacheWriteTokens"),
    costUsd:
      numberFromRecord(record, "costUsd") ??
      numberFromRecord(record, "cost") ??
      numberFromRecord(record, "costTotal"),
    latestCacheHitPercent:
      numberFromRecord(record, "latestCacheHitPercent") ??
      numberFromRecord(record, "cacheHitPercent"),
    contextTokens:
      numberFromRecord(record, "contextTokens") ?? numberFromRecord(record, "totalTokens"),
    contextWindow: numberFromRecord(record, "contextWindow"),
  };
}

export function footerMetricsFromSummary(summary: string | undefined): SparkNativeFooterMetrics {
  if (!summary) return {};
  const cache = /\bcache\s+read=(\d+(?:\.\d+)?)\s+write=(\d+(?:\.\d+)?)/iu.exec(summary);
  const cost = /\bcost=\$?(\d+(?:\.\d+)?)/iu.exec(summary);
  const tokens = /\b(?:tokens|totalTokens)=(\d+(?:\.\d+)?)/iu.exec(summary);
  return {
    ...(cache ? { cacheRead: Number(cache[1]), cacheWrite: Number(cache[2]) } : {}),
    ...(cost ? { costUsd: Number(cost[1]) } : {}),
    ...(tokens ? { contextTokens: Number(tokens[1]) } : {}),
  };
}

export function mergeFooterMetrics(
  current: SparkNativeFooterMetrics,
  next: SparkNativeFooterMetrics,
): SparkNativeFooterMetrics {
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    cacheRead: next.cacheRead ?? current.cacheRead,
    cacheWrite: next.cacheWrite ?? current.cacheWrite,
    costUsd: next.costUsd ?? current.costUsd,
    latestCacheHitPercent: next.latestCacheHitPercent ?? current.latestCacheHitPercent,
    contextTokens: next.contextTokens ?? current.contextTokens,
    contextWindow: next.contextWindow ?? current.contextWindow,
  };
}

export function addFooterMetrics(
  current: SparkNativeFooterMetrics,
  next: SparkNativeFooterMetrics,
): SparkNativeFooterMetrics {
  return {
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cacheRead: (current.cacheRead ?? 0) + (next.cacheRead ?? 0),
    cacheWrite: (current.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    costUsd: (current.costUsd ?? 0) + (next.costUsd ?? 0),
    latestCacheHitPercent: next.latestCacheHitPercent ?? current.latestCacheHitPercent,
    contextTokens: next.contextTokens ?? current.contextTokens,
    contextWindow: next.contextWindow ?? current.contextWindow,
  };
}

export function formatFooterMetrics(
  metrics: SparkNativeFooterMetrics,
  autoCompactionEnabled: boolean,
): string | undefined {
  const hasMetric = Object.values(metrics).some((value) => value !== undefined);
  if (!hasMetric) return undefined;
  const parts: string[] = [];
  if (metrics.inputTokens) parts.push(`↑${formatFooterTokens(metrics.inputTokens)}`);
  if (metrics.outputTokens) parts.push(`↓${formatFooterTokens(metrics.outputTokens)}`);
  if (metrics.cacheRead) parts.push(`R${formatFooterTokens(metrics.cacheRead)}`);
  if (metrics.cacheWrite) parts.push(`W${formatFooterTokens(metrics.cacheWrite)}`);
  if (metrics.latestCacheHitPercent !== undefined) {
    parts.push(`CH${metrics.latestCacheHitPercent.toFixed(1)}%`);
  }
  if (metrics.costUsd) parts.push(`$${metrics.costUsd.toFixed(3)}`);
  if (metrics.contextWindow) {
    const contextPercent =
      metrics.contextTokens !== undefined
        ? `${((metrics.contextTokens / metrics.contextWindow) * 100).toFixed(1)}%`
        : "?";
    const autoIndicator = autoCompactionEnabled ? " (auto)" : "";
    parts.push(`${contextPercent}/${formatFooterTokens(metrics.contextWindow)}${autoIndicator}`);
  }
  return parts.join(" ") || undefined;
}

export function formatFooterTokens(count: number): string {
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
