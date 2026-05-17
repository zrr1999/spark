import {
  askUser,
  createAskUserRequest,
  type PiAskQuestion,
  type PiAskRequest,
  type PiAskResult,
  type PiAskUi,
} from "pi-ask";
import type { ManagedAgentProposal } from "spark-core";

import { clarifyThreadCopy, detectCopyLanguage, type SparkCopyLanguage } from "./copy.ts";

export { clarifyThreadCopy, detectCopyLanguage } from "./copy.ts";
export type { SparkCopyLanguage } from "./copy.ts";

export type SparkAskFlow =
  | "clarify-thread"
  | "approve-managed-agent"
  | "resolve-task-blocker"
  | "review-gate"
  | "custom";

export interface SparkAskBehaviour {
  allowElaborate?: boolean;
  allowReplay?: boolean;
  preservePriorAnswers?: boolean;
}

export interface SparkAskRequest {
  title?: string;
  flow: SparkAskFlow;
  context?: string;
  questions: PiAskQuestion[];
  behaviour?: SparkAskBehaviour;
  timeoutMs?: number;
}

export interface SparkAskElaborationNote {
  questionId: string;
  note: string;
}

export interface SparkAskResult {
  cancelled: boolean;
  mode: "submit" | "elaborate" | "cancel";
  answers: PiAskResult["answers"];
  flow: SparkAskFlow;
  base: PiAskResult;
  elaboration?: {
    affectedQuestionIds: string[];
    preservedAnswers: PiAskResult["answers"];
    notes: SparkAskElaborationNote[];
  };
  nextAction?: "resume" | "clarify_then_reask" | "block";
}

export interface SparkAskArtifactBody {
  request: SparkAskRequest;
  result: SparkAskResult;
}

export function createSparkAskRequest(input: SparkAskRequest): SparkAskRequest {
  createAskUserRequest(toPiAskRequest(input));
  return input;
}

export async function runSparkAsk(input: SparkAskRequest, ui?: PiAskUi): Promise<SparkAskResult> {
  const request = createSparkAskRequest(input);
  const base = await askUser(toPiAskRequest(request), ui);
  return {
    cancelled: base.cancelled,
    mode: base.cancelled ? "cancel" : "submit",
    answers: base.answers,
    flow: request.flow,
    base,
    nextAction: base.cancelled ? "block" : "resume",
  };
}

export async function replaySparkAsk(
  input: SparkAskRequest,
  prior: SparkAskResult | undefined,
  ui?: PiAskUi,
): Promise<SparkAskResult> {
  return runSparkAsk(replayableSparkAsk(input, prior), ui);
}

export function replayableSparkAsk(
  input: SparkAskRequest,
  prior?: SparkAskResult,
): SparkAskRequest {
  if (!prior?.answers || !input.behaviour?.preservePriorAnswers) return input;
  const questions = input.questions.map((question) => {
    const existing = prior.answers[question.id];
    if (!existing || question.type === "freeform") return question;
    const options = question.options?.map((option) => ({
      ...option,
      description: existing.values.includes(option.value)
        ? `${option.description ?? ""}${option.description ? "\n" : ""}Previously selected.`
        : option.description,
    }));
    return { ...question, options };
  });
  return { ...input, questions };
}

export function createSparkAskArtifactBody(
  request: SparkAskRequest,
  result: SparkAskResult,
): SparkAskArtifactBody {
  return { request, result };
}

export function isSparkAskArtifactBody(value: unknown): value is SparkAskArtifactBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object",
  );
}

export function createElaborationResult(
  prior: SparkAskResult,
  notes: SparkAskElaborationNote[],
): SparkAskResult {
  return {
    ...prior,
    mode: "elaborate",
    elaboration: {
      affectedQuestionIds: notes.map((note) => note.questionId),
      preservedAnswers: prior.answers,
      notes,
    },
    nextAction: "clarify_then_reask",
  };
}

export function clarifyThreadAsk(input: {
  idea: string;
  title?: string;
  timeoutMs?: number;
  defaultLanguage?: SparkCopyLanguage;
}): SparkAskRequest {
  const copy = clarifyThreadCopy({
    language: input.defaultLanguage ?? detectCopyLanguage(input.idea),
  });
  return createSparkAskRequest({
    flow: "clarify-thread",
    title: input.title ?? copy.title,
    context: input.idea,
    timeoutMs: input.timeoutMs,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
    },
    questions: copy.questions,
  });
}

export function approveManagedAgentAsk(input: {
  proposal: ManagedAgentProposal;
  timeoutMs?: number;
}): SparkAskRequest {
  return createSparkAskRequest({
    flow: "approve-managed-agent",
    title: `Approve managed agent: ${input.proposal.id}`,
    context: [
      input.proposal.description,
      input.proposal.rationale,
      `Expected uses: ${input.proposal.expectedUses.join(", ")}`,
    ].join("\n"),
    timeoutMs: input.timeoutMs,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
    },
    questions: [
      {
        id: "approval",
        prompt: `Create managed agent ${input.proposal.id}?`,
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        id: "note",
        prompt: "Any note for the agent proposal?",
        type: "freeform",
      },
    ],
  });
}

export function resolveTaskBlockerAsk(input: {
  taskTitle: string;
  blocker: string;
  timeoutMs?: number;
}): SparkAskRequest {
  return createSparkAskRequest({
    flow: "resolve-task-blocker",
    title: `Resolve blocker: ${input.taskTitle}`,
    context: input.blocker,
    timeoutMs: input.timeoutMs,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
    },
    questions: [
      {
        id: "decision",
        prompt: `How should Spark proceed for ${input.taskTitle}?`,
        type: "single",
        required: true,
        options: [
          { value: "resume", label: "Resume with chosen direction" },
          { value: "block", label: "Keep blocked" },
          { value: "replan", label: "Replan this task" },
        ],
      },
      {
        id: "explanation",
        prompt: "Any extra context for the unblock decision?",
        type: "freeform",
      },
    ],
  });
}

export function reviewGateAsk(input: {
  subject: string;
  summary: string;
  timeoutMs?: number;
}): SparkAskRequest {
  return createSparkAskRequest({
    flow: "review-gate",
    title: `Review gate: ${input.subject}`,
    context: input.summary,
    timeoutMs: input.timeoutMs,
    behaviour: {
      allowElaborate: true,
      allowReplay: true,
      preservePriorAnswers: true,
    },
    questions: [
      {
        id: "gate",
        prompt: `What should happen for ${input.subject}?`,
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "needs_changes", label: "Needs changes" },
          { value: "block", label: "Block" },
        ],
      },
      {
        id: "reason",
        prompt: "Why?",
        type: "freeform",
        required: true,
      },
    ],
  });
}

export function toPiAskRequest(input: SparkAskRequest): PiAskRequest {
  return {
    title: input.title,
    context: input.context,
    timeoutMs: input.timeoutMs,
    questions: input.questions,
    mode: modeForFlow(input.flow),
  };
}

function modeForFlow(flow: SparkAskFlow): PiAskRequest["mode"] {
  switch (flow) {
    case "approve-managed-agent":
      return "approval";
    case "resolve-task-blocker":
      return "unblock";
    case "review-gate":
      return "decision";
    default:
      return "clarification";
  }
}
