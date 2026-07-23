import type {
  FusionAnalysisV1,
  FusionConfidence,
  FusionContradictionPositionV1,
  FusionContradictionV1,
  FusionOpinionV1,
  FusionUniqueInsightV1,
} from "./types.ts";

const MAX_LEAF_OUTPUT_CHARS = 64_000;
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_CHARS = 16_000;

const OPINION_KEYS = [
  "version",
  "conclusion",
  "keyPoints",
  "evidenceRefs",
  "assumptions",
  "uncertainties",
] as const;

const ANALYSIS_KEYS = [
  "version",
  "consensus",
  "contradictions",
  "partialCoverage",
  "uniqueInsights",
  "blindSpots",
  "answerOutline",
  "confidence",
] as const;

/** Parse one strict Fusion panel object, optionally wrapped in one JSON fence. */
export function parseFusionOpinion(text: string): FusionOpinionV1 | undefined {
  const value = parseJsonObject(text);
  if (!value || !hasExactKeys(value, OPINION_KEYS) || value.version !== 1) return undefined;

  const conclusion = boundedNonEmptyString(value.conclusion);
  const keyPoints = stringArray(value.keyPoints);
  const evidenceRefs = stringArray(value.evidenceRefs);
  const assumptions = stringArray(value.assumptions);
  const uncertainties = stringArray(value.uncertainties);
  if (!conclusion || !keyPoints || !evidenceRefs || !assumptions || !uncertainties) {
    return undefined;
  }

  return {
    version: 1,
    conclusion,
    keyPoints,
    evidenceRefs,
    assumptions,
    uncertainties,
  };
}

/** Parse one strict Fusion judge object, optionally wrapped in one JSON fence. */
export function parseFusionAnalysis(text: string): FusionAnalysisV1 | undefined {
  const value = parseJsonObject(text);
  if (!value || !hasExactKeys(value, ANALYSIS_KEYS) || value.version !== 1) return undefined;

  const consensus = stringArray(value.consensus);
  const contradictions = contradictionArray(value.contradictions);
  const partialCoverage = stringArray(value.partialCoverage);
  const uniqueInsights = uniqueInsightArray(value.uniqueInsights);
  const blindSpots = stringArray(value.blindSpots);
  const answerOutline = stringArray(value.answerOutline);
  const confidence = fusionConfidence(value.confidence);
  if (
    !consensus ||
    !contradictions ||
    !partialCoverage ||
    !uniqueInsights ||
    !blindSpots ||
    !answerOutline ||
    !confidence
  ) {
    return undefined;
  }

  return {
    version: 1,
    consensus,
    contradictions,
    partialCoverage,
    uniqueInsights,
    blindSpots,
    answerOutline,
    confidence,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_LEAF_OUTPUT_CHARS) {
    return undefined;
  }
  const normalized = stripSingleJsonFence(text.trim());
  if (!normalized) return undefined;
  try {
    const value: unknown = JSON.parse(normalized);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stripSingleJsonFence(text: string): string | undefined {
  if (!text.startsWith("```")) return text;
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return match?.[1]?.trim();
}

function contradictionArray(value: unknown): FusionContradictionV1[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return undefined;
  const result: FusionContradictionV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["topic", "positions"])) return undefined;
    const topic = boundedNonEmptyString(entry.topic);
    const positions = contradictionPositionArray(entry.positions);
    if (!topic || !positions || positions.length < 2) return undefined;
    result.push({ topic, positions });
  }
  return result;
}

function contradictionPositionArray(value: unknown): FusionContradictionPositionV1[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return undefined;
  const result: FusionContradictionPositionV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["panelId", "claim"])) return undefined;
    const panelId = boundedNonEmptyString(entry.panelId);
    const claim = boundedNonEmptyString(entry.claim);
    if (!panelId || !claim) return undefined;
    result.push({ panelId, claim });
  }
  return result;
}

function uniqueInsightArray(value: unknown): FusionUniqueInsightV1[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return undefined;
  const result: FusionUniqueInsightV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["panelId", "insight"])) return undefined;
    const panelId = boundedNonEmptyString(entry.panelId);
    const insight = boundedNonEmptyString(entry.insight);
    if (!panelId || !insight) return undefined;
    result.push({ panelId, insight });
  }
  return result;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    const normalized = boundedNonEmptyString(entry);
    if (!normalized) return undefined;
    result.push(normalized);
  }
  return result;
}

function boundedNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_STRING_CHARS) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function fusionConfidence(value: unknown): FusionConfidence | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
