import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-extension-api";
import {
  defaultSparkMemoryStore,
  normalizeSparkMemoryCategory,
  normalizeSparkMemoryScope,
  renderSparkMemoryCheckpoint,
  renderSparkMemoryPolicy,
  type SparkMemoryCategory,
  type SparkMemoryEntry,
  type SparkMemoryScope,
  type SparkMemoryStorePaths,
} from "./index.ts";

export type SparkMemoryAction = "remember" | "recall" | "search" | "status" | "forget";

export interface SparkMemoryExtensionApi {
  registerTool(config: ToolConfig): void;
  on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
}

export interface SparkMemoryToolOptions {
  storePaths?: SparkMemoryStorePaths;
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

export function registerSparkMemoryTool(
  pi: SparkMemoryExtensionApi,
  options: SparkMemoryToolOptions = {},
): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Unified explicit Spark memory capability. Remember, recall, search, inspect status, or forget scoped memory entries.",
    promptGuidelines: [
      renderSparkMemoryPolicy(),
      "Keep learning and recall tools stable; use memory when the user asks for unified durable memory.",
      "Memory writes are explicit and secret-scanned. Do not store credentials or hidden chain-of-thought.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "remember | recall | search | status | forget" }),
      scope: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      category: Type.Optional(
        Type.String({
          description: "failure | correction | insight | preference | convention | tool-quirk",
        }),
      ),
      text: Type.Optional(Type.String({ description: "Memory text for action=remember." })),
      reason: Type.Optional(
        Type.String({ description: "Why to remember, or why to forget this entry." }),
      ),
      evidenceRefs: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      query: Type.Optional(
        Type.String({ description: "Keyword query for search/recall filtering." }),
      ),
      id: Type.Optional(Type.String({ description: "Memory entry id for forget." })),
      includeForgotten: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
    }),
    renderCall(args, theme) {
      return renderMemoryCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredCwd(ctx);
      const action = normalizeMemoryAction(params.action);
      const scope = normalizeOptionalScope(params.scope) ?? "workspace";
      const store = defaultSparkMemoryStore(cwd, scope, options.storePaths);

      if (action === "remember") {
        const entry = await store.remember({
          scope,
          category: normalizeSparkMemoryCategory(params.category),
          text: requiredString(params.text, "text"),
          reason: requiredString(params.reason, "reason"),
          evidenceRefs: normalizeStringArray(params.evidenceRefs, "evidenceRefs"),
          tags: normalizeStringArray(params.tags, "tags"),
        });
        return result(`Remembered ${entry.id} (${entry.category}, ${entry.scope}).`, { entry });
      }

      if (action === "search") {
        const results = await store.search(requiredString(params.query, "query"), {
          limit: normalizeLimit(params.limit),
          category: normalizeOptionalCategory(params.category),
        });
        return result(renderSearchResults(results), { results });
      }

      if (action === "forget") {
        const entry = await store.forget(
          requiredString(params.id, "id"),
          requiredString(params.reason, "reason"),
        );
        return result(`Forgot ${entry.id}.`, { entry });
      }

      if (action === "status") {
        const summary = await store.status();
        return result(renderStatus(summary), { summary, policy: renderSparkMemoryPolicy() });
      }

      const entries = await recallEntries(store, params);
      return result(renderEntries(entries, `Memory entries (${scope})`), { entries });
    },
  });
}

export function registerSparkMemoryCheckpointEvents(
  pi: SparkMemoryExtensionApi,
  options: SparkMemoryToolOptions = {},
): void {
  pi.on?.("session_start", async (_event, ctx) => {
    const cwd = optionalCwd(ctx);
    if (!cwd) return;
    pi.sendMessage?.(
      {
        customType: "spark-memory-policy",
        content: renderSparkMemoryPolicy(),
        display: false,
        details: {
          policyOnly: true,
          storePath: defaultSparkMemoryStore(cwd, "workspace", options.storePaths).filePath,
        },
      },
      { deliverAs: "steer", triggerTurn: false },
    );
  });

  pi.on?.("session_before_compact", async (_event, ctx) => {
    const cwd = optionalCwd(ctx);
    if (!cwd) return;
    const checkpoint = await defaultSparkMemoryStore(
      cwd,
      "workspace",
      options.storePaths,
    ).checkpoint({
      limit: 25,
    });
    if (checkpoint.entries.length === 0) return;
    const message = {
      customType: "spark-memory-checkpoint",
      content: renderSparkMemoryCheckpoint(checkpoint),
      display: false,
      details: { checkpoint },
    };
    if (!isRecord(_event) || _event.consumeMessage !== true) {
      pi.sendMessage?.(message, { deliverAs: "steer", triggerTurn: false });
    }
    return { sparkMemoryCheckpoint: checkpoint, message };
  });
}

