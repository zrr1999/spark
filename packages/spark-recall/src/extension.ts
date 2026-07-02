import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-extension-api";
import {
  defaultRecallStore,
  type RecallCandidate,
  type RecallScope,
  type RecallStorePaths,
} from "./index.ts";

export type PiRecallAction = "record_candidate" | "list" | "search" | "reject";

export interface PiRecallExtensionApi {
  registerTool(config: ToolConfig): void;
}

export interface PiRecallToolOptions {
  storePaths?: RecallStorePaths;
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

export function registerPiRecallTool(
  pi: PiRecallExtensionApi,
  options: PiRecallToolOptions = {},
): void {
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Canonical controlled recall candidate tool. Explicitly record, list, search, or reject scoped recall candidates.",
    promptGuidelines: [
      "Use recall only for explicit user/workspace/repo scoped recall candidates; do not silently write memory.",
      "Use learning for evidence-backed reusable rules; recall is lightweight candidate memory and remains separate.",
      "Always provide scope and reason when recording recall candidates.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "record_candidate | list | search | reject" }),
      scope: Type.String({ description: "user | workspace | repo" }),
      text: Type.Optional(
        Type.String({ description: "Candidate recall text for record_candidate." }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Why to record/reject this recall candidate." }),
      ),
      evidenceRefs: Type.Optional(Type.Array(Type.String())),
      query: Type.Optional(Type.String({ description: "Search query." })),
      id: Type.Optional(Type.String({ description: "Recall candidate id for reject." })),
      includeRejected: Type.Optional(
        Type.Boolean({ description: "Include rejected candidates in list." }),
      ),
    }),
    renderCall(args, theme) {
      return renderRecallCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredCwd(ctx);
      const action = normalizeRecallAction(params.action);
      const scope = normalizeRecallScope(params.scope);
      const store = defaultRecallStore(cwd, scope, options.storePaths);
      if (action === "record_candidate") {
        const candidate = await store.record({
          scope,
          text: requiredString(params.text, "text"),
          reason: requiredString(params.reason, "reason"),
          evidenceRefs: normalizeStringArray(params.evidenceRefs, "evidenceRefs"),
        });
        return result(`Recorded recall candidate ${candidate.id} (${scope}).`, { candidate });
      }
      if (action === "search") {
        const candidates = await store.search(requiredString(params.query, "query"));
        return result(renderCandidates(candidates, "Search recall candidates"), { candidates });
      }
      if (action === "reject") {
        const candidate = await store.reject(
          requiredString(params.id, "id"),
          requiredString(params.reason, "reason"),
        );
        return result(`Rejected recall candidate ${candidate.id}.`, { candidate });
      }
      const includeRejected = normalizeBoolean(params.includeRejected, false, "includeRejected");
      const candidates = (await store.list()).filter(
        (candidate) => includeRejected || candidate.status === "candidate",
      );
      return result(renderCandidates(candidates, `Recall candidates (${scope})`), { candidates });
    },
  });
}

export default function piRecallExtension(
  pi: PiRecallExtensionApi,
  options: PiRecallToolOptions = {},
): void {
  registerPiRecallTool(pi, options);
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function renderCandidates(candidates: RecallCandidate[], title: string): string {
  if (candidates.length === 0) return `${title}: none`;
  return [
    title,
    ...candidates.map((candidate) => `- [${candidate.status}] ${candidate.id}: ${candidate.text}`),
  ].join("\n");
}

function normalizeRecallAction(value: unknown): PiRecallAction {
  if (
    value === "record_candidate" ||
    value === "list" ||
    value === "search" ||
    value === "reject"
  ) {
    return value;
  }
  throw new Error("recall.action must be record_candidate, list, search, or reject");
}

function normalizeRecallScope(value: unknown): RecallScope {
  if (value === "user" || value === "workspace" || value === "repo") return value;
  throw new Error("recall.scope must be user, workspace, or repo");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`recall.${field} is required`);
  return value;
}

function normalizeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`recall.${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`recall.${field}[${index}] must be a string`);
    return entry;
  });
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`recall.${field} must be a boolean`);
  return value;
}

function requiredCwd(ctx: unknown): string {
  const cwd =
    typeof (ctx as { cwd?: unknown })?.cwd === "string" ? (ctx as { cwd: string }).cwd : "";
  if (!cwd.trim()) throw new Error("recall requires ctx.cwd");
  return cwd;
}

function renderRecallCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const text = ["recall", `action=${action}`, scope].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
