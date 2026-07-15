import { Type, type Static } from "typebox";

// ---- Limits ----
export const MAX_QUESTIONS = 20;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_HEADER_LENGTH = 20;
export const MAX_LABEL_LENGTH = 80;
export const MAX_PREVIEW_LENGTH = 8000;

// ---- Option ----

export const PiAskFlowOptionSchema = Type.Object({
  value: Type.String({ description: "Machine-readable value returned for this option" }),
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: "Short visible label (1-5 words)",
  }),
  description: Type.Optional(
    Type.String({ description: "One-line explanation to help the user choose" }),
  ),
  preview: Type.Optional(
    Type.String({
      maxLength: MAX_PREVIEW_LENGTH,
      description: "Preview content (markdown/code/ASCII)",
    }),
  ),
});

export type PiAskFlowOption = Static<typeof PiAskFlowOptionSchema>;

// ---- Question ----

export const PiAskFlowQuestionType = Type.Union([
  Type.Literal("single"),
  Type.Literal("multi"),
  Type.Literal("preview"),
  Type.Literal("freeform"),
]);

export const PiAskFlowQuestionSchema = Type.Object({
  id: Type.String({ description: "Stable question identifier used as key in results" }),
  prompt: Type.String({
    description: "Direct question shown to the user; ask one decision at a time",
  }),
  header: Type.Optional(
    Type.String({ maxLength: MAX_HEADER_LENGTH, description: "Short tab label (max 16-20 chars)" }),
  ),
  type: Type.Optional(PiAskFlowQuestionType),
  required: Type.Optional(
    Type.Boolean({ description: "Advisory only; marks the question as important" }),
  ),
  defaultValues: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Option values shown as recommended defaults; they do not count as submitted answers.",
    }),
  ),
  options: Type.Optional(
    Type.Array(PiAskFlowOptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
  ),
});

export type PiAskFlowQuestion = Static<typeof PiAskFlowQuestionSchema>;

export type PiAskFlowQuestionTypeVal = Static<typeof PiAskFlowQuestionType>;

// ---- Request / Result ----

export const PiAskFlowMode = Type.Union([
  Type.Literal("clarification"),
  Type.Literal("decision"),
  Type.Literal("approval"),
  Type.Literal("unblock"),
]);

export type PiAskFlowModeVal = Static<typeof PiAskFlowMode>;

export const PiAskDeliverySchema = Type.Union([Type.Literal("blocking"), Type.Literal("async")]);

export type PiAskDeliveryVal = Static<typeof PiAskDeliverySchema>;

export const PiAskFlowBehaviourSchema = Type.Object({
  allowElaborate: Type.Optional(Type.Boolean()),
  allowReplay: Type.Optional(Type.Boolean()),
  preservePriorAnswers: Type.Optional(Type.Boolean()),
});

export type PiAskFlowBehaviour = Static<typeof PiAskFlowBehaviourSchema>;

