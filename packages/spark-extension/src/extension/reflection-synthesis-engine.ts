import type {
  ReflectionCandidate,
  ReflectionCandidateStore,
} from "./reflection-candidate-inbox.ts";
import {
  listReflectionCandidates,
  renderReflectionCandidateReport,
} from "./reflection-candidate-inbox.ts";
import type { ReflectionObservation, ReflectionScanResult } from "./reflection-session-scanner.ts";

export interface ReflectionSynthesisBudget {
  maxSessions: number;
  maxObservations: number;
  maxCandidates: number;
  maxExcerptChars: number;
  maxThemes: number;
}

export interface ReflectionSynthesisTheme {
  key: string;
  observationCount: number;
  candidateCount: number;
  signals: string[];
  sampleSources: string[];
}

export interface ReflectionSynthesisResult {
  generatedAt: string;
  digest: {
    sessions: number;
    observationsConsidered: number;
    candidatesConsidered: number;
    parseErrors: number;
  };
  themes: ReflectionSynthesisTheme[];
  suspectedUnfinished: ReflectionCandidate[];
  staleFollowups: ReflectionCandidate[];
  report: string;
}

export interface ReflectionSynthesisInput {
  scan: ReflectionScanResult;
  candidateStore: ReflectionCandidateStore;
  budget?: Partial<ReflectionSynthesisBudget>;
  now?: string;
}

const DEFAULT_SYNTHESIS_BUDGET: ReflectionSynthesisBudget = {
  maxSessions: 200,
  maxObservations: 1_000,
  maxCandidates: 25,
  maxExcerptChars: 500,
  maxThemes: 12,
};

