import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Type } from "typebox";
import {
  callLeafOrDegrade,
  type ExtensionContext,
  type ToolConfig,
  type ToolRenderComponent,
  type ToolRenderTheme,
} from "@zendev-lab/spark-extension-api";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import {
  assertNoSecrets,
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
import { registerPiRecallTool } from "./recall-extension.ts";
import type { RecallStorePaths } from "./recall-store.ts";

export type SparkMemoryAction =
  | "remember"
  | "recall"
  | "search"
  | "status"
  | "forget"
  | "import_legacy";

export interface SparkMemoryExtensionApi {
  registerTool(config: ToolConfig): void;
  getAllTools?(): Array<{ name: string }>;
  on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
}

export interface SparkMemoryToolOptions {
  storePaths?: SparkMemoryStorePaths;
  compatMemoryDir?: string;
  recallStorePaths?: RecallStorePaths;
}

type LegacyMemoryTarget = "long_term" | "daily" | "scratchpad" | "list";
type ScratchpadItem = { done: boolean; text: string };
type LegacyMemoryDocument = {
  target: "long_term" | "scratchpad" | "daily";
  label: string;
  path: string;
  content: string;
};

type LegacySearchResult = { label: string; path: string; score: number; snippet: string };

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
  registerIfAvailable(pi, memoryTool(options));
  registerIfAvailable(pi, memoryWriteTool(options));
  registerIfAvailable(pi, memoryReadTool(options));
  registerIfAvailable(pi, scratchpadTool(options));
  registerIfAvailable(pi, memorySearchTool(options));
  registerIfAvailable(pi, memoryStatusTool(options));
  registerPiRecallTool(pi, { storePaths: options.recallStorePaths });
}

type RegisteredToolInspection =
  | { status: "available"; tools: Array<{ name: string }> }
  | { status: "unavailable" }
  | { status: "blocked" };

function registerIfAvailable(pi: SparkMemoryExtensionApi, config: ToolConfig): void {
  const registered = tryRegisterIfAvailable(pi, config);
  if (registered) return;
  if (!pi.on) return;
  pi.on("session_start", () => {
    tryRegisterIfAvailable(pi, config);
  });
}

function tryRegisterIfAvailable(pi: SparkMemoryExtensionApi, config: ToolConfig): boolean {
  const inspection = inspectRegisteredTools(pi);
  const exists =
    inspection.status === "available" && inspection.tools.some((tool) => tool.name === config.name);
  if (exists) return true;
  if (inspection.status !== "available") return false;
  try {
    pi.registerTool(config);
    return true;
  } catch (error) {
    if (isToolConflictError(error, config.name)) return true;
    throw error;
  }
}

function inspectRegisteredTools(api: SparkMemoryExtensionApi): RegisteredToolInspection {
  if (!api.getAllTools) return { status: "unavailable" };
  try {
    return { status: "available", tools: api.getAllTools() };
  } catch {
    return { status: "blocked" };
  }
}