export const PiAskFlowRequestSchema = Type.Object({
  title: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  flow: Type.Optional(Type.String()),
  mode: Type.Optional(PiAskFlowMode),
  delivery: Type.Optional(PiAskDeliverySchema),
  questions: Type.Array(PiAskFlowQuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
  behaviour: Type.Optional(PiAskFlowBehaviourSchema),
});

export interface PiAskFlowRequest extends Static<typeof PiAskFlowRequestSchema> {
  flow?: string;
}

// ---- Answer types ----

export type PiAskFlowAnswerKind = "option" | "custom" | "multi" | "skipped";

export interface PiAskFlowAnswerEntry {
  questionId: string;
  kind: PiAskFlowAnswerKind;
  values: string[];
  labels?: string[];
  customText?: string;
  notes?: string;
  preview?: string;
}

export type PiAskFlowResultStatus = "answered" | "pending" | "cancelled" | "no_selection";

export interface PiAskFlowResult {
  /**
   * Explicit result envelope status. Use this instead of inferring from
   * `cancelled`, empty answers, or mode-specific text.
   */
  status: PiAskFlowResultStatus;
  /** Durable daemon-owned request handle for an async ask. */
  humanRequestId?: string;
  answers: Record<string, PiAskFlowAnswerEntry>;
  flow?: string;
  mode: "submit" | "elaborate" | "cancel";
  cancelled: boolean;
  base?: unknown;
  elaboration?: {
    affectedQuestionIds: string[];
    preservedAnswers: Record<string, PiAskFlowAnswerEntry>;
    notes: Array<{ questionId: string; note: string }>;
  };
  nextAction?: "resume" | "clarify_then_reask" | "block";
}

// ---- Validation errors ----

export type PiAskFlowValidationError =
  | "no_questions"
  | "empty_options"
  | "too_many_questions"
  | "duplicate_question_id"
  | "duplicate_option_value"
  | "reserved_label"
  | "missing_question_id"
  | "missing_option_value"
  | "missing_option_label"
  | "invalid_default_value";

export const RESERVED_OPTION_LABELS = ["Other", "Skip", "Type your own", "Chat about this"];

const RESERVED_LABEL_HINT =
  "reserved option labels are UI affordances; rename the business option or use a freeform question/custom input instead";
const FREEFORM_DEFAULT_VALUES_HINT =
  "freeform questions do not accept defaultValues; remove defaultValues and put suggested text in prompt/context instead";
const DEFAULT_VALUE_EXACT_MATCH_HINT = "defaultValues must match options[].value exactly";
const SINGLE_DEFAULT_ONLY_HINT =
  "single/preview questions accept at most one default value; use type=multi for multiple defaults";

// ---- Sentinels used in the options list ----
export const SENTINEL_LABELS = {
  other: "Type your own",
} as const;
export type SentinelKind = keyof typeof SENTINEL_LABELS;

// ---- Validation ----

export function validatePiAskFlowRequest(input: unknown): {
  valid: boolean;
  request?: PiAskFlowRequest;
  error?: PiAskFlowValidationError;
  details?: string;
} {
  if (!input || typeof input !== "object") return { valid: false, error: "missing_question_id" };

  const req = input as Partial<PiAskFlowRequest>;
  if (!req.questions || req.questions.length === 0) return { valid: false, error: "no_questions" };
  if (req.questions.length > MAX_QUESTIONS) return { valid: false, error: "too_many_questions" };

  const seenIds = new Set<string>();
  for (const question of req.questions) {
    if (!question.id?.trim()) return { valid: false, error: "missing_question_id" };
    if (seenIds.has(question.id))
      return { valid: false, error: "duplicate_question_id", details: question.id };
    seenIds.add(question.id);

    const opts = question.options;
    if (question.type !== "freeform" && (!opts || opts.length < MIN_OPTIONS)) {
      return { valid: false, error: "empty_options", details: question.id };
    }

    if (question.defaultValues?.length && question.type === "freeform") {
      return {
        valid: false,
        error: "invalid_default_value",
        details: `${question.id}: ${FREEFORM_DEFAULT_VALUES_HINT}`,
      };
    }

    if (opts) {
      const seenValues = new Set<string>();
      for (const option of opts) {
        if (!option.value?.trim())
          return { valid: false, error: "missing_option_value", details: question.id };
        if (!option.label?.trim())
          return { valid: false, error: "missing_option_label", details: question.id };
        if (RESERVED_OPTION_LABELS.includes(option.label)) {
          return {
            valid: false,
            error: "reserved_label",
            details: `${question.id}: ${option.label}; ${RESERVED_LABEL_HINT}`,
          };
        }
        if (seenValues.has(option.value)) {
          return {
            valid: false,
            error: "duplicate_option_value",
            details: `${question.id}: ${option.value}`,
          };
        }
        seenValues.add(option.value);
      }
      for (const defaultValue of question.defaultValues ?? []) {
        if (!seenValues.has(defaultValue)) {
          return {
            valid: false,
            error: "invalid_default_value",
            details: `${question.id}: ${defaultValue}; ${DEFAULT_VALUE_EXACT_MATCH_HINT}. valid values: ${[
              ...seenValues,
            ].join(", ")}`,
          };
        }
      }
      if (question.type !== "multi" && (question.defaultValues?.length ?? 0) > 1) {
        return {
          valid: false,
          error: "invalid_default_value",
          details: `${question.id}: ${SINGLE_DEFAULT_ONLY_HINT}`,
        };
      }
    }
  }

  return { valid: true, request: req as PiAskFlowRequest };
}
