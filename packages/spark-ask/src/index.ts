/**
 * spark-ask — Self-built structured ask tool for Spark.
 * Replaces pi-ask dependency with own TUI, renderer, state machine, and key routing.
 */

import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedAgentProposal } from "spark-core";

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
import { AskFlowController } from "./ui/controller.ts";
import { createAskConfigStore } from "./config/store.ts";
import { SparkAskPayloadStore } from "./ask-payload-store.ts";
import { clarifyThreadCopy, detectCopyLanguage, type SparkCopyLanguage } from "./copy.ts";
import type {
  SparkAskRequest,
  SparkAskResult,
  SparkAskQuestion,
  SparkAskAnswerEntry,
} from "./schema.ts";
import { validateSparkAskRequest } from "./schema.ts";

export { clarifyThreadCopy, detectCopyLanguage } from "./copy.ts";
export type { SparkCopyLanguage } from "./copy.ts";
export { createAskConfigStore } from "./config/store.ts";
export { AskFlowController } from "./ui/controller.ts";
export { createInitialState, buildExtendedOptions } from "./state/state.ts";
export type { AskState } from "./state/state.ts";
export { reduce } from "./state/reducer.ts";
export type { AskAction, Effect } from "./state/reducer.ts";
export { routeKey } from "./state/key-router.ts";
export { renderAskScreen } from "./ui/render.ts";
export type { RenderTheme, AskUILanguage } from "./ui/render.ts";
export { validateSparkAskRequest } from "./schema.ts";
export type {
  SparkAskOption,
  SparkAskQuestion,
  SparkAskQuestionTypeVal,
  SparkAskRequest,
  SparkAskResult,
  SparkAskAnswerEntry,
  SparkAskAnswerKind,
  SparkAskValidationError,
} from "./schema.ts";
export { SparkAskPayloadStore } from "./ask-payload-store.ts";

// ---- Flows ----

export type SparkAskFlow =
  | "clarify-thread"
  | "approve-managed-agent"
  | "resolve-task-blocker"
  | "review-gate"
  | "custom";

export interface SparkAskBehaviour {
  allowElaborate?: boolean;
  allowReplay?: boolean;
  preservePriorAnswers?: boolean;
}

export interface SparkAskElaborationNote {
  questionId: string;
  note: string;
}

export interface SparkAskArtifactBody {
  request: SparkAskRequest;
  result: SparkAskResult;
}

// ---- API (backward-compatible) ----

export function createSparkAskRequest(input: SparkAskRequest): SparkAskRequest {
  return input;
}

export async function runSparkAsk(
  input: SparkAskRequest,
  ui?: { select?: Function; confirm?: Function; input?: Function },
): Promise<SparkAskResult> {
  // delegate to the TUI controller through the extension's custom UI
  // In practice, the extension calls this via the spark_ask tool which uses custom UI
  if (!ui?.select) {
    return {
      answers: {},
      mode: "cancel",
      cancelled: true,
      nextAction: "block",
    };
  }

  // Simplified headless fallback using select prompts
  const answers: Record<string, SparkAskAnswerEntry> = {};
  for (const q of input.questions ?? []) {
    if (q.type === "freeform") {
      const text = await ui.input?.(q.prompt);
      if (text) {
        answers[q.id] = {
          questionId: q.id,
          kind: "freeform",
          values: [],
          customText: text,
        };
      }
    } else if (q.options && q.options.length > 0) {
      const choice = await ui.select(
        q.prompt,
        q.options.map((o) => o.label),
      );
      if (choice) {
        const option = q.options.find((o) => o.label === choice);
        if (option) {
          answers[q.id] = {
            questionId: q.id,
            kind: "option",
            values: [option.value],
          };
        }
      }
    }
  }

  return {
    answers,
    flow: input.flow,
    mode: "submit",
    cancelled: false,
    nextAction: "resume",
  };
}

export async function replaySparkAsk(
  input: SparkAskRequest,
  prior: SparkAskResult | undefined,
  ui?: { select?: Function },
): Promise<SparkAskResult> {
  return runSparkAsk(replayableSparkAsk(input, prior), ui);
}

export function replayableSparkAsk(
  input: SparkAskRequest,
  prior?: SparkAskResult,
): SparkAskRequest {
  if (!prior?.answers || !input.behaviour?.preservePriorAnswers) return input;
  const questions: SparkAskQuestion[] = (input.questions ?? []).map((q) => {
    const existing = prior.answers[q.id];
    if (!existing || q.type === "freeform") return q;
    const options = q.options?.map((o) => ({
      ...o,
      description: existing.values.includes(o.value)
        ? `${o.description ?? ""}${o.description ? "\n" : ""}Previously selected.`
        : o.description,
    }));
    return { ...q, options };
  });
  return { ...input, questions };
}

export function createSparkAskArtifactBody(
  request: SparkAskRequest,
  result: SparkAskResult,
): SparkAskArtifactBody {
  return { request, result };
}