function isToolConflictError(error: unknown, toolName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Tool "${toolName}" conflicts with`);
}

function memoryTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "memory",
    label: "Memory",
    description:
      "Unified explicit Spark memory capability. Remember, recall, search, inspect status, forget scoped entries, or import legacy pi-memory Markdown files.",
    promptGuidelines: [
      renderSparkMemoryPolicy(),
      "Keep learning and recall tools stable; use memory when the user asks for unified durable memory.",
      "Memory writes are explicit and secret-scanned. Do not store credentials or hidden chain-of-thought.",
      'Use memory({ action: "import_legacy", apply: false }) to preview pi-memory Markdown import before applying it.',
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "remember | recall | search | status | forget | import_legacy",
      }),
      scope: Type.Optional(Type.String({ description: "user | workspace | repo" })),
      category: Type.Optional(
        Type.String({
          description: "failure | correction | insight | preference | convention | tool-quirk",
        }),
      ),
      text: Type.Optional(Type.String({ description: "Memory text for action=remember." })),
      reason: Type.Optional(
        Type.String({ description: "Why to remember, why to forget, or why to import." }),
      ),
      evidenceRefs: Type.Optional(Type.Array(Type.String())),
      tags: Type.Optional(Type.Array(Type.String())),
      query: Type.Optional(
        Type.String({ description: "Keyword query for search/recall filtering." }),
      ),
      id: Type.Optional(Type.String({ description: "Memory entry id for forget." })),
      includeForgotten: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number()),
      sourceDir: Type.Optional(
        Type.String({ description: "Legacy pi-memory directory for action=import_legacy." }),
      ),
      apply: Type.Optional(
        Type.Boolean({ description: "For action=import_legacy: false previews, true imports." }),
      ),
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

      if (action === "import_legacy") {
        const compatDir = resolveCompatMemoryDir(options, params.sourceDir);
        const documents = await collectLegacyMemoryDocuments(compatDir);
        const apply = normalizeBoolean(params.apply, false, "apply");
        if (!apply) {
          return result(renderLegacyImportPreview(documents, compatDir), {
            apply: false,
            sourceDir: compatDir,
            documents: summarizeLegacyDocuments(documents),
          });
        }
        const imported: SparkMemoryEntry[] = [];
        const skipped: Array<{ label: string; reason: string }> = [];
        for (const document of documents) {
          if (!document.content.trim()) continue;
          try {
            imported.push(
              await store.remember({
                scope,
                category: normalizeOptionalCategory(params.category) ?? "insight",
                text: `Imported legacy ${document.target} memory (${document.label})\n\n${document.content}`,
                reason:
                  typeof params.reason === "string" && params.reason.trim()
                    ? params.reason.trim()
                    : "Explicit import from legacy pi-memory Markdown files.",
                evidenceRefs: normalizeStringArray(params.evidenceRefs, "evidenceRefs"),
                tags: [
                  "legacy-pi-memory",
                  document.target,
                  ...normalizeStringArray(params.tags, "tags"),
                ],
              }),
            );
          } catch (error) {
            skipped.push({
              label: document.label,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return result(
          `Imported ${imported.length} legacy memory document(s) from ${compatDir}${
            skipped.length > 0 ? `; skipped ${skipped.length}` : ""
          }.`,
          { apply: true, sourceDir: compatDir, imported, skipped },
        );
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
  };
}

function memoryWriteTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "memory_write",
    label: "Memory Write",
    description:
      "Spark compatibility tool for pi-memory writes. Writes long-term MEMORY.md or append-only daily logs with explicit user/tool intent and secret scanning.",
    parameters: Type.Object({
      target: Type.String({ description: "long_term | daily" }),
      content: Type.String({ description: "Markdown content to write" }),
      mode: Type.Optional(Type.String({ description: "append | overwrite for long_term" })),
      sourceDir: Type.Optional(Type.String({ description: "Override compatibility memory dir" })),
    }),
    async execute(_toolCallId, params) {
      const target = requiredLegacyTarget(params.target, ["long_term", "daily"]);
      const content = requiredString(params.content, "content");
      assertNoSecrets(content);
      const paths = legacyMemoryPaths(resolveCompatMemoryDir(options, params.sourceDir));
      await ensureLegacyDirs(paths);
      const stamp = `<!-- ${timestamp()} [spark] -->`;
      if (target === "daily") {
        const path = join(paths.dailyDir, `${today()}.md`);
        const existing = await readOptional(path);
        const next = `${existing}${existing.trim() ? "\n\n" : ""}${stamp}\n${content}`;
        await writeFile(path, next, "utf8");
        return result(`Appended to daily log: ${path}`, { path, target, mode: "append" });
      }
      const mode = params.mode === "overwrite" ? "overwrite" : "append";
      const existing = await readOptional(paths.memoryFile);
      const next =
        mode === "overwrite"
          ? `<!-- last updated: ${timestamp()} [spark] -->\n${content}`
          : `${existing}${existing.trim() ? "\n\n" : ""}${stamp}\n${content}`;
      await writeFile(paths.memoryFile, next, "utf8");
      return result(`${mode === "overwrite" ? "Overwrote" : "Appended to"} MEMORY.md`, {
        path: paths.memoryFile,
        target,
        mode,
      });
    },
  };
}

function memoryReadTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "memory_read",
    label: "Memory Read",
    description:
      "Spark compatibility tool for reading pi-memory style MEMORY.md, SCRATCHPAD.md, daily logs, or daily log list.",
    policy: readOnlyMemoryToolPolicy(),
    parameters: Type.Object({
      target: Type.String({ description: "long_term | scratchpad | daily | list" }),
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD for daily logs" })),
      sourceDir: Type.Optional(Type.String({ description: "Override compatibility memory dir" })),
    }),
    async execute(_toolCallId, params) {
      const target = requiredLegacyTarget(params.target, [
        "long_term",
        "scratchpad",
        "daily",
        "list",
      ]);
      const paths = legacyMemoryPaths(resolveCompatMemoryDir(options, params.sourceDir));
      if (target === "list") {
        const files = await listDailyFiles(paths.dailyDir);
        return result(
          files.length > 0
            ? `Daily logs:\n${files.map((file) => `- ${file}`).join("\n")}`
            : "No daily logs found.",
          { files, dailyDir: paths.dailyDir },
        );
      }
      if (target === "daily") {
        const date =
          typeof params.date === "string" && params.date.trim() ? params.date.trim() : today();
        assertDailyDate(date);
        const path = join(paths.dailyDir, `${date}.md`);
        const content = await readOptional(path);
        return result(content || `No daily log for ${date}.`, { path, date });
      }
      const path = target === "scratchpad" ? paths.scratchpadFile : paths.memoryFile;
      const content = await readOptional(path);
      return result(content || `${basename(path)} is empty or does not exist.`, { path, target });
    },
  };
}

function scratchpadTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "scratchpad",
    label: "Scratchpad",
    description:
      "Spark compatibility checklist tool for pi-memory style SCRATCHPAD.md. Actions: add, done, undo, clear_done, list.",
    parameters: Type.Object({
      action: Type.String({ description: "add | done | undo | clear_done | list" }),
      text: Type.Optional(Type.String({ description: "Item text or substring" })),
      sourceDir: Type.Optional(Type.String({ description: "Override compatibility memory dir" })),
    }),
    async execute(_toolCallId, params) {
      const action = requiredScratchpadAction(params.action);
      const paths = legacyMemoryPaths(resolveCompatMemoryDir(options, params.sourceDir));
      await ensureLegacyDirs(paths);
      const items = parseScratchpad(await readOptional(paths.scratchpadFile));
      if (action === "list") return result(renderScratchpad(items), scratchpadDetails(items));
      if (action === "add") {
        const text = requiredString(params.text, "text");
        assertNoSecrets(text);
        items.push({ done: false, text });
        await writeScratchpad(paths.scratchpadFile, items);
        return result(
          `Added: - [ ] ${text}\n\n${renderScratchpad(items)}`,
          scratchpadDetails(items),
        );
      }
      if (action === "clear_done") {
        const remaining = items.filter((item) => !item.done);
        const removed = items.length - remaining.length;
        await writeScratchpad(paths.scratchpadFile, remaining);
        return result(`Cleared ${removed} done item(s).\n\n${renderScratchpad(remaining)}`, {
          ...scratchpadDetails(remaining),
          removed,
        });
      }
      const rawText = requiredString(params.text, "text");
      const text = rawText.toLowerCase();
      const targetDone = action === "done";
      const item = items.find(
        (candidate) => candidate.done !== targetDone && candidate.text.toLowerCase().includes(text),
      );
      if (!item)
        return result(
          `No matching ${targetDone ? "open" : "done"} item found for: "${rawText}"`,
          scratchpadDetails(items),
        );
      item.done = targetDone;
      await writeScratchpad(paths.scratchpadFile, items);
      return result(`Updated.\n\n${renderScratchpad(items)}`, scratchpadDetails(items));
    },
  };
}

function memorySearchTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Spark compatibility search across MEMORY.md, SCRATCHPAD.md, and daily logs. Keyword mode is mechanical; semantic/deep modes use one memory-reranker leaf over keyword-recalled candidates when the host provides ctx.runLeaf.",
    // semantic/deep mode may consume a model leaf. It remains read-only but
    // sequential until tool policy can express per-call cost/fan-out limits.
    policy: readOnlyMemoryToolPolicy("sequential"),
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      mode: Type.Optional(Type.String({ description: "keyword | semantic | deep" })),
      limit: Type.Optional(Type.Number({ description: "Max results" })),
      sourceDir: Type.Optional(Type.String({ description: "Override compatibility memory dir" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = requiredString(params.query, "query");
      const mode = params.mode === "semantic" || params.mode === "deep" ? params.mode : "keyword";
      const limit = normalizeLimit(params.limit) ?? 5;
      const sourceDir = resolveCompatMemoryDir(options, params.sourceDir);
      const documents = await collectLegacyMemoryDocuments(sourceDir);
      const candidateWindow = memorySearchCandidateWindow(mode, limit);
      const candidates = searchLegacyDocuments(documents, query, candidateWindow);
      if (mode === "keyword") {
        const results = candidates.slice(0, limit);
        return result(renderLegacySearchResults(results, query, mode), {
          sourceDir,
          query,
          mode,
          count: results.length,
          degraded: false,
          candidateWindow,
          candidateCount: candidates.length,
          results,
        });
      }

      const leaf =
        candidates.length > 0
          ? await callLeafOrDegrade(ctx as ExtensionContext, {
              role: "memory-reranker",
              brief:
                "Rerank the memory candidates for relevance to the query. Return only a JSON array of 1-based candidate numbers in best-to-worst order; include only candidates worth returning.",
              input: renderMemoryRerankInput(query, mode, candidates),
              maxTokens: Math.max(256, limit * 24),
              ...(signal ? { signal } : {}),
            })
          : { degraded: true as const, text: "", reasonCode: "no-model" as const };
      const ranking = leaf.degraded ? [] : parseRerankOrder(leaf.text, candidates.length);
      const reranked = ranking.length > 0 ? applyRerankOrder(candidates, ranking) : candidates;
      const results = reranked.slice(0, limit);
      const prefix = leaf.degraded
        ? `Mode ${mode} could not run the memory-reranker leaf; using keyword candidate order.\n\n`
        : "";
      return result(`${prefix}${renderLegacySearchResults(results, query, mode)}`, {
        sourceDir,
        query,
        mode,
        count: results.length,
        degraded: leaf.degraded,
        leafDegraded: leaf.degraded,
        ...(leaf.reasonCode ? { leafReasonCode: leaf.reasonCode } : {}),
        candidateWindow,
        candidateCount: candidates.length,
        reranked: ranking.length > 0,
        ranking,
        results,
      });
    },
  };
}

function memoryStatusTool(options: SparkMemoryToolOptions): ToolConfig {
  return {
    name: "memory_status",
    label: "Memory Status",
    description:
      "Report Spark memory replacement health, including Spark JSON memory and pi-memory compatibility Markdown files.",
    policy: readOnlyMemoryToolPolicy(),
    parameters: Type.Object({
      sourceDir: Type.Optional(Type.String({ description: "Override compatibility memory dir" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = optionalCwd(ctx) ?? process.cwd();
      const store = defaultSparkMemoryStore(cwd, "workspace", options.storePaths);
      const sparkStatus = await store.status();
      const sourceDir = resolveCompatMemoryDir(options, params.sourceDir);
      const documents = await collectLegacyMemoryDocuments(sourceDir);
      const dailyCount = documents.filter((document) => document.target === "daily").length;
      const lines = [
        "# Memory status",
        "",
        "## Spark memory",
        `- store: ${sparkStatus.storePath}`,
        `- entries: active=${sparkStatus.active} forgotten=${sparkStatus.forgotten} total=${sparkStatus.total}`,
        "",
        "## pi-memory compatibility",
        `- memory dir: ${sourceDir}`,
        `- MEMORY.md: ${documents.find((document) => document.target === "long_term")?.content.length ?? 0} chars`,
        `- SCRATCHPAD.md: ${documents.find((document) => document.target === "scratchpad")?.content.length ?? 0} chars`,
        `- daily logs: ${dailyCount}`,
        "- search: keyword native; semantic/deep use a memory-reranker leaf when ctx.runLeaf is available, otherwise explicit keyword-order fallback",
      ];
      return result(lines.join("\n"), {
        sparkStatus,
        sourceDir,
        documents: summarizeLegacyDocuments(documents),
      });
    },
  };
}

function readOnlyMemoryToolPolicy(
  executionMode: "parallel" | "sequential" = "parallel",
): NonNullable<ToolConfig["policy"]> {
  return {
    effect: "read",
    executionMode,
    domains: ["memory"],
    phases: ["plan", "implement"],
    approval: "none",
  };
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
        authority: "runtime_control",
        trust: "trusted",
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
      // Deliver as a hidden next-turn message so the checkpoint rides the next
      // real user prompt instead of being flushed as a standalone steered turn
      // right after compaction. triggerTurn stays false: this must never start
      // its own request.
      pi.sendMessage?.(message, { deliverAs: "nextTurn", triggerTurn: false });
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
    value === "forget" ||
    value === "import_legacy"
  ) {
    return value;
  }
  throw new Error(
    "memory.action must be remember, recall, search, status, forget, or import_legacy",
  );
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
  return value.trim();
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`memory.${field} must be an array`);
  return [
    ...new Set(
      value
        .map((entry, index) => {
          if (typeof entry !== "string")
            throw new Error(`memory.${field}[${index}] must be a string`);
          return entry.trim();
        })
        .filter(Boolean),
    ),
  ];
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

function resolveCompatMemoryDir(options: SparkMemoryToolOptions, override: unknown): string {
  if (typeof override === "string" && override.trim()) return override.trim();
  if (options.compatMemoryDir?.trim()) return options.compatMemoryDir;
  return dirname(resolveSparkUserPaths().memoryFile);
}

function legacyMemoryPaths(memoryDir: string) {
  return {
    memoryDir,
    memoryFile: join(memoryDir, "MEMORY.md"),
    scratchpadFile: join(memoryDir, "SCRATCHPAD.md"),
    dailyDir: join(memoryDir, "daily"),
  };
}

async function ensureLegacyDirs(paths: ReturnType<typeof legacyMemoryPaths>): Promise<void> {
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.dailyDir, { recursive: true });
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/u, "");
}

function assertDailyDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Invalid date format: ${date}`);
}

