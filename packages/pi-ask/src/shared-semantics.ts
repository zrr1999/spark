import { SENTINEL_LABELS } from "./schema.ts";

export type AskQuestionTypeLike = "single" | "multi" | "preview" | "freeform" | undefined;

export interface AskOptionLike {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

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
}

export interface ParsedAskChoice {
  kind: "option" | "multi" | "custom";
  values: string[];
  labels: string[];
  customText?: string;
  preview?: string;
}

export interface GateQuestionLike {
  id: string;
  type?: AskQuestionTypeLike;
  required?: boolean;
}

export interface AskRequestLike {
  mode?: unknown;
  questions: readonly GateQuestionLike[];
}

export interface AnswerValuesLike {
  values: string[];
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

export function parseAskChoice(
  options: readonly AskOptionLike[],
  choice: string,
  type: AskQuestionTypeLike,
): ParsedAskChoice {
  const parts = type === "multi" ? splitChoiceParts(choice) : [choice.trim()].filter(Boolean);
  const matched = parts
    .map((part) => findOption(options, part))
    .filter((option): option is AskOptionLike => Boolean(option));
  const unmatched = parts.filter((part) => !findOption(options, part));

  if (type === "multi") {
    return {
      kind: "multi",
      values: matched.map((option) => option.value),
      labels: matched.map((option) => option.label),
      customText: unmatched.length > 0 ? unmatched.join(", ") : undefined,
      preview: matched.length === 1 ? matched[0]?.preview : undefined,
    };
  }

  const option = matched[0];
  if (option) {
    return {
      kind: "option",
      values: [option.value],
      labels: [option.label],
      preview: option.preview,
    };
  }

  return {
    kind: "custom",
    values: [],
    labels: [],
    customText: choice.trim(),
  };
}

export function defaultAskChoice(
  options: readonly AskOptionLike[] | undefined,
  type: AskQuestionTypeLike,
): ParsedAskChoice | undefined {
  if (type === "freeform") {
    return { kind: "custom", values: [], labels: [], customText: "" };
  }
  const first = options?.[0];
  if (!first) return undefined;
  return {
    kind: type === "multi" ? "multi" : "option",
    values: [first.value],
    labels: [first.label],
    preview: first.preview,
  };
}

export function isGateMode(mode: unknown): boolean {
  return mode === "decision" || mode === "approval";
}

export function requiresExplicitSelectionForGate(
  mode: unknown,
  question: GateQuestionLike,
): boolean {
  return isGateMode(mode) && question.required === true && question.type !== "freeform";
}

export function hasSubmittedRequiredGateAnswers(
  mode: unknown,
  questions: readonly GateQuestionLike[],
  answers: Record<string, AnswerValuesLike>,
): boolean {
  const required = requiredGateQuestions(mode, questions);
  if (required.length === 0) return Object.keys(answers).length > 0;
  return required.every((question) => Boolean(answers[question.id]));
}

export function hasSubmittedRequiredAskAnswers(
  request: AskRequestLike,
  answers: Record<string, AnswerValuesLike>,
): boolean {
  return hasSubmittedRequiredGateAnswers(request.mode, request.questions, answers);
}

export function hasRequiredGateSelections(
  mode: unknown,
  questions: readonly GateQuestionLike[],
  answers: Record<string, AnswerValuesLike>,
): boolean {
  const required = requiredGateQuestions(mode, questions);
  if (required.length === 0) return Object.keys(answers).length > 0;
  return required.every((question) => (answers[question.id]?.values.length ?? 0) > 0);
}

export function hasRequiredAskSelections(
  request: AskRequestLike,
  answers: Record<string, AnswerValuesLike>,
): boolean {
  return hasRequiredGateSelections(request.mode, request.questions, answers);
}

export function inferAskSubmitStatus(
  request: AskRequestLike,
  answers: Record<string, AnswerValuesLike>,
): "answered" | "no_selection" {
  return hasSubmittedRequiredAskAnswers(request, answers) ? "answered" : "no_selection";
}

export function nextActionForAskSubmit(
  request: AskRequestLike,
  answers: Record<string, AnswerValuesLike>,
  status: "answered" | "no_selection" | "cancelled",
): "resume" | "block" {
  if (status !== "answered") return "block";
  return hasRequiredAskSelections(request, answers) ? "resume" : "block";
}

export function formatAskAnswerForDisplay(answer: {
  labels?: readonly string[];
  customText?: string;
}): string {
  const labels = answer.labels?.filter(Boolean) ?? [];
  if (labels.length > 0) return labels.join(", ");
  return answer.customText || "";
}

function requiredGateQuestions(
  mode: unknown,
  questions: readonly GateQuestionLike[],
): GateQuestionLike[] {
  return questions.filter((question) => requiresExplicitSelectionForGate(mode, question));
}

function splitChoiceParts(choice: string): string[] {
  return choice
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findOption(options: readonly AskOptionLike[], value: string): AskOptionLike | undefined {
  return options.find((option) => option.label === value || option.value === value);
}
