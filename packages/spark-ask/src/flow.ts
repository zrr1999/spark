import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
} from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-tui/text";
import { Type } from "typebox";

import { SparkAskFlowController } from "./ui/controller.ts";
import { SparkAskFlowPayloadStore } from "./ask-payload-store.ts";
import type {
  SparkAskFlowAnswerEntry,
  SparkAskFlowQuestion,
  SparkAskFlowRequest,
  SparkAskFlowResult,
} from "./schema.ts";
import { validateSparkAskFlowRequest } from "./schema.ts";
import {
  createSparkAskFlowArtifactBody as createSharedSparkAskFlowArtifactBody,
  summarizeAskResult,
} from "./summary.ts";
import {
  defaultAskChoice,
  hasAskAnswerContent,
  hasRequiredAskSelections,
  hasSubmittedRequiredAskAnswers,
  inferAskSubmitStatus,
  isGateMode,
  nextActionForAskSubmit,
  parseAskChoice,
  requiresExplicitSelectionForGate,
  selectOptionWithCustom,
  type ParsedAskChoice,
  type SelectWithCustomUi,
} from "./shared-semantics.ts";

interface SparkHostAPI {
  registerTool?(config: {
    name: string;
    label?: string;
    description: string;
    promptGuidelines?: string[];
    parameters: unknown;
    renderCall?: (
      args: Record<string, unknown>,
      theme: { bold?: (text: string) => string },
      context: unknown,
    ) => { render(width: number): string[] };
    execute: (
      toolCallId: unknown,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  registerCommand?(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: unknown) => void | Promise<void>;
    },
  ): void;
}

interface SparkAskFlowToolContext {
  cwd?: string;
  ui?: {
    custom?: unknown;
    interaction?: unknown;
  };
}

interface SparkAskFlowCustomOptions {
  overlay?: boolean;
  overlayOptions?: unknown;
}

type SparkAskFlowCustomFactory<T = unknown> = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => unknown;

export interface SparkAskFlowElaborationNote {
  questionId: string;
  note: string;
}

export interface SparkAskFlowArtifactBody {
  request: SparkAskFlowRequest;
  result: SparkAskFlowResult;
}

export function createSparkAskFlowRequest(input: SparkAskFlowRequest): SparkAskFlowRequest {
  const validation = validateSparkAskFlowRequest(input);
  if (!validation.valid) {
    throw new Error(
      `invalid ask flow request: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
    );
  }
  return input;
}

export async function runSparkAskFlow(
  input: SparkAskFlowRequest,
  ui?: SelectWithCustomUi,
): Promise<SparkAskFlowResult> {
  const request = createSparkAskFlowRequest(input);
  const interactionRun = await runSparkAskFlowInteraction(
    request,
    ui as SparkAskFlowToolContext["ui"],
  );
  if (interactionRun) return normalizeSparkAskFlowResult(interactionRun.result, request);
  if (request.delivery === "async") return createNoSelectionSparkAskFlowResult(request, {});
  if (!ui?.select && !ui?.selectWithCustom && !ui?.input) return defaultSparkAskFlowResult(request);

  const answers: Record<string, SparkAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      const text = await ui.input?.(question.prompt);
      if (text !== undefined) {
        answers[question.id] = {
          questionId: question.id,
          kind: "custom",
          values: [],
          customText: text,
        };
      } else if (requiresExplicitSelection(request, question)) {
        return createNoSelectionSparkAskFlowResult(request, answers);
      }
      continue;
    }

    if (question.options && question.options.length > 0) {
      const choice = await selectOptionWithCustom(ui, question.prompt, question.options);
      if (!choice) {
        if (requiresExplicitSelection(request, question)) {
          return createNoSelectionSparkAskFlowResult(request, answers);
        }
        continue;
      }
      const answer = toFlowAnswer(
        question.id,
        parseAskChoice(question.options, choice.customText ?? choice.value ?? "", question.type),
      );
      answers[question.id] = answer;
      if (requiresExplicitSelection(request, question) && !hasAskAnswerContent(answer)) {
        return createNoSelectionSparkAskFlowResult(request, answers);
      }
    }
  }

  return normalizeSparkAskFlowResult(
    createSparkAskFlowResult({
      answers,
      flow: request.flow,
      mode: "submit",
      cancelled: false,
    }),
    request,
  );
}

export function defaultSparkAskFlowResult(request: SparkAskFlowRequest): SparkAskFlowResult {
  if (requestRequiresExplicitSelection(request)) {
    return createNoSelectionSparkAskFlowResult(request, {});
  }

  const answers: Record<string, SparkAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      answers[question.id] = {
        questionId: question.id,
        kind: "custom",
        values: [],
        customText: "",
      };
      continue;
    }
    const answer = defaultAskChoice(question.options, question.type);
    if (!answer) continue;
    answers[question.id] = toFlowAnswer(question.id, answer);
  }
  return createSparkAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
  });
}

export async function replaySparkAskFlow(
  input: SparkAskFlowRequest,
  prior: SparkAskFlowResult | undefined,
  ui?: SelectWithCustomUi,
): Promise<SparkAskFlowResult> {
  return runSparkAskFlow(replayableSparkAskFlow(input, prior), ui);
}

export function replayableSparkAskFlow(
  input: SparkAskFlowRequest,
  prior?: SparkAskFlowResult,
): SparkAskFlowRequest {
  if (!prior?.answers || !input.behaviour?.preservePriorAnswers) return input;
  const questions: SparkAskFlowQuestion[] = (input.questions ?? []).map((question) => {
    const existing = prior.answers[question.id];
    if (!existing || question.type === "freeform") return question;
    const options = question.options?.map((option) => ({
      ...option,
      description: existing.values.includes(option.value)
        ? `${option.description ?? ""}${option.description ? "\n" : ""}Previously selected.`
        : option.description,
    }));
    return { ...question, options };
  });
  return { ...input, questions };
}

export function createSparkAskFlowArtifactBody(
  request: SparkAskFlowRequest,
  result: SparkAskFlowResult,
): SparkAskFlowArtifactBody & { summary: string } {
  return createSharedSparkAskFlowArtifactBody(
    request,
    normalizeSparkAskFlowResult(result, request),
  );
}

export function isSparkAskFlowArtifactBody(value: unknown): value is SparkAskFlowArtifactBody & {
  summary?: string;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object",
  );
}

export function createElaborationResult(
  prior: SparkAskFlowResult,
  notes: SparkAskFlowElaborationNote[],
): SparkAskFlowResult {
  return createSparkAskFlowResult({
    ...prior,
    status: "answered",
    mode: "elaborate",
    cancelled: false,
    elaboration: {
      affectedQuestionIds: notes.map((note) => note.questionId),
      preservedAnswers: prior.answers,
      notes,
    },
    nextAction: "clarify_then_reask",
  });
}

export function registerSparkAskFlowTool(pi: SparkHostAPI): void {
  const payloadStore = new SparkAskFlowPayloadStore();

  pi.registerTool?.({
    name: "ask_flow",
    label: "Ask Flow",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock flow.",
    promptGuidelines: [
      "Use ask_flow when a decision needs multiple related questions.",
      "Use delivery=blocking to wait for the answer, or delivery=async to create a durable Inbox request and continue.",
      "Ask questions grounded in the actual situation; avoid generic intake templates.",
      "After a decision is confirmed, continue with the chosen action when clear.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      delivery: Type.Optional(
        Type.String({ description: "blocking | async. Defaults to blocking." }),
      ),
      context: Type.Optional(Type.String()),
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          header: Type.Optional(Type.String()),
          type: Type.Optional(Type.String({ description: "single | multi | preview | freeform" })),
          required: Type.Optional(Type.Boolean()),
          defaultValues: Type.Optional(Type.Array(Type.String())),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                value: Type.String(),
                label: Type.String(),
                description: Type.Optional(Type.String()),
                preview: Type.Optional(Type.String()),
              }),
            ),
          ),
        }),
      ),
    }),

    renderCall(args, theme) {
      const questionCount = Array.isArray(args.questions) ? args.questions.length : undefined;
      return renderAskFlowToolCall(
        "ask_flow",
        [
          formatStringArg(args.title, { prefix: "title=" }),
          formatStringArg(args.mode, { fallback: "clarification" }),
          questionCount === undefined ? undefined : `${questionCount}q`,
        ],
        theme,
      );
    },

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const request = createSparkAskFlowRequest(rawParams as SparkAskFlowRequest);
      const context = decodeSparkAskFlowToolContext(ctx);
      const ui = context.ui;

      const interactionRun = await runSparkAskFlowInteraction(request, ui);
      if (interactionRun) {
        const normalizedResult = normalizeSparkAskFlowResult(interactionRun.result, request);
        if (typeof context.cwd === "string" && context.cwd.trim()) {
          await payloadStore.save(context.cwd, {
            request,
            result: normalizedResult,
            timestamp: Date.now(),
          });
        }
        return {
          content: [
            { type: "text" as const, text: summarizeFlowResult(normalizedResult, request) },
          ],
          details: {
            result: normalizedResult,
            status: normalizedResult.status,
            cancelled: normalizedResult.cancelled,
            mode: normalizedResult.mode,
            protocolInteraction: true,
            ...(interactionRun.fallbackReason
              ? { protocolInteractionFallback: interactionRun.fallbackReason }
              : {}),
          },
        };
      }

      if (request.delivery === "async") {
        const result = createNoSelectionSparkAskFlowResult(request, {});
        return {
          content: [{ type: "text" as const, text: summarizeFlowResult(result, request) }],
          details: { result, status: result.status, cancelled: false, mode: result.mode },
        };
      }

      if (typeof ui?.custom !== "function") {
        const result = createCancelledSparkAskFlowResult(request);
        return {
          content: [{ type: "text" as const, text: summarizeFlowResult(result, request) }],
          details: { result, status: result.status, cancelled: true, mode: "cancel" },
        };
      }

      const custom = ui.custom as <T>(
        factory: SparkAskFlowCustomFactory<T>,
        options?: SparkAskFlowCustomOptions,
      ) => unknown;
      const cwd = requiredSparkAskFlowCwd(context);

      const customRun = await runSparkAskFlowCustomUi(request, custom);
      const normalizedResult = normalizeSparkAskFlowResult(customRun.result, request);
      await payloadStore.save(cwd, { request, result: normalizedResult, timestamp: Date.now() });

      return {
        content: [{ type: "text" as const, text: summarizeFlowResult(normalizedResult, request) }],
        details: {
          result: normalizedResult,
          status: normalizedResult.status,
          cancelled: normalizedResult.cancelled,
          mode: normalizedResult.mode,
          ...(customRun.fallbackReason ? { customUiFallback: customRun.fallbackReason } : {}),
        },
      };
    },
  });
}

interface SparkAskFlowCustomRun {
  result: SparkAskFlowResult;
  fallbackReason?: string;
}

async function runSparkAskFlowInteraction(
  request: SparkAskFlowRequest,
  ui: SparkAskFlowToolContext["ui"],
): Promise<SparkAskFlowCustomRun | undefined> {
  if (typeof ui?.interaction !== "function") return undefined;
  try {
    const response = (await (
      ui.interaction as (
        request: ExtensionInteractionRequest,
      ) => Promise<ExtensionInteractionResponse>
    )(createSparkAskFlowInteractionRequest(request))) as ExtensionInteractionResponse | undefined;
    if (!response || response.kind !== "askFlow") return undefined;
    if (response.status === "blocked" || response.status === "error") return undefined;
    if (response.status === "cancelled") {
      return {
        result: createCancelledSparkAskFlowResult(request, response.metadata?.timedOut === true),
      };
    }
    if (response.status === "pending") {
      const humanRequestId = optionalNonEmptyString(response.humanRequestId);
      if (!humanRequestId) return undefined;
      return {
        result: createSparkAskFlowResult({
          answers: {},
          flow: request.flow,
          mode: "submit",
          cancelled: false,
          status: "pending",
          humanRequestId,
          nextAction: "resume",
        }),
      };
    }
    if (response.status !== "answered") return undefined;
    return { result: piAskFlowResultFromInteractionResponse(request, response) };
  } catch (error) {
    return {
      result: createCancelledSparkAskFlowResult(request),
      fallbackReason: `interaction failed: ${formatUnknownError(error)}`,
    };
  }
}

function createSparkAskFlowInteractionRequest(
  request: SparkAskFlowRequest,
): ExtensionInteractionRequest {
  return {
    version: 1,
    kind: "askFlow",
    requestId: `ask_flow:${Date.now().toString(36)}`,
    title: request.title?.trim() || "Ask flow",
    prompt: request.context,
    source: "extension",
    metadata: { tool: "ask_flow" },
    delivery: request.delivery ?? "blocking",
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    mode: request.mode ?? "clarification",
    ...(request.flow ? { flow: request.flow } : {}),
    questions: (request.questions ?? []).map((question) => ({
      id: question.id,
      prompt: question.prompt,
      ...(question.header !== undefined ? { header: question.header } : {}),
      type: question.type ?? "single",
      required: question.required === true,
      defaultValues: question.defaultValues ?? [],
      options: question.options ?? [],
    })),
    allowElaborate: request.behaviour?.allowElaborate,
  };
}

function piAskFlowResultFromInteractionResponse(
  request: SparkAskFlowRequest,
  response: ExtensionInteractionResponse,
): SparkAskFlowResult {
  return createSparkAskFlowResult({
    answers: normalizeSparkAskFlowInteractionAnswers(request, response.answers),
    flow: request.flow,
    mode: "submit",
    cancelled: false,
    ...(response.nextAction === "block" ? { nextAction: "block" as const } : {}),
  });
}

function normalizeSparkAskFlowInteractionAnswers(
  request: SparkAskFlowRequest,
  value: unknown,
): Record<string, SparkAskFlowAnswerEntry> {
  if (!value || typeof value !== "object") return {};
  const rawAnswers = value as Record<string, unknown>;
  const answers: Record<string, SparkAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    const answer = normalizeSparkAskFlowInteractionAnswer(question, rawAnswers[question.id]);
    if (answer) answers[question.id] = answer;
  }
  return answers;
}

function normalizeSparkAskFlowInteractionAnswer(
  question: SparkAskFlowQuestion,
  value: unknown,
): SparkAskFlowAnswerEntry | undefined {
  if (typeof value === "string")
    return toFlowAnswer(question.id, parseAskChoice(question.options ?? [], value, question.type));
  if (Array.isArray(value)) {
    return toFlowAnswer(
      question.id,
      parseAskChoice(question.options ?? [], value.join(", "), question.type ?? "multi"),
    );
  }
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const values = stringArray(raw.values);
  const labels = stringArray(raw.labels);
  const customText = typeof raw.customText === "string" ? raw.customText : undefined;
  const notes = typeof raw.notes === "string" ? raw.notes : undefined;
  const preview = typeof raw.preview === "string" ? raw.preview : undefined;
  if (values.length === 0 && labels.length === 0 && customText === undefined) return undefined;
  return {
    questionId: question.id,
    kind: customText !== undefined ? "custom" : question.type === "multi" ? "multi" : "option",
    values,
    ...(labels.length > 0
      ? { labels }
      : values.length > 0
        ? { labels: labelsForValues(question, values) }
        : {}),
    ...(customText !== undefined ? { customText } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}

function labelsForValues(question: SparkAskFlowQuestion, values: string[]): string[] {
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  return values.map((value) => byValue.get(value) ?? value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function runSparkAskFlowCustomUi(
  request: SparkAskFlowRequest,
  custom: <T>(
    factory: SparkAskFlowCustomFactory<T>,
    options?: SparkAskFlowCustomOptions,
  ) => unknown,
): Promise<SparkAskFlowCustomRun> {
  try {
    const result = await new Promise<SparkAskFlowResult>((resolve, reject) => {
      const resolveOnce = once(resolve);
      const rejectOnce = once(reject);
      const controller = new SparkAskFlowController({ request, language: "en" });
      const factory: SparkAskFlowCustomFactory<SparkAskFlowResult> = (
        tui,
        theme,
        _keybindings,
        done,
      ) => {
        try {
          return controller.run(
            tui as Parameters<typeof controller.run>[0],
            theme as Parameters<typeof controller.run>[1],
            (flowResult: SparkAskFlowResult) => {
              try {
                done(flowResult);
              } catch (error) {
                rejectOnce(error);
                return;
              }
              resolveOnce(flowResult);
            },
          );
        } catch (error) {
          rejectOnce(error);
          return undefined;
        }
      };
      const customResult = custom(factory);
      if (isPromiseLike(customResult)) {
        void Promise.resolve(customResult).then((value) => {
          if (isSparkAskFlowResultLike(value)) resolveOnce(value);
        }, rejectOnce);
      }
    });
    return { result };
  } catch (error) {
    return {
      result: createCancelledSparkAskFlowResult(request),
      fallbackReason: `custom UI failed: ${formatUnknownError(error)}`,
    };
  }
}

function createCancelledSparkAskFlowResult(
  request: SparkAskFlowRequest,
  timedOut = false,
): SparkAskFlowResult {
  return createSparkAskFlowResult({
    answers: {},
    flow: request.flow,
    mode: "cancel",
    cancelled: true,
    status: "cancelled",
    ...(timedOut ? { timedOut: true } : {}),
  });
}

function once<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
  let called = false;
  return (...args: Args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function",
  );
}

function isSparkAskFlowResultLike(value: unknown): value is SparkAskFlowResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "answers" in value &&
    "mode" in value &&
    "cancelled" in value,
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;

function renderAskFlowToolCall(
  name: string,
  parts: Array<string | undefined>,
  theme: { bold?: (text: string) => string },
): { render(width: number): string[] } {
  const label = theme.bold ? theme.bold(name) : name;
  const text = [label, ...parts.filter((part): part is string => Boolean(part))].join(" ");
  return {
    render(width: number): string[] {
      return [truncateToWidth(text, Math.max(1, width), "…")];
    },
  };
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = /\s|["'`]/.test(text) ? JSON.stringify(text) : text;
  const normalized = rendered.replaceAll(/\s+/g, " ");
  const maxLength = options.maxLength ?? TOOL_CALL_DEFAULT_ARG_MAX_LENGTH;
  const truncated =
    normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
  return `${options.prefix ?? ""}${truncated}`;
}

function decodeSparkAskFlowToolContext(ctx: unknown): SparkAskFlowToolContext {
  return ctx && typeof ctx === "object" ? (ctx as SparkAskFlowToolContext) : {};
}

function requiredSparkAskFlowCwd(ctx: SparkAskFlowToolContext): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd;
  throw new Error("ask_flow fullscreen requires ctx.cwd to persist the latest ask payload.");
}

export function createSparkAskFlowResult(
  input: Omit<SparkAskFlowResult, "status" | "nextAction"> &
    Partial<Pick<SparkAskFlowResult, "status" | "nextAction">>,
): SparkAskFlowResult {
  const result = input;
  const status = result.status ?? inferSparkAskFlowResultStatus(input);
  return {
    ...result,
    status,
    nextAction: result.nextAction ?? nextActionForSparkAskFlowStatus(status, result.mode),
  };
}

export function normalizeSparkAskFlowResult(
  result: SparkAskFlowResult,
  request?: SparkAskFlowRequest,
): SparkAskFlowResult {
  const normalized = createSparkAskFlowResult(result);
  if (normalized.status === "pending") return normalized;
  if (!request || !isGateMode(request.mode)) return normalized;

  const status =
    normalized.status === "no_selection" &&
    hasSubmittedRequiredGateAnswers(request, normalized.answers)
      ? "answered"
      : normalized.status;
  const blocked = isSparkAskFlowGateBlocked({ ...normalized, status }, request);
  return {
    ...normalized,
    status,
    nextAction: blocked ? "block" : nextActionForSparkAskFlowStatus(status, normalized.mode),
  };
}

export function isSparkAskFlowGateBlocked(
  result: SparkAskFlowResult,
  request: SparkAskFlowRequest,
): boolean {
  return (
    isGateMode(request.mode) &&
    result.status !== "pending" &&
    (result.status === "no_selection" ||
      result.status === "cancelled" ||
      !hasRequiredGateSelections(request, result.answers))
  );
}

function createNoSelectionSparkAskFlowResult(
  request: SparkAskFlowRequest,
  answers: Record<string, SparkAskFlowAnswerEntry>,
): SparkAskFlowResult {
  const status = inferAskSubmitStatus(request, answers);
  return createSparkAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
    status,
    nextAction: nextActionForAskSubmit(request, answers, status),
  });
}

