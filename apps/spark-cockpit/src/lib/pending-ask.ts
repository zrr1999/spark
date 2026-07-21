import type { HumanQuestion } from "@zendev-lab/spark-cockpit-coordination/cockpit-queries";
import {
  hasSparkAskAnswerContent,
  parseSparkAskChoice,
  type SparkAskOptionLike,
} from "@zendev-lab/spark-protocol";

export interface PendingWorkbenchAsk {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  /** Session that owns this human ask wait; null when not session-scoped. */
  sessionId: string | null;
  title: string;
  prompt: string;
  questions: HumanQuestion[];
  detailHref: string;
  createdAt: string;
  pendingCount?: number;
}

export const cockpitCustomAnswerValue = "__spark_cockpit_custom_answer__";

export interface HumanAskAnswer {
  values: string[];
  labels?: string[];
  customText?: string;
}

export interface PendingAskEvent {
  id: string;
  workspaceId: string | null;
  kind: string;
  createdAt: string;
}

const pendingAskInvalidationKinds = new Set([
  "human.request.created",
  "human.response.recorded",
  "human.response.acked",
]);

export function parseHumanQuestions(value: string): HumanQuestion[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((question) => {
      const normalized = normalizeHumanQuestion(question);
      return normalized ? [normalized] : [];
    });
  } catch {
    return [];
  }
}

export function parsePendingAskEvent(value: string): PendingAskEvent | null {
  try {
    const event = JSON.parse(value) as Record<string, unknown>;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      typeof event.kind !== "string" ||
      typeof event.createdAt !== "string" ||
      (event.workspaceId !== null && typeof event.workspaceId !== "string")
    ) {
      return null;
    }
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      kind: event.kind,
      createdAt: event.createdAt,
    };
  } catch {
    return null;
  }
}

export function shouldInvalidatePendingAsk(event: PendingAskEvent, workspaceId: string) {
  return event.workspaceId === workspaceId && pendingAskInvalidationKinds.has(event.kind);
}

export function pendingAskEventCursor(event: Pick<PendingAskEvent, "createdAt" | "id">) {
  return `${event.createdAt}|${event.id}`;
}

export function humanSingleAnswerWithCustomFallback(
  question: HumanQuestion,
  selected: string,
  customAnswer: string,
): HumanAskAnswer {
  const value = selected.trim();
  if (
    value === cockpitCustomAnswerValue ||
    question.type === "freeform" ||
    !question.options?.length
  ) {
    const customText = (value === cockpitCustomAnswerValue ? customAnswer : selected).trim();
    return {
      values: [],
      ...(customText ? { customText } : {}),
    };
  }

  if (!value) return { values: [] };
  return answerFromParsedChoice(question, value);
}

export function humanMultiAnswerWithCustomFallback(
  question: HumanQuestion,
  selected: readonly string[],
  customAnswer: string,
): HumanAskAnswer {
  if (!question.options?.length) {
    const customText = selected
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    return {
      values: [],
      ...(customText ? { customText } : {}),
    };
  }

  const values = [
    ...new Set(
      selected
        .map((value) => value.trim())
        .filter((value) => value && value !== cockpitCustomAnswerValue),
    ),
  ];
  const answer = answerFromParsedChoice(question, values.join(","));
  const customText = selected.includes(cockpitCustomAnswerValue) ? customAnswer.trim() : "";
  return {
    ...answer,
    ...(customText ? { customText } : {}),
  };
}

export function humanAskAnswerHasValue(answer: HumanAskAnswer): boolean {
  return hasSparkAskAnswerContent(answer);
}

function answerFromParsedChoice(question: HumanQuestion, choice: string): HumanAskAnswer {
  const parsed = parseSparkAskChoice(toSparkAskOptions(question), choice, question.type);
  return {
    values: parsed.values,
    ...(parsed.labels.length > 0 ? { labels: parsed.labels } : {}),
    ...(parsed.customText ? { customText: parsed.customText } : {}),
  };
}

function toSparkAskOptions(question: HumanQuestion): SparkAskOptionLike[] {
  return (question.options ?? []).map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.preview ? { preview: option.preview } : {}),
  }));
}

function normalizeHumanQuestion(value: unknown): HumanQuestion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.prompt !== "string" ||
    (candidate.type !== "single" &&
      candidate.type !== "multi" &&
      candidate.type !== "freeform" &&
      candidate.type !== "preview")
  ) {
    return null;
  }

  const question: HumanQuestion = {
    id: candidate.id,
    type: candidate.type,
    prompt: candidate.prompt,
  };
  if (typeof candidate.required === "boolean") question.required = candidate.required;
  if (Array.isArray(candidate.options)) {
    question.options = candidate.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const candidateOption = option as Record<string, unknown>;
      const optionValue =
        typeof candidateOption.value === "string"
          ? candidateOption.value
          : typeof candidateOption.id === "string"
            ? candidateOption.id
            : null;
      if (!optionValue || typeof candidateOption.label !== "string") {
        return [];
      }
      return [
        {
          value: optionValue,
          label: candidateOption.label,
          ...(typeof candidateOption.description === "string"
            ? { description: candidateOption.description }
            : {}),
          ...(typeof candidateOption.preview === "string"
            ? { preview: candidateOption.preview }
            : {}),
        },
      ];
    });
  }
  return question;
}
