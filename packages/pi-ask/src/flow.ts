import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";

import { PiAskFlowController } from "./ui/controller.ts";
import { createAskConfigStore } from "./config/store.ts";
import { PiAskFlowPayloadStore } from "./ask-payload-store.ts";
import type {
  PiAskFlowAnswerEntry,
  PiAskFlowQuestion,
  PiAskFlowRequest,
  PiAskFlowResult,
} from "./schema.ts";
import { validatePiAskFlowRequest } from "./schema.ts";

interface PiExtensionAPI {
  registerTool?(config: {
    name: string;
    label?: string;
    description: string;
    promptGuidelines?: string[];
    parameters: unknown;
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

export interface PiAskFlowElaborationNote {
  questionId: string;
  note: string;
}

export interface PiAskFlowArtifactBody {
  request: PiAskFlowRequest;
  result: PiAskFlowResult;
}

export function createPiAskFlowRequest(input: PiAskFlowRequest): PiAskFlowRequest {
  const validation = validatePiAskFlowRequest(input);
  if (!validation.valid) {
    throw new Error(
      `invalid ask flow request: ${validation.error}${validation.details ? ` (${validation.details})` : ""}`,
    );
  }
  return input;
}

export async function runPiAskFlow(
  input: PiAskFlowRequest,
  ui?: { select?: Function; confirm?: Function; input?: Function },
): Promise<PiAskFlowResult> {
  const request = createPiAskFlowRequest(input);
  if (!ui?.select) return defaultPiAskFlowResult(request);

  const answers: Record<string, PiAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      const text = await withTimeout<string>(ui.input?.(question.prompt), request.timeoutMs);
      if (text.timedOut) return createTimedOutPiAskFlowResult(request, answers);
      if (text.value !== undefined) {
        answers[question.id] = {
          questionId: question.id,
          kind: "freeform",
          values: [],
          customText: text.value,
        };
      }
      continue;
    }

    if (question.options && question.options.length > 0) {
      const choice = await withTimeout<string>(
        ui.select(
          question.prompt,
          question.options.map((option) => option.label),
        ),
        request.timeoutMs,
      );
      if (choice.timedOut) return createTimedOutPiAskFlowResult(request, answers);
      if (!choice.value) continue;
      const option = question.options.find((entry) => entry.label === choice.value);
      if (option) {
        answers[question.id] = {
          questionId: question.id,
          kind: question.type === "multi" ? "multi" : "option",
          values: [option.value],
          labels: [option.label],
          preview: option.preview,
        };
      } else {
        answers[question.id] = {
          questionId: question.id,
          kind: "custom",
          values: [],
          customText: choice.value,
        };
      }
    }
  }

  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
  });
}

export function defaultPiAskFlowResult(request: PiAskFlowRequest): PiAskFlowResult {
  const answers: Record<string, PiAskFlowAnswerEntry> = {};
  for (const question of request.questions ?? []) {
    if (question.type === "freeform") {
      answers[question.id] = {
        questionId: question.id,
        kind: "freeform",
        values: [],
        customText: "",
      };
      continue;
    }
    const first = question.options?.[0];
    if (!first) continue;
    answers[question.id] = {
      questionId: question.id,
      kind: question.type === "multi" ? "multi" : "option",
      values: [first.value],
      labels: [first.label],
      preview: first.preview,
    };
  }
  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
  });
}

export async function replayPiAskFlow(
  input: PiAskFlowRequest,
  prior: PiAskFlowResult | undefined,
  ui?: { select?: Function },
): Promise<PiAskFlowResult> {
  return runPiAskFlow(replayablePiAskFlow(input, prior), ui);
}

