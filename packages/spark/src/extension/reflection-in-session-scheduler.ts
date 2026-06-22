import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  emptyReflectionScanCursor,
  loadReflectionScanCursor,
  reflectionScanCursorPath,
  saveReflectionScanCursor,
  scanPiSessionHistory,
  type ReflectionScanStats,
} from "./reflection-session-scanner.ts";
import {
  loadReflectionCandidateStore,
  reflectionCandidateStorePath,
  saveReflectionCandidateStore,
  upsertReflectionCandidates,
} from "./reflection-candidate-inbox.ts";
import {
  synthesizeReflection,
  type ReflectionSynthesisBudget,
} from "./reflection-synthesis-engine.ts";
import type { SparkCommandApi, SparkCommandContext } from "./spark-command-registration.ts";

export const REFLECTION_MIN_INTERVAL_MS = 30_000;

export interface ReflectionRunOptions {
  sessionRoot?: string;
  cursorPath?: string;
  candidateStorePath?: string;
  reportPath?: string;
  maxCandidates?: number;
  maxObservations?: number;
  maxThemes?: number;
  maxExcerptChars?: number;
  /** @internal Test hook used to prove the per-workspace run lock skips overlap. */
  testHookBeforeScan?: () => Promise<void>;
}

export interface ReflectionRunSummary {
  cursorPath: string;
  candidateStorePath: string;
  reportPath: string;
  scanStats: ReflectionScanStats;
  observations: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  candidatesStored: number;
  reportChars: number;
  skippedReason?: "already_running";
}

interface ReflectionTimerState {
  timer: ReturnType<typeof setInterval>;
  intervalMs: number;
  sessionRoot: string;
  startedAt: string;
}

const reflectionTimers = new Map<string, ReflectionTimerState>();
const activeReflectionRuns = new Set<string>();

export function registerSparkReflectionCommands(pi: SparkCommandApi): void {
  pi.registerCommand("reflect", {
    description:
      "Run or schedule safe session-local reflection. Usage: /reflect run|start|stop|status [--session-root PATH] [--interval-ms N]",
    async handler(args, ctx) {
      const parsed = parseReflectionCommandArgs(args);
      if (parsed.action === "stop") {
        const stopped = stopReflectionScheduler(ctx);
        sendReflectionNotice(
          pi,
          stopped ? "Reflection scheduler stopped." : "Reflection scheduler was not running.",
        );
        return;
      }
      if (parsed.action === "status") {
        const status = reflectionSchedulerStatus(ctx);
        sendReflectionNotice(
          pi,
          status.running
            ? `Reflection scheduler running every ${status.intervalMs}ms from ${status.sessionRoot}.`
            : "Reflection scheduler is not running.",
        );
        return;
      }
      if (parsed.action === "start") {
        const intervalMs = Math.max(parsed.intervalMs ?? 10 * 60_000, REFLECTION_MIN_INTERVAL_MS);
        startReflectionScheduler(pi, ctx, { ...parsed.options, intervalMs });
        sendReflectionNotice(
          pi,
          `Reflection scheduler started every ${intervalMs}ms. It is session-local and stops on session shutdown.`,
        );
        return;
      }
      const summary = await runReflectionOnce(ctx, parsed.options);
      sendReflectionReport(pi, summary);
    },
  });

  for (const eventName of [
    "session_shutdown",
    "session_reload",
    "session_new",
    "session_resume",
    "session_fork",
    "quit",
  ]) {
    pi.on?.(eventName, (_event, ctx) => {
      stopReflectionScheduler(ctx as SparkCommandContext);
    });
  }
}

export async function runReflectionOnce(
  ctx: Pick<SparkCommandContext, "cwd">,
  options: ReflectionRunOptions = {},
): Promise<ReflectionRunSummary> {
  const cursorPath = options.cursorPath ?? reflectionScanCursorPath(ctx.cwd);
  const candidateStorePath = options.candidateStorePath ?? reflectionCandidateStorePath(ctx.cwd);
  const reportPath =
    options.reportPath ?? join(ctx.cwd, ".spark", "reflections", "latest-report.md");
  const sessionRoot = options.sessionRoot ?? join(homedir(), ".pi", "agent", "sessions");
  const key = reflectionSessionKey(ctx);
  if (activeReflectionRuns.has(key)) {
    return skippedReflectionRunSummary({ cursorPath, candidateStorePath, reportPath });
  }
  activeReflectionRuns.add(key);
  try {
    await options.testHookBeforeScan?.();
    const cursor = await loadReflectionScanCursor(cursorPath).catch(() =>
      emptyReflectionScanCursor(),
    );
    const scan = await scanPiSessionHistory({ sessionRoot, cursor });
    await saveReflectionScanCursor(cursorPath, scan.cursor);

    const candidateStore = await loadReflectionCandidateStore(candidateStorePath);
    const upsert = upsertReflectionCandidates(candidateStore, scan.observations, {
      maxCandidates: options.maxCandidates ?? 200,
    });
    await saveReflectionCandidateStore(candidateStorePath, upsert.store);

    const budget: Partial<ReflectionSynthesisBudget> = {
      maxCandidates: options.maxCandidates,
      maxObservations: options.maxObservations,
      maxThemes: options.maxThemes,
      maxExcerptChars: options.maxExcerptChars,
    };
    const synthesis = synthesizeReflection({ scan, candidateStore: upsert.store, budget });
    await writeAtomicText(reportPath, `${synthesis.report}\n`);

    return {
      cursorPath,
      candidateStorePath,
      reportPath,
      scanStats: scan.stats,
      observations: scan.observations.length,
      candidatesCreated: upsert.created.length,
      candidatesUpdated: upsert.updated.length,
      candidatesStored: upsert.store.candidates.length,
      reportChars: synthesis.report.length,
    };
  } finally {
    activeReflectionRuns.delete(key);
  }
}

