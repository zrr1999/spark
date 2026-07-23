import type { LeafCapabilityRunner, LeafDegradeReason } from "@zendev-lab/spark-core";

export const SPARK_FUSION_SCHEMA_VERSION = 1 as const;

export type FusionConfidence = "low" | "medium" | "high";

export interface FusionOpinionV1 {
  version: 1;
  conclusion: string;
  keyPoints: string[];
  evidenceRefs: string[];
  assumptions: string[];
  uncertainties: string[];
}

export interface FusionContradictionPositionV1 {
  panelId: string;
  claim: string;
}

export interface FusionContradictionV1 {
  topic: string;
  positions: FusionContradictionPositionV1[];
}

export interface FusionUniqueInsightV1 {
  panelId: string;
  insight: string;
}

export interface FusionAnalysisV1 {
  version: 1;
  consensus: string[];
  contradictions: FusionContradictionV1[];
  partialCoverage: string[];
  uniqueInsights: FusionUniqueInsightV1[];
  blindSpots: string[];
  answerOutline: string[];
  confidence: FusionConfidence;
}

export interface FusionPanelInput {
  id?: string;
  perspective: string;
  model?: string;
}

export interface SparkFusionDeliberationRequest {
  question: string;
  context?: string;
  panels?: FusionPanelInput[];
  judgeModel?: string;
  sessionModel?: string;
  panelMaxTokens?: number;
  judgeMaxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FusionPanelReasonCode =
  | LeafDegradeReason
  | "empty-output"
  | "invalid-output"
  | "timeout";

export interface FusionPanelResult {
  id: string;
  model?: string;
  status: "succeeded" | "degraded" | "invalid";
  opinion?: FusionOpinionV1;
  reasonCode?: FusionPanelReasonCode;
  durationMs: number;
}

export interface FusionJudgeResult {
  model?: string;
  analysis: FusionAnalysisV1;
  durationMs: number;
}

export type FusionJudgeFailureReasonCode =
  | LeafDegradeReason
  | "empty-output"
  | "invalid-output"
  | "timeout";

export interface FusionJudgeFailure {
  model?: string;
  reasonCode: FusionJudgeFailureReasonCode;
  durationMs: number;
}

export type FusionFailureCode =
  | "insufficient-panels"
  | "panel-degraded"
  | "judge-degraded"
  | "judge-output-invalid";

export interface SparkFusionDeliberationResult {
  version: 1;
  status: "complete" | "partial" | "failed";
  panels: FusionPanelResult[];
  judge?: FusionJudgeResult;
  judgeFailure?: FusionJudgeFailure;
  failureCode?: FusionFailureCode;
}

export interface SparkFusionDependencies {
  runLeaf: LeafCapabilityRunner;
  now?: () => number;
}
