/**
 * Transport-neutral ask answer semantics shared by TUI (`spark-ask`), Cockpit,
 * and coordination projections. Presentation (Svelte forms, terminal UI, inbox
 * copy) stays surface-local; "does this answer count" must not fork.
 */

export type SparkAskQuestionType = "single" | "multi" | "preview" | "freeform" | undefined;

export interface SparkAskOptionLike {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface SparkParsedAskChoice {
  kind: "option" | "multi" | "custom";
  values: string[];
  labels: string[];
  customText?: string;
  preview?: string;
}

export interface SparkGateQuestionLike {
  id: string;
  type?: SparkAskQuestionType;
  required?: boolean;
}

export interface SparkAskRequestLike {
  mode?: unknown;
  questions: readonly SparkGateQuestionLike[];
}

export interface SparkAskAnswerValuesLike {
  values: string[];
  customText?: string;
}

export function parseSparkAskChoice(
  options: readonly SparkAskOptionLike[],
  choice: string,
  type: SparkAskQuestionType,
): SparkParsedAskChoice {
  const parts = type === "multi" ? splitChoiceParts(choice) : [choice.trim()].filter(Boolean);
  const matched = parts
    .map((part) => findOption(options, part))
    .filter((option): option is SparkAskOptionLike => Boolean(option));
  const unmatched = parts.filter((part) => !findOption(options, part));

  if (type === "multi") {
    const customText = unmatched.length > 0 ? unmatched.join(", ") : undefined;
    const preview = matched.length === 1 ? matched[0]?.preview : undefined;
    return {
      kind: "multi",
      values: matched.map((option) => option.value),
      labels: matched.map((option) => option.label),
      ...(customText ? { customText } : {}),
      ...(preview ? { preview } : {}),
    };
  }

  const option = matched[0];
  if (option) {
    return {
      kind: "option",
      values: [option.value],
      labels: [option.label],
      ...(option.preview ? { preview: option.preview } : {}),
    };
  }

  return {
    kind: "custom",
    values: [],
    labels: [],
    customText: choice.trim(),
  };
}

export function defaultSparkAskChoice(
  options: readonly SparkAskOptionLike[] | undefined,
  type: SparkAskQuestionType,
): SparkParsedAskChoice | undefined {
  if (type === "freeform") {
    return { kind: "custom", values: [], labels: [], customText: "" };
  }
  const first = options?.[0];
  if (!first) return undefined;
  return {
    kind: type === "multi" ? "multi" : "option",
    values: [first.value],
    labels: [first.label],
    ...(first.preview ? { preview: first.preview } : {}),
  };
}

export function isSparkAskGateMode(mode: unknown): boolean {
  return mode === "decision" || mode === "approval";
}

export function requiresExplicitSparkAskGateSelection(
  mode: unknown,
  question: SparkGateQuestionLike,
): boolean {
  return isSparkAskGateMode(mode) && question.required === true;
}

/** Whether an answer contains a substantive option selection or custom reply. */
export function hasSparkAskAnswerContent(answer: SparkAskAnswerValuesLike | undefined): boolean {
  return Boolean(
    answer && (answer.values.some((value) => value.trim().length > 0) || answer.customText?.trim()),
  );
}

export function hasSubmittedRequiredSparkAskGateAnswers(
  mode: unknown,
  questions: readonly SparkGateQuestionLike[],
  answers: Record<string, SparkAskAnswerValuesLike>,
): boolean {
  const required = requiredGateQuestions(mode, questions);
  if (required.length === 0) return Object.keys(answers).length > 0;
  return required.every((question) => hasSparkAskAnswerContent(answers[question.id]));
}

export function hasSubmittedRequiredSparkAskAnswers(
  request: SparkAskRequestLike,
  answers: Record<string, SparkAskAnswerValuesLike>,
): boolean {
  return hasSubmittedRequiredSparkAskGateAnswers(request.mode, request.questions, answers);
}

export function hasRequiredSparkAskGateSelections(
  mode: unknown,
  questions: readonly SparkGateQuestionLike[],
  answers: Record<string, SparkAskAnswerValuesLike>,
): boolean {
  const required = requiredGateQuestions(mode, questions);
  if (required.length === 0) return Object.keys(answers).length > 0;
  return required.every((question) => {
    const answer = answers[question.id];
    if (question.type === "freeform") return hasSparkAskAnswerContent(answer);
    return Boolean(answer?.values.some((value) => value.trim().length > 0));
  });
}

export function hasRequiredSparkAskSelections(
  request: SparkAskRequestLike,
  answers: Record<string, SparkAskAnswerValuesLike>,
): boolean {
  return hasRequiredSparkAskGateSelections(request.mode, request.questions, answers);
}

export function inferSparkAskSubmitStatus(
  request: SparkAskRequestLike,
  answers: Record<string, SparkAskAnswerValuesLike>,
): "answered" | "no_selection" {
  return hasSubmittedRequiredSparkAskAnswers(request, answers) ? "answered" : "no_selection";
}

export function nextActionForSparkAskSubmit(
  request: SparkAskRequestLike,
  answers: Record<string, SparkAskAnswerValuesLike>,
  status: "answered" | "no_selection" | "cancelled",
): "resume" | "block" {
  if (status !== "answered") return "block";
  return hasRequiredSparkAskSelections(request, answers) ? "resume" : "block";
}

export function formatSparkAskAnswerForDisplay(answer: {
  labels?: readonly string[];
  customText?: string;
}): string {
  const labels = answer.labels?.filter(Boolean) ?? [];
  if (labels.length > 0) return labels.join(", ");
  return answer.customText || "";
}

function requiredGateQuestions(
  mode: unknown,
  questions: readonly SparkGateQuestionLike[],
): SparkGateQuestionLike[] {
  return questions.filter((question) => requiresExplicitSparkAskGateSelection(mode, question));
}

function splitChoiceParts(choice: string): string[] {
  return choice
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findOption(
  options: readonly SparkAskOptionLike[],
  value: string,
): SparkAskOptionLike | undefined {
  return options.find((option) => option.label === value || option.value === value);
}