export function synthesizeReflection(input: ReflectionSynthesisInput): ReflectionSynthesisResult {
  const now = input.now ?? new Date().toISOString();
  const budget = { ...DEFAULT_SYNTHESIS_BUDGET, ...input.budget };
  const observations = input.scan.observations.slice(0, budget.maxObservations);
  const candidates = listReflectionCandidates(input.candidateStore).slice(0, budget.maxCandidates);
  const sessions = new Set(
    observations
      .map((observation) => observation.source.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const themes = buildThemes(observations, candidates, budget);
  const staleFollowups = candidates
    .filter(
      (candidate) => candidate.signals.includes("todo_like") || candidate.confidence === "low",
    )
    .slice(0, Math.max(3, Math.floor(budget.maxCandidates / 3)));
  const suspectedUnfinished = candidates.slice(0, budget.maxCandidates);
  const result: Omit<ReflectionSynthesisResult, "report"> = {
    generatedAt: now,
    digest: {
      sessions: Math.min(sessions.size, budget.maxSessions),
      observationsConsidered: observations.length,
      candidatesConsidered: candidates.length,
      parseErrors: input.scan.stats.parseErrors,
    },
    themes,
    suspectedUnfinished,
    staleFollowups,
  };
  return { ...result, report: renderReflectionSynthesisReport(result, budget) };
}

export function sanitizeUntrustedEvidence(text: string, maxChars = 500): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  const bounded =
    compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trimEnd()}…`;
  return bounded
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(
      /ignore (all )?(previous|above|prior) instructions/giu,
      "[quoted instruction-injection phrase]",
    )
    .replace(/system prompt/giu, "[quoted system-prompt phrase]");
}

export function renderUntrustedEvidenceBlock(text: string, maxChars?: number): string {
  return [
    "<untrusted_evidence>",
    sanitizeUntrustedEvidence(text, maxChars),
    "</untrusted_evidence>",
  ].join("\n");
}

function buildThemes(
  observations: readonly ReflectionObservation[],
  candidates: readonly ReflectionCandidate[],
  budget: ReflectionSynthesisBudget,
): ReflectionSynthesisTheme[] {
  const byKey = new Map<string, ReflectionSynthesisTheme>();
  for (const observation of observations) {
    const key = themeKey(observation.source.cwd);
    const theme = ensureTheme(byKey, key);
    theme.observationCount += 1;
    for (const signal of observation.signals)
      if (!theme.signals.includes(signal)) theme.signals.push(signal);
    addSampleSource(theme, `${observation.source.file}:${observation.source.line}`);
  }
  for (const candidate of candidates) {
    const key = themeKey(candidate.sourceRefs[0]?.cwd);
    const theme = ensureTheme(byKey, key);
    theme.candidateCount += 1;
    for (const signal of candidate.signals)
      if (!theme.signals.includes(signal)) theme.signals.push(signal);
    addSampleSource(
      theme,
      candidate.sourceRefs[0]
        ? `${candidate.sourceRefs[0].file}:${candidate.sourceRefs[0].line}`
        : candidate.id,
    );
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        right.candidateCount - left.candidateCount ||
        right.observationCount - left.observationCount ||
        left.key.localeCompare(right.key),
    )
    .slice(0, budget.maxThemes);
}

function renderReflectionSynthesisReport(
  result: Omit<ReflectionSynthesisResult, "report">,
  budget: ReflectionSynthesisBudget,
): string {
  const lines = [
    "# Reflection synthesis report",
    "",
    "This report is deterministic and report-only. Historical prompts are quoted as untrusted evidence, never instructions.",
    "",
    "## Digest",
    "",
    `- generatedAt: ${result.generatedAt}`,
    `- sessions considered: ${result.digest.sessions}`,
    `- observations considered: ${result.digest.observationsConsidered}`,
    `- candidates considered: ${result.digest.candidatesConsidered}`,
    `- parse errors: ${result.digest.parseErrors}`,
    `- budget: maxObservations=${budget.maxObservations}, maxCandidates=${budget.maxCandidates}, maxExcerptChars=${budget.maxExcerptChars}`,
    "",
    "## Themes",
  ];
  if (result.themes.length === 0) lines.push("", "No themes found.");
  for (const theme of result.themes) {
    lines.push(
      "",
      `### ${theme.key}`,
      `- observations: ${theme.observationCount}`,
      `- candidates: ${theme.candidateCount}`,
      `- signals: ${theme.signals.join(", ") || "none"}`,
      `- sample sources: ${theme.sampleSources.join("; ") || "none"}`,
    );
  }
  lines.push("", "## Suspected unfinished work");
  if (result.suspectedUnfinished.length === 0)
    lines.push("", "No suspected unfinished work candidates.");
  for (const candidate of result.suspectedUnfinished) {
    lines.push(
      "",
      `### ${candidate.title}`,
      `- id: ${candidate.id}`,
      `- confidence: ${candidate.confidence}`,
      `- reason: ${candidate.reason}`,
      `- suggested next action: ${candidate.suggestedNextAction}`,
      renderUntrustedEvidenceBlock(candidate.excerpt, budget.maxExcerptChars),
    );
  }
  lines.push("", "## Stale follow-ups");
  if (result.staleFollowups.length === 0)
    lines.push("", "No stale follow-up candidates within the current budget.");
  for (const candidate of result.staleFollowups)
    lines.push(
      "",
      `- ${candidate.id} (${candidate.confidence}): ${sanitizeUntrustedEvidence(candidate.title, 160)}`,
    );
  lines.push(
    "",
    "## Candidate inbox preview",
    "",
    renderReflectionCandidateReport(
      { version: 1, updatedAt: result.generatedAt, candidates: result.suspectedUnfinished },
      { status: "all", limit: Math.min(10, budget.maxCandidates) },
    ),
  );
  return lines.join("\n");
}

function ensureTheme(
  map: Map<string, ReflectionSynthesisTheme>,
  key: string,
): ReflectionSynthesisTheme {
  const existing = map.get(key);
  if (existing) return existing;
  const theme: ReflectionSynthesisTheme = {
    key,
    observationCount: 0,
    candidateCount: 0,
    signals: [],
    sampleSources: [],
  };
  map.set(key, theme);
  return theme;
}

function addSampleSource(theme: ReflectionSynthesisTheme, source: string): void {
  if (theme.sampleSources.length >= 3 || theme.sampleSources.includes(source)) return;
  theme.sampleSources.push(source);
}

function themeKey(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}