function toFlowAnswer(questionId: string, choice: ParsedAskChoice): SparkAskFlowAnswerEntry {
  const answer: SparkAskFlowAnswerEntry = {
    questionId,
    kind: choice.kind,
    values: choice.values,
  };
  if (choice.labels.length > 0) answer.labels = choice.labels;
  if (choice.customText !== undefined) answer.customText = choice.customText;
  if (choice.preview !== undefined) answer.preview = choice.preview;
  return answer;
}

function requiresExplicitSelection(
  request: SparkAskFlowRequest,
  question: SparkAskFlowQuestion,
): boolean {
  return requiresExplicitSelectionForGate(request.mode, question);
}

function requestRequiresExplicitSelection(request: SparkAskFlowRequest): boolean {
  return (request.questions ?? []).some((question) => requiresExplicitSelection(request, question));
}

function hasSubmittedRequiredGateAnswers(
  request: SparkAskFlowRequest,
  answers: Record<string, SparkAskFlowAnswerEntry>,
): boolean {
  return hasSubmittedRequiredAskAnswers(request, answers);
}

function hasRequiredGateSelections(
  request: SparkAskFlowRequest,
  answers: Record<string, SparkAskFlowAnswerEntry>,
): boolean {
  return hasRequiredAskSelections(request, answers);
}

function inferSparkAskFlowResultStatus(
  result: Pick<SparkAskFlowResult, "answers" | "cancelled" | "mode">,
): SparkAskFlowResult["status"] {
  if (result.cancelled || result.mode === "cancel") return "cancelled";
  if (Object.keys(result.answers).length > 0) return "answered";
  return "no_selection";
}

function nextActionForSparkAskFlowStatus(
  status: SparkAskFlowResult["status"],
  mode: SparkAskFlowResult["mode"],
): SparkAskFlowResult["nextAction"] {
  if (mode === "elaborate") return "clarify_then_reask";
  return status === "answered" || status === "pending" ? "resume" : "block";
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeFlowResult(result: SparkAskFlowResult, request?: SparkAskFlowRequest): string {
  return summarizeAskResult(request ?? { title: "Ask flow" }, result);
}