export default function sparkMemoryExtension(
  pi: SparkMemoryExtensionApi,
  options: SparkMemoryToolOptions = {},
): void {
  registerSparkMemoryTool(pi, options);
  registerSparkMemoryCheckpointEvents(pi, options);
}

async function recallEntries(
  store: ReturnType<typeof defaultSparkMemoryStore>,
  params: Record<string, unknown>,
): Promise<SparkMemoryEntry[]> {
  const category = normalizeOptionalCategory(params.category);
  const query = typeof params.query === "string" && params.query.trim() ? params.query : undefined;
  const limit = normalizeLimit(params.limit);
  if (query) return (await store.search(query, { limit, category })).map((result) => result.entry);
  return (
    await store.list({
      includeForgotten: normalizeBoolean(params.includeForgotten, false, "includeForgotten"),
      category,
    })
  ).slice(0, limit ?? 20);
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function renderSearchResults(
  results: Array<{ entry: SparkMemoryEntry; score: number; snippet: string }>,
): string {
  if (results.length === 0) return "Memory search: no matches";
  return [
    "Memory search results",
    ...results.map(
      (result) =>
        `- ${result.entry.id} score=${result.score} [${result.entry.category}] ${result.snippet}`,
    ),
  ].join("\n");
}

function renderEntries(entries: SparkMemoryEntry[], title: string): string {
  if (entries.length === 0) return `${title}: none`;
  return [
    title,
    ...entries.map((entry) => `- [${entry.status}] ${entry.id} ${entry.category}: ${entry.text}`),
  ].join("\n");
}

function renderStatus(summary: {
  storePath: string;
  total: number;
  active: number;
  forgotten: number;
  byCategory: Record<SparkMemoryCategory, number>;
}): string {
  return [
    "Memory status",
    `- store: ${summary.storePath}`,
    `- entries: active=${summary.active} forgotten=${summary.forgotten} total=${summary.total}`,
    `- categories: ${Object.entries(summary.byCategory)
      .map(([category, count]) => `${category}=${count}`)
      .join(", ")}`,
  ].join("\n");
}

function normalizeMemoryAction(value: unknown): SparkMemoryAction {
  if (
    value === "remember" ||
    value === "recall" ||
    value === "search" ||
    value === "status" ||
    value === "forget"
  ) {
    return value;
  }
  throw new Error("memory.action must be remember, recall, search, status, or forget");
}

function normalizeOptionalScope(value: unknown): SparkMemoryScope | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeSparkMemoryScope(value);
}

function normalizeOptionalCategory(value: unknown): SparkMemoryCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeSparkMemoryCategory(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`memory.${field} is required`);
  return value;
}

function normalizeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`memory.${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`memory.${field}[${index}] must be a string`);
    return entry;
  });
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`memory.${field} must be a boolean`);
  return value;
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("memory.limit must be a positive number");
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalCwd(ctx: unknown): string | undefined {
  const cwd =
    typeof (ctx as { cwd?: unknown })?.cwd === "string" ? (ctx as { cwd: string }).cwd : "";
  return cwd.trim() ? cwd : undefined;
}

function requiredCwd(ctx: unknown): string {
  const cwd = optionalCwd(ctx);
  if (!cwd) throw new Error("memory requires ctx.cwd");
  return cwd;
}

function renderMemoryCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const category = typeof args.category === "string" ? args.category : undefined;
  const text = ["memory", `action=${action}`, scope, category].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
