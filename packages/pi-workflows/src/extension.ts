import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/pi-extension-api";
import { listSavedWorkflows, readSavedWorkflow, type WorkflowDescriptor } from "./index.ts";

export type PiWorkflowAction = "list" | "read";

export interface PiWorkflowExtensionApi {
  registerTool(config: ToolConfig): void;
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

export function registerPiWorkflowTool(pi: PiWorkflowExtensionApi): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Canonical workflow discovery tool. List or read builtin workflows and saved scripts from controlled workspace/user roots; inline workflows are not accepted.",
    promptGuidelines: [
      "Use workflow for builtin/saved-script discovery and preview only; goal state is separate and not a workflow.",
      "Do not pass inline workflow source or arbitrary paths; use builtin:<id>, workspace:<id>, or user:<id> selectors.",
      "Execute workflows through the host's explicit workflow command/runtime, not by evaluating scripts from this tool.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | read" }),
      selector: Type.Optional(
        Type.String({ description: "builtin:<id>, workspace:<id>, or user:<id> for read." }),
      ),
      includeUser: Type.Optional(
        Type.Boolean({ description: "Include user workflows. Defaults to true." }),
      ),
      maxChars: Type.Optional(Type.Number({ description: "For read: script preview max chars." })),
      limit: Type.Optional(
        Type.Number({ description: "For list: maximum workflow rows. Default 20." }),
      ),
    }),
    renderCall(args, theme) {
      return renderWorkflowCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredCwd(ctx);
      const action = normalizeWorkflowAction(params.action);
      const includeUser = normalizeBoolean(params.includeUser, true, "includeUser");
      if (action === "list") {
        const listing = await listSavedWorkflows(cwd, { includeUser });
        const limit = normalizePositiveInteger(params.limit, 20, "limit");
        const visible = listing.workflows.slice(0, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: renderWorkflowList(visible, listing.workflows.length),
            },
          ],
          details: {
            count: listing.workflows.length,
            shown: visible.length,
            workflows: visible,
          } as unknown as Record<string, unknown>,
        };
      }
      const selector = requiredString(params.selector, "selector");
      const maxChars = normalizePositiveInteger(params.maxChars, 4_000, "maxChars");
      const { descriptor, script } = await readSavedWorkflow({ cwd, selector, includeUser });
      const body = truncate(script, maxChars);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${descriptor.selector}: ${descriptor.title}`,
              descriptor.description,
              "",
              body,
            ].join("\n"),
          },
        ],
        details: {
          descriptor,
          scriptChars: script.length,
          shownChars: body.length,
          truncated: body.length < script.length,
        },
      };
    },
  });
}

export default function piWorkflowExtension(pi: PiWorkflowExtensionApi): void {
  registerPiWorkflowTool(pi);
}

function renderWorkflowList(workflows: WorkflowDescriptor[], total: number): string {
  if (total === 0) return "No saved workflows found.";
  const lines = [
    `Workflows: ${total}${workflows.length < total ? ` (showing ${workflows.length})` : ""}`,
    ...workflows.map(
      (workflow) =>
        `- ${workflow.selector}: ${workflow.title} (${workflow.phases.length} phase(s))`,
    ),
  ];
  if (workflows.length < total)
    lines.push(
      `- … ${total - workflows.length} more workflow(s); increase limit for a larger bounded sample.`,
    );
  return lines.join("\n");
}

function normalizeWorkflowAction(value: unknown): PiWorkflowAction {
  if (value === "list" || value === "read") return value;
  throw new Error("workflow.action must be list or read");
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`workflow.${field} must be a boolean`);
  return value;
}

function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`workflow.${field} must be a positive integer`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`workflow.${field} is required`);
  return value;
}

function requiredCwd(ctx: unknown): string {
  const cwd =
    typeof (ctx as { cwd?: unknown })?.cwd === "string" ? (ctx as { cwd: string }).cwd : "";
  if (!cwd.trim()) throw new Error("workflow requires ctx.cwd");
  return cwd;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function renderWorkflowCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const selector = typeof args.selector === "string" ? args.selector : undefined;
  const text = ["workflow", `action=${action}`, selector].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