export function isSparkAskArtifactBody(value: unknown): value is SparkAskArtifactBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { request?: unknown }).request === "object" &&
    typeof (value as { result?: unknown }).result === "object",
  );
}

export function createElaborationResult(
  prior: SparkAskResult,
  notes: SparkAskElaborationNote[],
): SparkAskResult {
  return {
    ...prior,
    mode: "elaborate",
    elaboration: {
      affectedQuestionIds: notes.map((n) => n.questionId),
      preservedAnswers: prior.answers,
      notes,
    },
    nextAction: "clarify_then_reask",
  };
}

// ---- Preset flows ----

export function clarifyThreadAsk(input: {
  idea: string;
  title?: string;
  timeoutMs?: number;
  defaultLanguage?: SparkCopyLanguage;
}): SparkAskRequest {
  const copy = clarifyThreadCopy({
    language: input.defaultLanguage ?? detectCopyLanguage(input.idea),
  });
  return {
    mode: "clarification",
    title: input.title ?? copy.title,
    context: input.idea,
    timeoutMs: input.timeoutMs,
    questions: copy.questions as SparkAskQuestion[],
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function approveManagedAgentAsk(input: {
  proposal: ManagedAgentProposal;
  timeoutMs?: number;
}): SparkAskRequest {
  return {
    mode: "approval",
    title: `Approve managed agent: ${input.proposal.id}`,
    context: [
      input.proposal.description,
      input.proposal.rationale,
      `Expected uses: ${input.proposal.expectedUses.join(", ")}`,
    ].join("\n"),
    timeoutMs: input.timeoutMs,
    questions: [
      {
        id: "approval",
        prompt: `Create managed agent ${input.proposal.id}?`,
        type: "single" as const,
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      },
      {
        id: "note",
        prompt: "Any note for the agent proposal?",
        type: "freeform" as const,
      },
    ],
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function resolveTaskBlockerAsk(input: {
  taskTitle: string;
  blocker: string;
  timeoutMs?: number;
}): SparkAskRequest {
  return {
    mode: "unblock",
    title: `Resolve blocker: ${input.taskTitle}`,
    context: input.blocker,
    timeoutMs: input.timeoutMs,
    questions: [
      {
        id: "decision",
        prompt: `How should Spark proceed for ${input.taskTitle}?`,
        type: "single" as const,
        required: true,
        options: [
          { value: "resume", label: "Resume with chosen direction" },
          { value: "block", label: "Keep blocked" },
          { value: "replan", label: "Replan this task" },
        ],
      },
      {
        id: "explanation",
        prompt: "Any extra context for the unblock decision?",
        type: "freeform" as const,
      },
    ],
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

export function reviewGateAsk(input: {
  subject: string;
  summary: string;
  timeoutMs?: number;
}): SparkAskRequest {
  return {
    mode: "decision",
    title: `Review gate: ${input.subject}`,
    context: input.summary,
    timeoutMs: input.timeoutMs,
    questions: [
      {
        id: "gate",
        prompt: `What should happen for ${input.subject}?`,
        type: "single" as const,
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "needs_changes", label: "Needs changes" },
          { value: "block", label: "Block" },
        ],
      },
      {
        id: "reason",
        prompt: "Why?",
        type: "freeform" as const,
        required: true,
      },
    ],
    behaviour: { allowElaborate: true, allowReplay: true, preservePriorAnswers: true },
  };
}

// ---- Extension tool registration ----

export function registerSparkAskTool(pi: PiExtensionAPI): void {
  const configStore = createAskConfigStore();
  const config = configStore.load();
  const payloadStore = new SparkAskPayloadStore();

  pi.registerTool?.({
    name: "spark_ask",
    label: "Spark Ask",
    description: `Ask the user a structured clarification, decision, approval, or unblock question.

Use this tool when the user's intent is ambiguous, a decision has trade-offs, or you need approval before proceeding.

## Question Types
- **single**: Pick one option from a list (mutually exclusive)
- **multi**: Select multiple options (checkboxes)
- **preview**: Options with detailed preview content (code/markdown)
- **freeform**: Free-text answer (no predefined options)

## Behavior
- Each question appears as a tab in the dialog
- Navigate with Tab/arrows, select with Enter/Space
- Press 'n' to add notes to any option
- Review tab shows all answers before submission
- Esc or Ctrl+C cancels the ask`,
    promptGuidelines: [
      "When user intent is ambiguous, use spark_ask instead of guessing.",
      "Ask focused, single-decision questions — one question per tab.",
      "Provide 2-6 distinct, mutually exclusive options per single-select question.",
      "Use multi-select when multiple answers could reasonably apply.",
      "After a decision is confirmed, continue with that action — do not re-ask.",
    ],
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      question: Type.String({ description: "The question to ask the user" }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            label: Type.String(),
            description: Type.Optional(Type.String()),
            preview: Type.Optional(Type.String()),
          }),
        ),
      ),
      multiSelect: Type.Optional(Type.Boolean({ default: false })),
      defaultOptionId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),

    async execute(
      _toolCallId: unknown,
      rawParams: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const params = rawParams as {
        kind?: string;
        question: string;
        options?: Array<{ id: string; label: string; description?: string; preview?: string }>;
        multiSelect?: boolean;
        timeoutMs?: number;
      };

      const mode =
        params.kind === "decision"
          ? "decision"
          : params.kind === "approval"
            ? "approval"
            : params.kind === "unblock"
              ? "unblock"
              : "clarification";

      const isMulti = params.multiSelect === true;
      const hasPreviews = params.options?.some((o: { preview?: string }) => o.preview);
      const questionType: SparkAskQuestion["type"] = params.options
        ? hasPreviews
          ? "preview"
          : isMulti
            ? "multi"
            : "single"
        : "freeform";

      const request: SparkAskRequest = {
        mode,
        questions: [
          {
            id: "answer",
            prompt: params.question,
            header: params.kind
              ? params.kind.charAt(0).toUpperCase() + params.kind.slice(1)
              : "Question",
            type: questionType,
            required: true,
            options: params.options?.map(
              (o: { id: string; label: string; description?: string; preview?: string }) => ({
                value: o.id,
                label: o.label,
                description: o.description,
                preview: o.preview,
              }),
            ),
          },
        ],
        timeoutMs: params.timeoutMs,
      };

      const ui = (ctx as Record<string, unknown>).ui as
        | { custom?: (...args: unknown[]) => unknown }
        | undefined;

      if (!ui?.custom) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Ask cancelled: no UI available. Question: ${params.question}`,
            },
          ],
          details: { cancelled: true, mode: "cancel" },
        };
      }

      const cwd: string =
        typeof (ctx as Record<string, unknown>).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();

      const result = await new Promise<SparkAskResult>((resolve) => {
        const controller = new AskFlowController({ request, language: "en" });

        const cb = (tui: unknown, theme: unknown, _keybindings: unknown, done: () => void) => {
          const { render, invalidate } = controller.run(
            tui as Parameters<typeof controller.run>[0],
            theme as Parameters<typeof controller.run>[1],
            (r: SparkAskResult) => {
              done();
              resolve(r);
            },
          );
          return { render, invalidate };
        };

        (ui.custom as Function)("spark-ask", cb, { placement: "fullScreen" });
      });

      payloadStore.save(cwd, { request, result, timestamp: Date.now() });

      if (result.cancelled) {
        return {
          content: [{ type: "text" as const, text: "Ask cancelled." }],
          details: { cancelled: true, mode: result.mode },
        };
      }

      const answer = result.answers["answer"];
      let text = "No answer.";
      if (answer) {
        switch (answer.kind) {
          case "option":
            text = `Selected: ${answer.values[0] ?? "?"}`;
            break;
          case "multi":
            text = `Selected: ${answer.values.join(", ")}`;
            break;
          case "custom":
            text = `Answer: ${answer.customText ?? ""}`;
            break;
          case "freeform":
            text = `Answer: ${answer.customText ?? ""}`;
            break;
        }
        if (answer.notes) text += `\nNotes: ${answer.notes}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { result: result as unknown as Record<string, unknown>, mode: result.mode },
      };
    },
  });

  // /ask-settings command
  pi.registerCommand?.("ask-settings", {
    description: "Open Spark ask settings",
    async handler(_args: string, ctx: unknown) {
      const raw = ctx as Record<string, unknown>;
      const ui = raw.ui as { select?: Function; notify?: Function; confirm?: Function } | undefined;
      if (!ui?.select) return;

      const choice = await ui.select("Spark Ask Settings", [
        "View config path",
        "Toggle auto-submit",
        "Toggle confirm-dismiss",
        "Reset to defaults",
        "← Back",
      ]);
      if (!choice || choice === "← Back") return;

      if (choice === "View config path") {
        ui.notify?.(
          `Config: ${join(homedir(), ".pi", "agent", "extensions", "spark-ask.json")}`,
          "info",
        );
      } else if (choice === "Toggle auto-submit") {
        config.behaviour.autoSubmitWhenAnsweredWithoutNotes =
          !config.behaviour.autoSubmitWhenAnsweredWithoutNotes;
        configStore.save(config);
        ui.notify?.(
          "Auto-submit " +
            (config.behaviour.autoSubmitWhenAnsweredWithoutNotes ? "enabled" : "disabled"),
          "success",
        );
      } else if (choice === "Toggle confirm-dismiss") {
        config.behaviour.confirmDismissWhenDirty = !config.behaviour.confirmDismissWhenDirty;
        configStore.save(config);
        ui.notify?.(
          "Confirm-dismiss " + (config.behaviour.confirmDismissWhenDirty ? "enabled" : "disabled"),
          "success",
        );
      } else if (choice === "Reset to defaults") {
        const confirmed = await ui.confirm?.(
          "Reset all spark-ask settings?",
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
