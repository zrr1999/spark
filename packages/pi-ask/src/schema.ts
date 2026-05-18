import { Type, type Static } from "typebox";

// ---- Limits ----
export const MAX_QUESTIONS = 6;
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

export const PiAskFlowBehaviourSchema = Type.Object({
  allowElaborate: Type.Optional(Type.Boolean()),
  allowReplay: Type.Optional(Type.Boolean()),
  preservePriorAnswers: Type.Optional(Type.Boolean()),
  autoSubmitWhenAnsweredWithoutNotes: Type.Optional(Type.Boolean()),
  confirmDismissWhenDirty: Type.Optional(Type.Boolean()),
  showFooterHints: Type.Optional(Type.Boolean()),
});

export type PiAskFlowBehaviour = Static<typeof PiAskFlowBehaviourSchema>;

export const PiAskFlowRequestSchema = Type.Object({
  title: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  flow: Type.Optional(Type.String()),
  mode: Type.Optional(PiAskFlowMode),
  questions: Type.Array(PiAskFlowQuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
  behaviour: Type.Optional(PiAskFlowBehaviourSchema),
  timeoutMs: Type.Optional(Type.Number()),
});

export interface PiAskFlowRequest extends Static<typeof PiAskFlowRequestSchema> {
  flow?: string;
}

// ---- Answer types ----

export type PiAskFlowAnswerKind = "option" | "custom" | "multi" | "freeform" | "skipped";

export interface PiAskFlowAnswerEntry {
  questionId: string;
  kind: PiAskFlowAnswerKind;
  values: string[];
  labels?: string[];
  customText?: string;
  notes?: string;
  preview?: string;
}

export interface PiAskFlowResult {
  answers: Record<string, PiAskFlowAnswerEntry>;
  flow?: string;
  mode: "submit" | "elaborate" | "cancel" | "chat";
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
  | "missing_option_label";

export const RESERVED_OPTION_LABELS = ["Other", "Skip", "Type your own", "Chat about this"];

// ---- Sentinels used in the options list ----
export type SentinelKind = "other" | "chat" | "next";
export const SENTINEL_LABELS: Record<SentinelKind, string> = {
  other: "Type your own",
  chat: "Chat about this",
  next: "Next",
};

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
            details: `${question.id}: ${option.label}`,
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
    }
  }

  return { valid: true, request: req as PiAskFlowRequest };
}
