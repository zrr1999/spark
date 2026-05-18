import type { ManagedAgentProposal } from "spark-core";
import {
  createElaborationResult,
  createPiAskFlowArtifactBody,
  createPiAskFlowRequest,
  isPiAskFlowArtifactBody,
  replayPiAskFlow,
  replayablePiAskFlow,
  runPiAskFlow,
  type PiAskFlowAnswerEntry,
  type PiAskFlowAnswerKind,
  type PiAskFlowArtifactBody,
  type PiAskFlowBehaviour,
  type PiAskFlowElaborationNote,
  type PiAskFlowOption,
  type PiAskFlowQuestion,
  type PiAskFlowQuestionTypeVal,
  type PiAskFlowRequest,
  type PiAskFlowResult,
  type PiAskFlowValidationError,
} from "pi-ask";

import { clarifyThreadCopy, detectCopyLanguage, type SparkCopyLanguage } from "./copy.ts";

export { clarifyThreadCopy, detectCopyLanguage } from "./copy.ts";
export {
  deliveryModeOptions,
  languageOptions,
  nextActionOptions,
  sparkFocusOptions,
} from "./copy.ts";
export type { SparkCopyLanguage, SparkThreadClarificationCopy } from "./copy.ts";

export type SparkAskFlow =
  | "clarify-thread"
  | "approve-managed-agent"
  | "resolve-task-blocker"
  | "review-gate"
  | "custom";

export function clarifyThreadAsk(input: {
  idea: string;
  title?: string;
  timeoutMs?: number;
  defaultLanguage?: SparkCopyLanguage;
}): PiAskFlowRequest {
  const copy = clarifyThreadCopy({
    language: input.defaultLanguage ?? detectCopyLanguage(input.idea),
  });
  return {
    flow: "clarify-thread",
    mode: "clarification",
    title: input.title ?? copy.title,
    context: input.idea,
    timeoutMs: input.timeoutMs,
    questions: copy.questions as PiAskFlowQuestion[],
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function approveManagedAgentAsk(input: {
  proposal: ManagedAgentProposal;
  timeoutMs?: number;
}): PiAskFlowRequest {
  return {
    flow: "approve-managed-agent",
    mode: "approval",
    title: `Approve managed agent: ${input.proposal.id}`,
    context: [
      input.proposal.description,
      input.proposal.rationale,
      `Expected uses: ${input.proposal.expectedUses.join(", ")}`,
    ].join("\n"),
    timeoutMs: input.timeoutMs,
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
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function resolveTaskBlockerAsk(input: {
  taskTitle: string;
  blocker: string;
  timeoutMs?: number;
}): PiAskFlowRequest {
  return {
    flow: "resolve-task-blocker",
    mode: "unblock",
    title: `Resolve blocker: ${input.taskTitle}`,
    context: input.blocker,
    timeoutMs: input.timeoutMs,
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
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function reviewGateAsk(input: {
  subject: string;
  summary: string;
  timeoutMs?: number;
}): PiAskFlowRequest {
  return {
    flow: "review-gate",
    mode: "decision",
    title: `Review gate: ${input.subject}`,
    context: input.summary,
    timeoutMs: input.timeoutMs,
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
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export const createSparkAskRequest = createPiAskFlowRequest;
export const runSparkAsk = runPiAskFlow;
export const replaySparkAsk = replayPiAskFlow;
export const replayableSparkAsk = replayablePiAskFlow;
export const createSparkAskArtifactBody = createPiAskFlowArtifactBody;
export const isSparkAskArtifactBody = isPiAskFlowArtifactBody;

export { createElaborationResult };

export type SparkAskBehaviour = PiAskFlowBehaviour;
export type SparkAskElaborationNote = PiAskFlowElaborationNote;
export type SparkAskArtifactBody = PiAskFlowArtifactBody;
export type SparkAskRequest = PiAskFlowRequest;
export type SparkAskResult = PiAskFlowResult;
export type SparkAskQuestion = PiAskFlowQuestion;
export type SparkAskAnswerEntry = PiAskFlowAnswerEntry;
export type SparkAskAnswerKind = PiAskFlowAnswerKind;
export type SparkAskOption = PiAskFlowOption;
export type SparkAskQuestionTypeVal = PiAskFlowQuestionTypeVal;
export type SparkAskValidationError = PiAskFlowValidationError;
