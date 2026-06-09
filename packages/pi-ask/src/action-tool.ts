import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent, ToolRenderTheme } from "pi-extension-api";

export type PiAskAction = "ask" | "flow";

export interface PiAskActionToolApi {
  registerTool(config: ToolConfig): void;
}

export interface PiAskActionToolOptions {
  resolveTool(name: "ask_user" | "ask_flow"): ToolConfig | undefined;
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [
      this.text.length > width ? `${this.text.slice(0, Math.max(0, width - 1))}…` : this.text,
    ];
  }
}

export function registerPiAskActionTool(
  pi: PiAskActionToolApi,
  options: PiAskActionToolOptions,
): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Canonical ask capability. Use action=ask for a structured user ask; action=flow forces the fullscreen multi-question ask_flow renderer.",
    promptGuidelines: [
      "Use ask as the canonical user-question tool instead of choosing between ask_user and ask_flow directly.",
      "Ask only context-specific questions whose answers change the next action, plan, dependency, priority, or success criteria.",
      "Use freeform questions for notes/context; do not create business options named Other or Type your own.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "ask | flow. Defaults to ask." })),
      title: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.String({ description: "clarification | decision | approval | unblock" }),
      ),
      context: Type.Optional(Type.String()),
      flow: Type.Optional(Type.String({ description: "Stable flow identifier for ask_flow." })),
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
      behaviour: Type.Optional(
        Type.Object({
          allowElaborate: Type.Optional(Type.Boolean()),
          allowReplay: Type.Optional(Type.Boolean()),
          preservePriorAnswers: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderAskCall(args, theme);
    },
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeAskAction(params.action);
      const target = selectAskTarget(action, params);
      const tool = options.resolveTool(target);
      if (!tool) throw new Error(`ask action adapter could not find ${target}`);
      return tool.execute(toolCallId, stripAction(params), signal, onUpdate, ctx);
    },
  });
}

function normalizeAskAction(value: unknown): PiAskAction {
  if (value === undefined || value === null || value === "ask") return "ask";
  if (value === "flow") return "flow";
  throw new Error("ask.action must be ask or flow");
}

function selectAskTarget(
  action: PiAskAction,
  params: Record<string, unknown>,
): "ask_user" | "ask_flow" {
  if (action === "flow") return "ask_flow";
  if (typeof params.flow === "string" && params.flow.trim()) return "ask_flow";
  if (params.behaviour !== undefined) return "ask_flow";
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length !== 1) return "ask_flow";
  const [question] = questions as Array<Record<string, unknown>>;
  if (question?.header !== undefined || question?.type === "preview") return "ask_flow";
  if (Array.isArray(question?.options) && question.options.some((option) => hasPreview(option))) {
    return "ask_flow";
  }
  return "ask_user";
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return rest;
}

function hasPreview(value: unknown): boolean {
  return typeof value === "object" && value !== null && "preview" in value;
}

function renderAskCall(args: Record<string, unknown>, theme: ToolRenderTheme): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "ask";
  const title = typeof args.title === "string" ? args.title : undefined;
  const questionCount = Array.isArray(args.questions) ? `${args.questions.length}q` : undefined;
  const text = ["ask", `action=${action}`, title, questionCount].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