export function replayablePiAskFlow(
  input: PiAskFlowRequest,
  prior?: PiAskFlowResult,
): PiAskFlowRequest {
  if (!prior?.answers || !input.behaviour?.preservePriorAnswers) return input;
  const questions: PiAskFlowQuestion[] = (input.questions ?? []).map((question) => {
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

export function createPiAskFlowArtifactBody(
  request: PiAskFlowRequest,
  result: PiAskFlowResult,
): PiAskFlowArtifactBody {
  return { request, result: normalizePiAskFlowResult(result, request) };
}

export function isPiAskFlowArtifactBody(value: unknown): value is PiAskFlowArtifactBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object",
  );
}

export function createElaborationResult(
  prior: PiAskFlowResult,
  notes: PiAskFlowElaborationNote[],
): PiAskFlowResult {
  return createPiAskFlowResult({
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

export function registerPiAskFlowTool(pi: PiExtensionAPI): void {
  const configStore = createAskConfigStore();
  const config = configStore.load();
  const payloadStore = new PiAskFlowPayloadStore();

  pi.registerTool?.({
    name: "ask_flow",
    label: "Ask Flow",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock flow.",
    promptGuidelines: [
      "Use ask_flow when a decision needs multiple related questions.",
      "Ask focused questions and avoid broad intake forms.",
      "After a decision is confirmed, continue with the chosen action when clear.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      context: Type.Optional(Type.String()),
      questions: Type.Array(
        Type.Object({
          id: Type.String(),
          prompt: Type.String(),
          header: Type.Optional(Type.String()),
          type: Type.Optional(Type.String({ description: "single | multi | preview | freeform" })),
          required: Type.Optional(Type.Boolean()),
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
      timeoutMs: Type.Optional(Type.Number()),
    }),

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const request = createPiAskFlowRequest(rawParams as PiAskFlowRequest);
      const ui = (ctx as Record<string, unknown>).ui as
        | { custom?: (...args: unknown[]) => unknown }
        | undefined;

      if (!ui?.custom) {
        const result = createPiAskFlowResult({
          answers: {},
          flow: request.flow,
          mode: "cancel",
          cancelled: true,
          status: "cancelled",
        });
        return {
          content: [{ type: "text" as const, text: summarizeFlowResult(result) }],
          details: { result, status: result.status, cancelled: true, mode: "cancel" },
        };
      }

      const cwd =
        typeof (ctx as Record<string, unknown>).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();

      const result = await new Promise<PiAskFlowResult>((resolve) => {
        const controller = new PiAskFlowController({ request, language: "en" });
        const cb = (tui: unknown, theme: unknown, _keybindings: unknown, done: () => void) => {
          const view = controller.run(
            tui as Parameters<typeof controller.run>[0],
            theme as Parameters<typeof controller.run>[1],
            (flowResult: PiAskFlowResult) => {
              done();
              resolve(flowResult);
            },
          );
          return view;
        };
        (ui.custom as Function)("pi-ask-flow", cb, { placement: "fullScreen" });
      });

      const normalizedResult = normalizePiAskFlowResult(result, request);
      await payloadStore.save(cwd, { request, result: normalizedResult, timestamp: Date.now() });

      return {
        content: [{ type: "text" as const, text: summarizeFlowResult(normalizedResult) }],
        details: {
          result: normalizedResult as unknown as Record<string, unknown>,
          status: normalizedResult.status,
          cancelled: normalizedResult.cancelled,
          mode: normalizedResult.mode,
        },
      };
    },
  });

  pi.registerCommand?.("ask-settings", {
    description: "Open Pi ask settings",
    async handler(_args: string, ctx: unknown) {
      const raw = ctx as Record<string, unknown>;
      const ui = raw.ui as { select?: Function; notify?: Function; confirm?: Function } | undefined;
      if (!ui?.select) return;

      const choice = await ui.select("Pi Ask Settings", [
        "View config path",
        "Toggle auto-submit",
        "Toggle confirm-dismiss",
        "Reset to defaults",
        "<- Back",
      ]);
      if (!choice || choice === "<- Back") return;

      if (choice === "View config path") {
        ui.notify?.(
          `Config: ${join(homedir(), ".pi", "agent", "extensions", "pi-ask.json")}`,
          "info",
        );
      } else if (choice === "Toggle auto-submit") {
        config.behaviour.autoSubmitWhenAnsweredWithoutNotes =
          !config.behaviour.autoSubmitWhenAnsweredWithoutNotes;
        configStore.save(config);
        ui.notify?.(
          `Auto-submit ${config.behaviour.autoSubmitWhenAnsweredWithoutNotes ? "enabled" : "disabled"}`,
          "success",
        );
      } else if (choice === "Toggle confirm-dismiss") {
        config.behaviour.confirmDismissWhenDirty = !config.behaviour.confirmDismissWhenDirty;
        configStore.save(config);
        ui.notify?.(
          `Confirm-dismiss ${config.behaviour.confirmDismissWhenDirty ? "enabled" : "disabled"}`,
          "success",
        );
      } else if (choice === "Reset to defaults") {
        const confirmed = await ui.confirm?.(
          "Reset all pi-ask settings?",
          "This cannot be undone.",
        );
        if (confirmed) {
          const defaults = createAskConfigStore().load();
          Object.assign(config, defaults);
          configStore.save(config);
          ui.notify?.("Settings reset to defaults", "success");
        }
      }
    },
  });
}

export function createPiAskFlowResult(
  input: Omit<PiAskFlowResult, "status" | "nextAction"> &
    Partial<Pick<PiAskFlowResult, "status" | "nextAction">> & { timeoutMs?: number },
): PiAskFlowResult {
  const { timeoutMs: _timeoutMs, ...result } = input;
  const status = result.status ?? inferPiAskFlowResultStatus(input);
  return {
    ...result,
    status,
    nextAction: result.nextAction ?? nextActionForPiAskFlowStatus(status, result.mode),
  };
}

export function normalizePiAskFlowResult(
  result: PiAskFlowResult,
  request?: PiAskFlowRequest,
): PiAskFlowResult {
  return createPiAskFlowResult({ ...result, timeoutMs: request?.timeoutMs });
}

export function isPiAskFlowGateBlocked(
  result: PiAskFlowResult,
  request: PiAskFlowRequest,
): boolean {
  return (
    (request.mode === "decision" || request.mode === "approval") &&
    (result.status === "timeout" ||
      result.status === "no_selection" ||
      result.status === "cancelled")
  );
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

function createTimedOutPiAskFlowResult(
  request: PiAskFlowRequest,
  answers: Record<string, PiAskFlowAnswerEntry>,
): PiAskFlowResult {
  return createPiAskFlowResult({
    answers,
    flow: request.flow,
    mode: "submit",
    cancelled: false,
    status: Object.keys(answers).length > 0 ? "answered" : "timeout",
  });
}

function inferPiAskFlowResultStatus(
  result: Pick<PiAskFlowResult, "answers" | "cancelled" | "mode"> & { timeoutMs?: number },
): PiAskFlowResult["status"] {
  if (result.cancelled || result.mode === "cancel") return "cancelled";
  if (Object.keys(result.answers).length > 0) return "answered";
  return result.timeoutMs && result.timeoutMs > 0 ? "timeout" : "no_selection";
}

function nextActionForPiAskFlowStatus(
  status: PiAskFlowResult["status"],
  mode: PiAskFlowResult["mode"],
): PiAskFlowResult["nextAction"] {
  if (mode === "elaborate") return "clarify_then_reask";
  return status === "answered" ? "resume" : "block";
}

function summarizeFlowResult(result: PiAskFlowResult): string {
  const answered = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  if (result.status !== "answered") {
    return `Ask flow ${result.status}: ${answered.join("; ") || "no answers"}`;
  }
  return `Ask flow ${result.mode}: ${answered.join("; ") || "no answers"}`;
}
