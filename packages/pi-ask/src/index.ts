import { Type } from "typebox";

export type PiAskMode = "clarification" | "decision" | "approval" | "unblock";
export type PiAskQuestionType = "single" | "multi" | "freeform";

export interface PiAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface PiAskQuestion {
  id: string;
  prompt: string;
  header?: string;
  type?: PiAskQuestionType | "preview";
  options?: PiAskOption[];
  required?: boolean;
}

export interface PiAskRequest {
  title?: string;
  mode?: PiAskMode;
  context?: string;
  questions: PiAskQuestion[];
  timeoutMs?: number;
}

export interface PiAskAnswerEntry {
  values: string[];
  labels: string[];
  customText?: string;
  comment?: string;
  notes?: string;
  preview?: string;
}

export type PiAskResultStatus = "answered" | "timeout" | "cancelled" | "no_selection";

export interface PiAskResult {
  status: PiAskResultStatus;
  cancelled: boolean;
  answers: Record<string, PiAskAnswerEntry>;
  nextAction: "resume" | "block";
}

export interface PiAskUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
}

export interface PiAskExtensionApi {
  registerTool(config: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: unknown,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
}

export function createAskUserRequest(input: PiAskRequest): PiAskRequest {
  if (input.questions.length === 0) throw new Error("ask_user needs at least one question");
  const seen = new Set<string>();
  for (const question of input.questions) {
    if (!question.id.trim()) throw new Error("question id is required");
    if (seen.has(question.id)) throw new Error(`duplicate question id: ${question.id}`);
    seen.add(question.id);
    if (!question.prompt.trim()) throw new Error(`question prompt is required: ${question.id}`);
    if (
      (question.type ?? "single") !== "freeform" &&
      (!question.options || question.options.length === 0)
    ) {
      throw new Error(`question options are required: ${question.id}`);
    }
  }
  return input;
}

export async function askUser(request: PiAskRequest, ui?: PiAskUi): Promise<PiAskResult> {
  const normalized = createAskUserRequest(request);
  if (!ui) return defaultAskUserResult(normalized);

  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of normalized.questions) {
    const resolved = await resolveQuestion(question, normalized, ui);
    if (resolved.timedOut) {
      return createAskUserResult({
        cancelled: false,
        answers,
        status: Object.keys(answers).length > 0 ? "answered" : "timeout",
      });
    }
    if (!resolved.answer) {
      if (question.required)
        return createAskUserResult({ cancelled: false, answers, status: "no_selection" });
      continue;
    }
    answers[question.id] = resolved.answer;
  }
  return createAskUserResult({ cancelled: false, answers });
}

export function defaultAskUserResult(request: PiAskRequest): PiAskResult {
  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of request.questions) {
    const first = question.options?.[0];
    answers[question.id] = {
      values: first ? [first.value] : [],
      labels: first ? [first.label] : [],
      customText: first ? undefined : "",
    };
  }
  return createAskUserResult({ cancelled: false, answers });
}

export function createAskUserResult(
  input: Omit<PiAskResult, "status" | "nextAction"> &
    Partial<Pick<PiAskResult, "status" | "nextAction">>,
): PiAskResult {
  const status = input.status ?? inferAskUserResultStatus(input);
  return {
    ...input,
    status,
    nextAction: input.nextAction ?? (status === "answered" ? "resume" : "block"),
  };
}

