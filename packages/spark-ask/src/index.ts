import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
} from "@zendev-lab/spark-extension-api";
import { truncateToWidth } from "@zendev-lab/spark-tui/text";
import { Type } from "typebox";

import { summarizeAskResult } from "./summary.ts";
import {
  defaultAskChoice,
  inferAskSubmitStatus,
  nextActionForAskSubmit,
  parseAskChoice,
  requiresExplicitSelectionForGate,
  selectOptionWithCustom,
  type ParsedAskChoice,
} from "./shared-semantics.ts";

export type PiAskMode = "clarification" | "decision" | "approval" | "unblock";
export type PiAskDelivery = "blocking" | "async";
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
  defaultValues?: string[];
}

export interface PiAskRequest {
  title?: string;
  mode?: PiAskMode;
  /** Defaults to blocking. Async asks return after the daemon durably accepts them. */
  delivery?: PiAskDelivery;
  context?: string;
  questions: PiAskQuestion[];
}

export interface PiAskAnswerEntry {
  values: string[];
  labels: string[];
  customText?: string;
  comment?: string;
  notes?: string;
  preview?: string;
}

export type PiAskResultStatus = "answered" | "pending" | "cancelled" | "no_selection";

export interface PiAskResult {
  status: PiAskResultStatus;
  humanRequestId?: string;
  cancelled: boolean;
  answers: Record<string, PiAskAnswerEntry>;
  nextAction: "resume" | "block";
}

export interface PiAskUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  selectWithCustom?: (
    title: string,
    input: { options: string[]; customLabel: string },
  ) => Promise<{ value?: string; customText?: string } | string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
}

export interface PiAskExtensionApi {
  registerTool(config: PiAskToolConfig): void;
}

interface PiAskToolConfig {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
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
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
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
  if (!ui) {
    return normalized.delivery === "async"
      ? unavailableAskUserResult(normalized)
      : defaultAskUserResult(normalized);
  }

  const interactionResult = await askUserViaInteraction(normalized, ui);
  if (interactionResult) return interactionResult;
  if (normalized.delivery === "async") return unavailableAskUserResult(normalized);

  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of normalized.questions) {
    const resolved = await resolveQuestion(question, normalized, ui);
    if (!resolved.answer) {
      if (requiresExplicitAskUserSelection(normalized, question))
        return createNoSelectionAskUserResult(normalized, answers);
      continue;
    }
    answers[question.id] = resolved.answer;
    if (
      requiresExplicitAskUserSelection(normalized, question) &&
      resolved.answer.values.length === 0
    ) {
      return createNoSelectionAskUserResult(normalized, answers);
    }
  }
  return createAskUserResult({ cancelled: false, answers });
}