function requiredLegacyTarget<T extends LegacyMemoryTarget>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new Error(`memory.target must be one of: ${allowed.join(", ")}`);
}

function requiredScratchpadAction(value: unknown): "add" | "done" | "undo" | "clear_done" | "list" {
  if (
    value === "add" ||
    value === "done" ||
    value === "undo" ||
    value === "clear_done" ||
    value === "list"
  ) {
    return value;
  }
  throw new Error("scratchpad.action must be add, done, undo, clear_done, or list");
}

async function listDailyFiles(dailyDir: string): Promise<string[]> {
  try {
    return (await readdir(dailyDir))
      .filter((file) => file.endsWith(".md"))
      .sort()
      .reverse();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

function parseScratchpad(content: string): ScratchpadItem[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*- \[( |x|X)\]\s+(.+)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ done: match[1]?.toLowerCase() === "x", text: match[2] ?? "" }));
}

function serializeScratchpad(items: readonly ScratchpadItem[]): string {
  return [
    "# Scratchpad",
    "",
    ...items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`),
    "",
  ].join("\n");
}

async function writeScratchpad(path: string, items: readonly ScratchpadItem[]): Promise<void> {
  await writeFile(path, serializeScratchpad(items), "utf8");
}

function renderScratchpad(items: readonly ScratchpadItem[]): string {
  if (items.length === 0) return "Scratchpad is empty.";
  return serializeScratchpad(items).trim();
}

function scratchpadDetails(items: readonly ScratchpadItem[]): Record<string, unknown> {
  return {
    count: items.length,
    open: items.filter((item) => !item.done).length,
    done: items.filter((item) => item.done).length,
  };
}

async function collectLegacyMemoryDocuments(memoryDir: string): Promise<LegacyMemoryDocument[]> {
  const paths = legacyMemoryPaths(memoryDir);
  const documents: LegacyMemoryDocument[] = [];
  const longTerm = await readOptional(paths.memoryFile);
  if (longTerm)
    documents.push({
      target: "long_term",
      label: "MEMORY.md",
      path: paths.memoryFile,
      content: longTerm,
    });
  const scratchpad = await readOptional(paths.scratchpadFile);
  if (scratchpad)
    documents.push({
      target: "scratchpad",
      label: "SCRATCHPAD.md",
      path: paths.scratchpadFile,
      content: scratchpad,
    });
  for (const file of await listDailyFiles(paths.dailyDir)) {
    const path = join(paths.dailyDir, file);
    const content = await readOptional(path);
    if (content) documents.push({ target: "daily", label: `daily/${file}`, path, content });
  }
  return documents;
}

function summarizeLegacyDocuments(documents: readonly LegacyMemoryDocument[]): Array<{
  target: LegacyMemoryDocument["target"];
  label: string;
  path: string;
  chars: number;
}> {
  return documents.map((document) => ({
    target: document.target,
    label: document.label,
    path: document.path,
    chars: document.content.length,
  }));
}

function renderLegacyImportPreview(
  documents: readonly LegacyMemoryDocument[],
  sourceDir: string,
): string {
  if (documents.length === 0) return `No legacy pi-memory documents found in ${sourceDir}.`;
  return [
    `Legacy pi-memory import preview from ${sourceDir}`,
    ...documents.map((document) => `- ${document.label}: ${document.content.length} chars`),
    'Run memory({ action: "import_legacy", apply: true }) to import into Spark memory.',
  ].join("\n");
}

function memorySearchCandidateWindow(mode: "keyword" | "semantic" | "deep", limit: number): number {
  if (mode === "deep") return Math.max(limit, 50);
  if (mode === "semantic") return Math.max(limit, 20);
  return limit;
}

function renderMemoryRerankInput(
  query: string,
  mode: "semantic" | "deep",
  candidates: readonly LegacySearchResult[],
): string {
  return [
    `Query: ${query}`,
    `Mode: ${mode}`,
    "Candidates:",
    ...candidates.map((candidate, index) =>
      [
        `${index + 1}. ${candidate.label}`,
        `Path: ${candidate.path}`,
        `Keyword score: ${candidate.score}`,
        `Snippet: ${candidate.snippet}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function parseRerankOrder(text: string, maxIndex: number): number[] {
  const parsed = parseJsonNumberArray(text) ?? text.match(/\d+/gu)?.map((value) => Number(value));
  if (!parsed) return [];
  const seen = new Set<number>();
  const order: number[] = [];
  for (const value of parsed) {
    if (!Number.isInteger(value) || value < 1 || value > maxIndex || seen.has(value)) continue;
    seen.add(value);
    order.push(value - 1);
  }
  return order;
}

function parseJsonNumberArray(text: string): number[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "number")) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function applyRerankOrder(
  candidates: readonly LegacySearchResult[],
  ranking: readonly number[],
): LegacySearchResult[] {
  const ranked = ranking
    .map((index) => candidates[index])
    .filter((item): item is LegacySearchResult => Boolean(item));
  const used = new Set(ranking);
  return [...ranked, ...candidates.filter((_candidate, index) => !used.has(index))];
}

function searchLegacyDocuments(
  documents: readonly LegacyMemoryDocument[],
  query: string,
  limit: number,
): LegacySearchResult[] {
  const tokens = tokenize(query);
  return documents
    .map((document) => {
      const haystack = document.content.toLowerCase();
      let score = 0;
      for (const token of tokens) score += haystack.split(token).length - 1;
      return {
        label: document.label,
        path: document.path,
        score,
        snippet: snippet(document.content, tokens),
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function renderLegacySearchResults(
  results: readonly LegacySearchResult[],
  query: string,
  mode: string,
): string {
  if (results.length === 0) return `No results found for "${query}" (mode: ${mode}).`;
  return [
    `Memory search results (mode: ${mode})`,
    ...results.map((result, index) =>
      [
        `### Result ${index + 1}`,
        `**File:** ${result.path}`,
        `**Score:** ${result.score}`,
        "",
        result.snippet,
      ].join("\n"),
    ),
  ].join("\n\n---\n\n");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function snippet(content: string, tokens: readonly string[]): string {
  const text = content.replace(/\s+/gu, " ").trim();
  const lower = text.toLowerCase();
  const firstHit =
    tokens
      .map((token) => lower.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 80);
  const end = Math.min(text.length, firstHit + 220);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
