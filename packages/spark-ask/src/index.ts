import {
  createElaborationResult,
  createPiAskFlowArtifactBody,
  createAskArtifactBody,
  summarizeAskResult,
  createPiAskFlowRequest,
  createPiAskFlowResult,
  isPiAskFlowArtifactBody,
  isPiAskFlowGateBlocked,
  normalizePiAskFlowResult,
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

export { detectCopyLanguage } from "./copy.ts";
export {
  createSparkAskToolRequest,
  MIN_SPARK_ASK_OPTION_DESCRIPTION_LENGTH,
  replaySparkAskTool,
  runSparkAskTool,
} from "./tool.ts";
export type { SparkCopyLanguage } from "./copy.ts";
export type {
  SparkAskToolOptionParams,
  SparkAskToolParams,
  SparkAskToolQuestionParams,
  SparkAskToolUi,
} from "./tool.ts";

export type SparkAskFlow = string;

export const createSparkAskRequest = createPiAskFlowRequest;
export const runSparkAsk = runPiAskFlow;
export const replaySparkAsk = replayPiAskFlow;
export const replayableSparkAsk = replayablePiAskFlow;
export const createSparkAskResult = createPiAskFlowResult;
export const normalizeSparkAskResult = normalizePiAskFlowResult;
export const isSparkAskGateBlocked = isPiAskFlowGateBlocked;
export const createSparkAskArtifactBody = createPiAskFlowArtifactBody;
export const createSparkAskToolArtifactBody = createAskArtifactBody;
export const summarizeSparkAskResult = summarizeAskResult;
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