export function defaultAskUserResult(request: PiAskRequest): PiAskResult {
  if (request.delivery === "async") return unavailableAskUserResult(request);
  if (requestRequiresExplicitAskUserSelection(request)) {
    return createAskUserResult({ cancelled: false, answers: {}, status: "no_selection" });
  }

  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of request.questions) {
    const answer = defaultAskChoice(question.options, question.type ?? "single");
    if (answer) answers[question.id] = toAskUserAnswer(answer);
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
    nextAction:
      input.nextAction ?? (status === "answered" || status === "pending" ? "resume" : "block"),
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
      delivery: Type.Optional(
        Type.String({ description: "blocking | async. Defaults to blocking." }),
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
          defaultValues: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    renderCall(args, theme) {
      const questionCount = Array.isArray(args.questions) ? args.questions.length : undefined;
      return renderToolCall(
        "ask_user",
        [
          formatStringArg(args.title, { prefix: "title=" }),
          formatStringArg(args.mode, { fallback: "clarification" }),
          questionCount === undefined ? undefined : `${questionCount}q`,
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = decodeAskRequest(params);
      const result = await askUser(request, ctxUi(ctx));
      return {
        content: [{ type: "text", text: summarizeResult(request, result) }],
        details: {
          request,
          result,
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
            defaultValues: Array.isArray(raw.defaultValues)
              ? raw.defaultValues.filter((value): value is string => typeof value === "string")
              : undefined,
          }) satisfies PiAskQuestion,
      )
    : [];

  return createAskUserRequest({
    title: params.title as string | undefined,
    mode: params.mode as PiAskMode | undefined,
    delivery: normalizeAskDelivery(params.delivery),
    context: params.context as string | undefined,
    questions,
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
    selectWithCustom:
      typeof (ui as { selectWithCustom?: unknown }).selectWithCustom === "function"
        ? (ui as { selectWithCustom: PiAskUi["selectWithCustom"] }).selectWithCustom
        : undefined,
    confirm:
      typeof (ui as { confirm?: unknown }).confirm === "function"
        ? (ui as { confirm: PiAskUi["confirm"] }).confirm
        : undefined,
    input:
      typeof (ui as { input?: unknown }).input === "function"
        ? (ui as { input: PiAskUi["input"] }).input
        : undefined,
    interaction:
      typeof (ui as { interaction?: unknown }).interaction === "function"
        ? (ui as { interaction: PiAskUi["interaction"] }).interaction
        : undefined,
    notify:
      typeof (ui as { notify?: unknown }).notify === "function"
        ? (ui as { notify: PiAskUi["notify"] }).notify
        : undefined,
  };
}

async function askUserViaInteraction(
  request: PiAskRequest,
  ui: PiAskUi,
): Promise<PiAskResult | undefined> {
  if (!ui.interaction) return undefined;
  try {
    const response = await ui.interaction(createAskUserInteractionRequest(request));
    return askUserResultFromInteractionResponse(request, response);
  } catch (error) {
    ui.notify?.(`ask_user interaction failed: ${formatUnknownError(error)}`, "warning");
    return createAskUserResult({ cancelled: true, answers: {}, status: "cancelled" });
  }
}

function createAskUserInteractionRequest(request: PiAskRequest): ExtensionInteractionRequest {
  return {
    version: 1,
    kind: "askFlow",
    requestId: `ask_user:${Date.now().toString(36)}`,
    title: request.title?.trim() || "Ask user",
    prompt: request.context,
    source: "extension",
    metadata: { tool: "ask_user" },
    delivery: request.delivery ?? "blocking",
    mode: request.mode ?? "clarification",
    questions: request.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      ...(question.header !== undefined ? { header: question.header } : {}),
      type: question.type ?? "single",
      required: question.required === true,
      defaultValues: question.defaultValues ?? [],
      options: question.options ?? [],
    })),
  };
}

function askUserResultFromInteractionResponse(
  request: PiAskRequest,
  response: ExtensionInteractionResponse,
): PiAskResult | undefined {
  if (response.kind !== "askFlow") return undefined;
  if (response.status === "blocked" || response.status === "error") return undefined;
  if (response.status === "cancelled") {
    return createAskUserResult({ cancelled: true, answers: {}, status: "cancelled" });
  }
  if (response.status === "pending") {
    const humanRequestId = optionalNonEmptyString(response.humanRequestId);
    if (!humanRequestId) return undefined;
    return createAskUserResult({
      cancelled: false,
      answers: {},
      status: "pending",
      humanRequestId,
      nextAction: "resume",
    });
  }
  if (response.status !== "answered") return undefined;
  return createAskUserResult({
    cancelled: false,
    answers: normalizeAskUserInteractionAnswers(request, response.answers),
    ...(response.nextAction === "block" ? { nextAction: "block" as const } : {}),
  });
}

function normalizeAskUserInteractionAnswers(
  request: PiAskRequest,
  value: unknown,
): Record<string, PiAskAnswerEntry> {
  if (!value || typeof value !== "object") return {};
  const rawAnswers = value as Record<string, unknown>;
  const answers: Record<string, PiAskAnswerEntry> = {};
  for (const question of request.questions) {
    const raw = rawAnswers[question.id];
    const answer = normalizeAskUserInteractionAnswer(question, raw);
    if (answer) answers[question.id] = answer;
  }
  return answers;
}

function normalizeAskUserInteractionAnswer(
  question: PiAskQuestion,
  value: unknown,
): PiAskAnswerEntry | undefined {
  if (typeof value === "string") {
    return toAskUserAnswer(
      parseAskChoice(question.options ?? [], value, question.type ?? "single"),
    );
  }
  if (Array.isArray(value)) {
    return toAskUserAnswer(
      parseAskChoice(question.options ?? [], value.join(", "), question.type ?? "multi"),
    );
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const values = stringArray(raw.values);
  const labels = stringArray(raw.labels);
  const customText = typeof raw.customText === "string" ? raw.customText : undefined;
  const comment = typeof raw.comment === "string" ? raw.comment : undefined;
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;
  const preview = typeof raw.preview === "string" ? raw.preview : undefined;
  if (values.length === 0 && labels.length === 0 && customText === undefined) return undefined;
  return {
    values,
    labels: labels.length > 0 ? labels : labelsForValues(question, values),
    ...(customText !== undefined ? { customText } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}

function labelsForValues(question: PiAskQuestion, values: string[]): string[] {
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  return values.map((value) => byValue.get(value) ?? value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ResolvedQuestion {
  answer?: PiAskAnswerEntry;
}

async function resolveQuestion(
  question: PiAskQuestion,
  request: PiAskRequest,
  ui: PiAskUi,
): Promise<ResolvedQuestion> {
  const title = request.title ? `${request.title} — ${question.prompt}` : question.prompt;
  if ((question.type ?? "single") === "freeform") {
    const text = await ui.input?.(title, "");
    if (text === undefined) return {};
    return { answer: { values: [], labels: [], customText: text } };
  }

  const questionType = (question.type ?? "single") as Exclude<PiAskQuestionType, "freeform">;

  if (question.options && (ui.selectWithCustom || ui.select)) {
    const selected = await selectOptionWithCustom(ui, title, question.options);
    if (!selected) return {};
    if (selected.customText !== undefined) {
      return {
        answer: toAskUserAnswer(
          parseAskChoice(question.options, selected.customText, questionType),
        ),
      };
    }
    return {
      answer: toAskUserAnswer(parseAskChoice(question.options, selected.value ?? "", questionType)),
    };
  }

  if (
    request.mode === "approval" &&
    (question.type ?? "single") === "single" &&
    question.options &&
    question.options.length >= 2 &&
    ui.confirm
  ) {
    const ok = await ui.confirm(title, request.context ?? "");
    if (ok === undefined) return {};
    const chosen = ok ? question.options[0] : question.options[1];
    return { answer: { values: [chosen.value], labels: [chosen.label] } };
  }

  if (ui.input) {
    const prompt = question.options
      ? `${title} — choose one of [${question.options.map((option) => option.label).join(", ")}] or enter custom text`
      : title;
    const text = await ui.input(prompt, question.options?.[0]?.label ?? "");
    if (!text) return {};
    return {
      answer: toAskUserAnswer(parseAskChoice(question.options ?? [], text, questionType)),
    };
  }

  return {};
}

function toAskUserAnswer(choice: ParsedAskChoice): PiAskAnswerEntry {
  return {
    values: choice.values,
    labels: choice.labels,
    ...(choice.customText !== undefined ? { customText: choice.customText } : {}),
    ...(choice.preview !== undefined ? { preview: choice.preview } : {}),
  };
}

function createNoSelectionAskUserResult(
  request: PiAskRequest,
  answers: Record<string, PiAskAnswerEntry>,
): PiAskResult {
  const status = inferAskSubmitStatus(request, answers);
  return createAskUserResult({
    cancelled: false,
    answers,
    status,
    nextAction: nextActionForAskSubmit(request, answers, status),
  });
}

function requiresExplicitAskUserSelection(request: PiAskRequest, question: PiAskQuestion): boolean {
  return requiresExplicitSelectionForGate(request.mode, question);
}

function requestRequiresExplicitAskUserSelection(request: PiAskRequest): boolean {
  return request.questions.some((question) => requiresExplicitAskUserSelection(request, question));
}

function inferAskUserResultStatus(
  result: Pick<PiAskResult, "answers" | "cancelled">,
): PiAskResultStatus {
  if (result.cancelled) return "cancelled";
  return Object.keys(result.answers).length > 0 ? "answered" : "no_selection";
}

function unavailableAskUserResult(_request: PiAskRequest): PiAskResult {
  return createAskUserResult({ cancelled: false, answers: {}, status: "no_selection" });
}

function normalizeAskDelivery(value: unknown): PiAskDelivery | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "blocking" || value === "async") return value;
  throw new Error("ask_user.delivery must be blocking or async");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeResult(request: PiAskRequest, result: PiAskResult): string {
  return summarizeAskResult(request, result);
}

const TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = needsQuoting(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? TOOL_CALL_DEFAULT_ARG_MAX_LENGTH)}`;
}

function needsQuoting(value: string): boolean {
  return /\s|["'`]/.test(value);
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export * from "./schema.ts";
export * from "./flow.ts";
export { registerPiAskActionTool, registerPiAskAutoAnswerProvider } from "./action-tool.ts";
export type {
  PiAskAction,
  PiAskActionToolOptions,
  PiAskAutoAnswerProvider,
  PiAskAutoAnswerResolver,
} from "./action-tool.ts";
export {
  createAskArtifactBody,
  isAskArtifactBody,
  summarizeAskAnswers,
  summarizeAskResult,
} from "./summary.ts";
export type {
  AskArtifactBody,
  AskSummaryAnswer,
  AskSummaryRequest,
  AskSummaryResult,
} from "./summary.ts";
export { PiAskFlowPayloadStore, PiAskFlowPayloadStoreFormatError } from "./ask-payload-store.ts";
export type { StoredAskPayload } from "./ask-payload-store.ts";
export {
  AskConfigStoreFormatError,
  createAskConfigStore,
  getDefaultConfig,
} from "./config/store.ts";
export type { AskConfigStoreOptions } from "./config/store.ts";
export type { AskConfig, AskConfigStore } from "./config/schema.ts";
export { PiAskFlowController, normalizeAskKey, printableAskText } from "./ui/controller.ts";
export type { PiAskTui, PiAskView } from "./ui/controller.ts";
export { createInitialState, buildExtendedOptions } from "./state/state.ts";
export type { AskState } from "./state/state.ts";
export { reduce } from "./state/reducer.ts";
export type { AskAction, Effect } from "./state/reducer.ts";
export { renderAskScreen } from "./ui/render.ts";
export type { RenderTheme, AskUILanguage } from "./ui/render.ts";