export function registerPiAskTools(pi: PiAskExtensionApi): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a structured clarification, decision, approval, or unblock question and return stable structured answers.",
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({
          description: "clarification | decision | approval | unblock",
        }),
      ),
      context: Type.Optional(Type.String()),
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          type: Type.Optional(Type.String({ description: "single | multi | freeform" })),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                value: Type.String(),
                label: Type.String(),
                description: Type.Optional(Type.String()),
              }),
            ),
          ),
          required: Type.Optional(Type.Boolean()),
        }),
      ),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = decodeAskRequest(params);
      const result = await askUser(request, ctxUi(ctx));
      return {
        content: [{ type: "text", text: summarizeResult(request, result) }],
        details: {
          request: request as unknown as Record<string, unknown>,
          result: result as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

function decodeAskRequest(params: Record<string, unknown>): PiAskRequest {
  const questions = Array.isArray(params.questions)
    ? (params.questions as Array<Record<string, unknown>>).map(
        (raw) =>
          ({
            id: typeof raw.id === "string" ? raw.id : "",
            prompt: typeof raw.prompt === "string" ? raw.prompt : "",
            type: raw.type as PiAskQuestionType | undefined,
            options: Array.isArray(raw.options)
              ? (raw.options as Array<Record<string, unknown>>).map(
                  (entry) =>
                    ({
                      value: typeof entry.value === "string" ? entry.value : "",
                      label: typeof entry.label === "string" ? entry.label : "",
                      description: entry.description as string | undefined,
                    }) satisfies PiAskOption,
                )
              : undefined,
            required: raw.required === true,
          }) satisfies PiAskQuestion,
      )
    : [];

  return createAskUserRequest({
    title: params.title as string | undefined,
    mode: params.mode as PiAskMode | undefined,
    context: params.context as string | undefined,
    questions,
    timeoutMs: params.timeoutMs as number | undefined,
  });
}

function ctxUi(ctx: unknown): PiAskUi | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const ui = (ctx as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return undefined;
  return {
    select:
      typeof (ui as { select?: unknown }).select === "function"
        ? (ui as { select: PiAskUi["select"] }).select
        : undefined,
    confirm:
      typeof (ui as { confirm?: unknown }).confirm === "function"
        ? (ui as { confirm: PiAskUi["confirm"] }).confirm
        : undefined,
    input:
      typeof (ui as { input?: unknown }).input === "function"
        ? (ui as { input: PiAskUi["input"] }).input
        : undefined,
    notify:
      typeof (ui as { notify?: unknown }).notify === "function"
        ? (ui as { notify: PiAskUi["notify"] }).notify
        : undefined,
  };
}

type ResolvedQuestion =
  | { timedOut: true; answer?: undefined }
  | { timedOut: false; answer?: PiAskAnswerEntry };

async function resolveQuestion(
  question: PiAskQuestion,
  request: PiAskRequest,
  ui: PiAskUi,
): Promise<ResolvedQuestion> {
  const title = request.title ? `${request.title} — ${question.prompt}` : question.prompt;
  if ((question.type ?? "single") === "freeform") {
    const text = await withTimeout(ui.input?.(title, ""), request.timeoutMs);
    if (text.timedOut) return { timedOut: true };
    if (text.value === undefined) return { timedOut: false };
    return { timedOut: false, answer: { values: [], labels: [], customText: text.value } };
  }

  const questionType = (question.type ?? "single") as Exclude<PiAskQuestionType, "freeform">;

  if (ui.select && question.options) {
    const selected = await withTimeout(
      ui.select(
        title,
        question.options.map((option) => option.label),
      ),
      request.timeoutMs,
    );
    if (selected.timedOut) return { timedOut: true };
    if (!selected.value) return { timedOut: false };
    return {
      timedOut: false,
      answer: parseOptionText(question.options, selected.value, questionType),
    };
  }

  if (
    request.mode === "approval" &&
    (question.type ?? "single") === "single" &&
    question.options &&
    question.options.length >= 2 &&
    ui.confirm
  ) {
    const ok = await withTimeout(ui.confirm(title, request.context ?? ""), request.timeoutMs);
    if (ok.timedOut) return { timedOut: true };
    if (ok.value === undefined) return { timedOut: false };
    const chosen = ok.value ? question.options[0] : question.options[1];
    return { timedOut: false, answer: { values: [chosen.value], labels: [chosen.label] } };
  }

  if (ui.input) {
    const prompt = question.options
      ? `${title} — choose one of [${question.options.map((option) => option.label).join(", ")}] or enter custom text`
      : title;
    const text = await withTimeout(
      ui.input(prompt, question.options?.[0]?.label ?? ""),
      request.timeoutMs,
    );
    if (text.timedOut) return { timedOut: true };
    if (!text.value) return { timedOut: false };
    return {
      timedOut: false,
      answer: parseOptionText(question.options ?? [], text.value, questionType),
    };
  }

  return { timedOut: false };
}

function parseOptionText(
  options: PiAskOption[],
  text: string,
  type: Exclude<PiAskQuestionType, "freeform">,
): PiAskAnswerEntry {
  const parts = type === "multi" ? splitAnswerParts(text) : [text.trim()].filter(Boolean);
  const matched = parts
    .map((part) => findOption(options, part))
    .filter((option): option is PiAskOption => Boolean(option));
  const unmatched = parts.filter((part) => !findOption(options, part));
  if (type === "single") {
    const option = matched[0];
    if (option) return { values: [option.value], labels: [option.label] };
    return { values: [], labels: [], customText: text.trim() };
  }
  return {
    values: matched.map((option) => option.value),
    labels: matched.map((option) => option.label),
    customText: unmatched.length > 0 ? unmatched.join(", ") : undefined,
  };
}

function splitAnswerParts(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findOption(options: PiAskOption[], value: string): PiAskOption | undefined {
  return options.find((option) => option.label === value || option.value === value);
}

type TimedInteraction<T> =
  | { timedOut: true; value?: undefined }
  | { timedOut: false; value: T | undefined };

async function withTimeout<T>(
  promise: Promise<T> | undefined,
  timeoutMs?: number,
): Promise<TimedInteraction<T>> {
  if (!promise) return { timedOut: false, value: undefined };
  if (!timeoutMs || timeoutMs <= 0) return { timedOut: false, value: await promise };
  const timeoutToken = Symbol("timeout");
  const value = await Promise.race([
    promise,
    new Promise<typeof timeoutToken>((resolve) =>
      setTimeout(() => resolve(timeoutToken), timeoutMs),
    ),
  ]);
  if (value === timeoutToken) return { timedOut: true };
  return { timedOut: false, value };
}

function inferAskUserResultStatus(
  result: Pick<PiAskResult, "answers" | "cancelled">,
): PiAskResultStatus {
  if (result.cancelled) return "cancelled";
  return Object.keys(result.answers).length > 0 ? "answered" : "no_selection";
}

function summarizeResult(request: PiAskRequest, result: PiAskResult): string {
  if (result.status !== "answered") return `${request.title ?? "ask_user"}: ${result.status}`;
  const answered = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  return `${request.title ?? "ask_user"}: ${answered.join("; ") || "no answers"}`;
}

export * from "./schema.ts";
export * from "./flow.ts";
export { PiAskFlowPayloadStore } from "./ask-payload-store.ts";
export { createAskConfigStore } from "./config/store.ts";
export { PiAskFlowController } from "./ui/controller.ts";
export { createInitialState, buildExtendedOptions } from "./state/state.ts";
export type { AskState } from "./state/state.ts";
export { reduce } from "./state/reducer.ts";
export type { AskAction, Effect } from "./state/reducer.ts";
export { routeKey } from "./state/key-router.ts";
export { renderAskScreen } from "./ui/render.ts";
export type { RenderTheme, AskUILanguage } from "./ui/render.ts";
