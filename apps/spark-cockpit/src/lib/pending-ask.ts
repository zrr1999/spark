import type { HumanQuestion } from "@zendev-lab/spark-coordination/cockpit-queries";

export interface PendingWorkbenchAsk {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  title: string;
  prompt: string;
  questions: HumanQuestion[];
  detailHref: string;
  createdAt: string;
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
      if (typeof candidateOption.id !== "string" || typeof candidateOption.label !== "string") {
        return [];
      }
      return [
        {
          id: candidateOption.id,
          label: candidateOption.label,
          ...(typeof candidateOption.description === "string"
            ? { description: candidateOption.description }
            : {}),
        },
      ];
    });
  }
  return question;
}