export function startReflectionScheduler(
  pi: SparkCommandApi,
  ctx: SparkCommandContext,
  options: ReflectionRunOptions & { intervalMs: number },
): void {
  stopReflectionScheduler(ctx);
  const intervalMs = Math.max(options.intervalMs, REFLECTION_MIN_INTERVAL_MS);
  const sessionRoot = options.sessionRoot ?? join(homedir(), ".pi", "agent", "sessions");
  const timer = setInterval(() => {
    void runReflectionOnce(ctx, { ...options, sessionRoot })
      .then((summary) => sendReflectionReport(pi, summary))
      .catch((error: unknown) =>
        sendReflectionNotice(
          pi,
          `Reflection run failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }, intervalMs);
  reflectionTimers.set(reflectionSessionKey(ctx), {
    timer,
    intervalMs,
    sessionRoot,
    startedAt: new Date().toISOString(),
  });
}

export function stopReflectionScheduler(ctx: Pick<SparkCommandContext, "cwd">): boolean {
  const key = reflectionSessionKey(ctx);
  const existing = reflectionTimers.get(key);
  if (!existing) return false;
  clearInterval(existing.timer);
  reflectionTimers.delete(key);
  return true;
}

export function reflectionSchedulerStatus(
  ctx: Pick<SparkCommandContext, "cwd">,
):
  | { running: false }
  | { running: true; intervalMs: number; sessionRoot: string; startedAt: string } {
  const existing = reflectionTimers.get(reflectionSessionKey(ctx));
  if (!existing) return { running: false };
  return {
    running: true,
    intervalMs: existing.intervalMs,
    sessionRoot: existing.sessionRoot,
    startedAt: existing.startedAt,
  };
}

function parseReflectionCommandArgs(args: string): {
  action: "run" | "start" | "stop" | "status";
  intervalMs?: number;
  options: ReflectionRunOptions;
} {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const actionToken = tokens[0];
  const action =
    actionToken === "start" ||
    actionToken === "stop" ||
    actionToken === "status" ||
    actionToken === "run" ||
    actionToken === "once"
      ? actionToken === "once"
        ? "run"
        : actionToken
      : "run";
  const rest =
    actionToken && action !== "run"
      ? tokens.slice(1)
      : actionToken === "run" || actionToken === "once"
        ? tokens.slice(1)
        : tokens;
  const options: ReflectionRunOptions = {};
  let intervalMs: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];
    if (!next) continue;
    if (token === "--session-root") options.sessionRoot = next;
    if (token === "--cursor-path") options.cursorPath = next;
    if (token === "--candidate-store") options.candidateStorePath = next;
    if (token === "--report-path") options.reportPath = next;
    if (token === "--interval-ms") intervalMs = positiveInteger(next);
    if (token === "--max-candidates") options.maxCandidates = positiveInteger(next);
    if (token === "--max-observations") options.maxObservations = positiveInteger(next);
    if (token === "--max-themes") options.maxThemes = positiveInteger(next);
    if (token === "--max-excerpt-chars") options.maxExcerptChars = positiveInteger(next);
    index += 1;
  }
  return { action, intervalMs, options };
}

function skippedReflectionRunSummary(paths: {
  cursorPath: string;
  candidateStorePath: string;
  reportPath: string;
}): ReflectionRunSummary {
  return {
    ...paths,
    scanStats: {
      filesSeen: 0,
      filesAdvanced: 0,
      linesSeen: 0,
      linesScanned: 0,
      entriesScanned: 0,
      userMessages: 0,
      customMessages: 0,
      summaryHints: 0,
      parseErrors: 0,
    },
    observations: 0,
    candidatesCreated: 0,
    candidatesUpdated: 0,
    candidatesStored: 0,
    reportChars: 0,
    skippedReason: "already_running",
  };
}

function sendReflectionReport(pi: SparkCommandApi, summary: ReflectionRunSummary): void {
  pi.sendMessage({
    customType: "spark-reflection-report",
    display: true,
    content: [
      "# Reflection run complete",
      "",
      summary.skippedReason ? `- skipped: ${summary.skippedReason}` : undefined,
      `- observations scanned: ${summary.observations}`,
      `- candidates created: ${summary.candidatesCreated}`,
      `- candidates updated: ${summary.candidatesUpdated}`,
      `- candidates stored: ${summary.candidatesStored}`,
      `- parse errors: ${summary.scanStats.parseErrors}`,
      `- cursor: ${summary.cursorPath}`,
      `- candidate store: ${summary.candidateStorePath}`,
      `- report: ${summary.reportPath}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    details: { ...summary },
  });
}

function sendReflectionNotice(pi: SparkCommandApi, content: string): void {
  pi.sendMessage({ customType: "spark-reflection-notice", display: true, content });
}

async function writeAtomicText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function reflectionSessionKey(ctx: Pick<SparkCommandContext, "cwd">): string {
  return ctx.cwd;
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
