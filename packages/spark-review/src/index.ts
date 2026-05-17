import {
  type AgentRef,
  type Artifact,
  type ArtifactRef,
  type GatePolicy,
  type ReviewGate,
  type ReviewOutcome,
  type ReviewRef,
  type TaskRef,
  newRef,
  nowIso,
} from "spark-core";

export interface CreateReviewGateInput {
  subject: TaskRef | ArtifactRef | AgentRef;
  lens: ReviewGate["lens"];
  outcome: ReviewOutcome;
  summary: string;
  policy?: GatePolicy;
  artifactRef?: ArtifactRef;
  ref?: ReviewRef;
}

export interface ReviewArtifactBody {
  subject: string;
  lens: ReviewGate["lens"];
  outcome: ReviewOutcome;
  summary: string;
  findings: string[];
}

export function createReviewGate(input: CreateReviewGateInput): ReviewGate {
  if (!input.summary.trim()) throw new Error("review summary is required");
  return {
    ref: input.ref ?? newRef("review"),
    subject: input.subject,
    lens: input.lens,
    policy: input.policy ?? "required",
    outcome: input.outcome,
    summary: input.summary,
    artifactRef: input.artifactRef,
    createdAt: nowIso(),
  };
}

export function createReviewArtifactBody(input: {
  subject: TaskRef | ArtifactRef | AgentRef;
  lens: ReviewGate["lens"];
  outcome: ReviewOutcome;
  summary: string;
  findings?: string[];
}): ReviewArtifactBody {
  return {
    subject: input.subject,
    lens: input.lens,
    outcome: input.outcome,
    summary: input.summary,
    findings: input.findings ?? [],
  };
}

export function isPassingReview(gate: ReviewGate): boolean {
  return gate.outcome === "approved" || (gate.policy === "advisory" && gate.outcome !== "blocked");
}

export function isBlockingReview(gate: ReviewGate): boolean {
  if (gate.policy === "advisory") return false;
  if (gate.policy === "blocking") return gate.outcome !== "approved";
  return gate.outcome === "needs_changes" || gate.outcome === "blocked";
}

export function normalizeReviewOutcome(value: string): ReviewOutcome {
  if (value === "approved" || value === "needs_changes" || value === "blocked") return value;
  throw new Error(`invalid review outcome: ${value}`);
}

export function summarizeReviewArtifact(artifact: Artifact): ReviewArtifactBody | null {
  if (artifact.kind !== "review" || artifact.format !== "json") return null;
  return artifact.body as unknown as ReviewArtifactBody;
}
