import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent, ToolRenderTheme } from "pi-extension-api";

export type PiLearningAction =
  | "record"
  | "search"
  | "list"
  | "read"
  | "mark_stale"
  | "supersede"
  | "reject"
  | "export_markdown"
  | "import_markdown";

type ToolExecute = ToolConfig["execute"];
type ToolOnUpdate = Parameters<ToolExecute>[3];
type ToolContext = Parameters<ToolExecute>[4];

export type PiLearningToolResult = Awaited<ReturnType<ToolExecute>>;

export interface PiLearningActionHandlerArgs {
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onUpdate: ToolOnUpdate;
  ctx: ToolContext;
}

export type PiLearningActionHandler = (
  args: PiLearningActionHandlerArgs,
) => Promise<PiLearningToolResult>;

export type PiLearningToolHandlers = Partial<Record<PiLearningAction, PiLearningActionHandler>>;

export interface PiLearningExtensionApi {
  registerTool(config: ToolConfig): void;
}

export interface PiLearningToolOptions {
  handlers: PiLearningToolHandlers;
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

const LEARNING_ACTIONS: readonly PiLearningAction[] = [
  "record",
  "search",
  "list",
  "read",
  "mark_stale",
  "supersede",
  "reject",
  "export_markdown",
  "import_markdown",
];

export function registerPiLearningTool(
  pi: PiLearningExtensionApi,
  options: PiLearningToolOptions,
): void {
  pi.registerTool({
    name: "learning",
    label: "Learning",
    description:
      "Canonical evidence-backed learning capability. Record, search, read, lifecycle-manage, export, or import local learnings.",
    promptGuidelines: [
      "Use learning as the canonical evidence-backed reusable learning tool.",
      "Do not use learning for automatic conversational memory; recall/memory is a separate capability.",
      "Keep repo/workspace learnings local-only under plural .learnings/ unless explicitly exported for review/sharing.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "record | search | list | read | mark_stale | supersede | reject | export_markdown | import_markdown",
      }),
      id: Type.Optional(Type.String({ description: "Stable learning id for record." })),
      ref: Type.Optional(Type.String({ description: "Learning artifact ref or stable id." })),
      title: Type.Optional(Type.String({ description: "Learning title for record." })),
      statement: Type.Optional(Type.String({ description: "Reusable judgment/rule for record." })),
      category: Type.Optional(
        Type.String({ description: "pattern | gotcha | decision | workflow | tool | project" }),
      ),
      location: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      status: Type.Optional(Type.Any({ description: "Learning status or status list." })),
      applicability: Type.Optional(Type.String()),
      nonApplicability: Type.Optional(Type.String()),
      rationale: Type.Optional(Type.String()),
      evidenceRefs: Type.Optional(Type.Array(Type.String())),
      sourcePaths: Type.Optional(Type.Array(Type.String())),
      sourceHash: Type.Optional(Type.String()),
      sourceContent: Type.Optional(Type.String()),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      supersedes: Type.Optional(Type.Array(Type.String())),
      contradictedBy: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      confidence: Type.Optional(Type.Number()),
      query: Type.Optional(Type.String({ description: "Search query." })),
      tag: Type.Optional(Type.String({ description: "Tag filter." })),
      includeCandidates: Type.Optional(Type.Boolean()),
      includeInactive: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
      full: Type.Optional(Type.Boolean()),
      maxChars: Type.Optional(Type.Number()),
      reason: Type.Optional(Type.String({ description: "Lifecycle transition reason." })),
      supersededBy: Type.Optional(Type.Array(Type.String())),
      outputPath: Type.Optional(Type.String({ description: "Markdown export output path." })),
      inputPath: Type.Optional(Type.String({ description: "Markdown import input path." })),
      apply: Type.Optional(Type.Boolean()),
      deleteLegacyAfterVerifiedExport: Type.Optional(Type.Boolean()),
      verificationExportPath: Type.Optional(Type.String()),
    }),
    renderCall(args, theme) {
      return renderLearningCall(args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeLearningAction(params.action);
      const handler = options.handlers[action];
      if (!handler) throw new Error(`learning action is not available in this host: ${action}`);
      return handler({ toolCallId, params, signal, onUpdate, ctx });
    },
  });
}

function normalizeLearningAction(value: unknown): PiLearningAction {
  if (LEARNING_ACTIONS.includes(value as PiLearningAction)) return value as PiLearningAction;
  throw new Error(`learning.action must be one of: ${LEARNING_ACTIONS.join(", ")}`);
}

function renderLearningCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const title = typeof args.title === "string" ? args.title : undefined;
  const query = typeof args.query === "string" ? args.query : undefined;
  const text = ["learning", `action=${action}`, ref ?? title ?? query].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
