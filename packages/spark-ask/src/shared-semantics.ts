import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
} from "@zendev-lab/spark-core";
import {
  defaultSparkAskChoice,
  formatSparkAskAnswerForDisplay,
  hasRequiredSparkAskGateSelections,
  hasRequiredSparkAskSelections,
  hasSparkAskAnswerContent,
  hasSubmittedRequiredSparkAskAnswers,
  hasSubmittedRequiredSparkAskGateAnswers,
  inferSparkAskSubmitStatus,
  isSparkAskGateMode,
  nextActionForSparkAskSubmit,
  parseSparkAskChoice,
  requiresExplicitSparkAskGateSelection,
  type SparkAskAnswerValuesLike,
  type SparkAskOptionLike,
  type SparkAskQuestionType,
  type SparkAskRequestLike,
  type SparkGateQuestionLike,
  type SparkParsedAskChoice,
} from "@zendev-lab/spark-protocol";

import { SENTINEL_LABELS } from "./schema.ts";

export type AskQuestionTypeLike = SparkAskQuestionType;
export type AskOptionLike = SparkAskOptionLike;
export type ParsedAskChoice = SparkParsedAskChoice;
export type GateQuestionLike = SparkGateQuestionLike;
export type AskRequestLike = SparkAskRequestLike;
export type AnswerValuesLike = SparkAskAnswerValuesLike;

export interface SelectWithCustomResult {
  value?: string;
  customText?: string;
}

export interface SelectWithCustomUi {
  select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
  selectWithCustom?: (
    title: string,
    input: { options: string[]; customLabel: string },
  ) =>
    | Promise<SelectWithCustomResult | string | undefined>
    | SelectWithCustomResult
    | string
    | undefined;
  input?: (
    title: string,
    defaultValue?: string,
  ) => Promise<string | undefined> | string | undefined;
  interaction?: (
    request: ExtensionInteractionRequest,
  ) => Promise<ExtensionInteractionResponse> | ExtensionInteractionResponse;
}

export async function selectOptionWithCustom(
  ui: SelectWithCustomUi,
  title: string,
  options: readonly AskOptionLike[],
): Promise<SelectWithCustomResult | undefined> {
  const labels = options.map((option) => option.label);
  if (ui.selectWithCustom) {
    const selected = await ui.selectWithCustom(title, {
      options: labels,
      customLabel: SENTINEL_LABELS.other,
    });
    if (!selected) return undefined;
    if (typeof selected === "string") return { value: selected };
    return selected;
  }

  const selected = await ui.select?.(title, labels);
  if (!selected) return undefined;
  return { value: selected };
}

export const parseAskChoice = parseSparkAskChoice;
export const defaultAskChoice = defaultSparkAskChoice;
export const isGateMode = isSparkAskGateMode;
export const requiresExplicitSelectionForGate = requiresExplicitSparkAskGateSelection;
export const hasAskAnswerContent = hasSparkAskAnswerContent;
export const hasSubmittedRequiredGateAnswers = hasSubmittedRequiredSparkAskGateAnswers;
export const hasSubmittedRequiredAskAnswers = hasSubmittedRequiredSparkAskAnswers;
export const hasRequiredGateSelections = hasRequiredSparkAskGateSelections;
export const hasRequiredAskSelections = hasRequiredSparkAskSelections;
export const inferAskSubmitStatus = inferSparkAskSubmitStatus;
export const nextActionForAskSubmit = nextActionForSparkAskSubmit;
export const formatAskAnswerForDisplay = formatSparkAskAnswerForDisplay;
