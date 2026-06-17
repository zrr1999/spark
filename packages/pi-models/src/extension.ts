import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/pi-extension-api";

export interface PiModelsExtensionApi {
  registerTool(config: ToolConfig): void;
}

interface RegistryModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

interface ModelRegistryLike {
  getAvailable(): RegistryModel[] | Promise<RegistryModel[]>;
  getAll(): RegistryModel[];
  hasConfiguredAuth(model: RegistryModel): boolean;
  getError?(): string | undefined;
}

interface ModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  thinking: boolean;
  images: boolean;
  available: boolean;
}

interface ModelDisplayRow {
  provider: string;
  model: string;
  context: string;
  maxOut: string;
  thinking: string;
  images: string;
  auth?: string;
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

export function registerPiModelsTool(pi: PiModelsExtensionApi): void {
  pi.registerTool({
    name: "models",
    label: "Models",
    description:
      "List models known to the active Pi model registry. Defaults to models with configured credentials.",
    promptGuidelines: [
      "Use models when you need concrete model ids before setting role or session model choices.",
      "By default, models lists only currently usable models with configured credentials.",
      "Pass includeUnavailable=true only when the user asks for all registered models, including those without credentials.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive substring filter over provider, model id, and name.",
        }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Optional provider filter, e.g. openai." }),
      ),
      includeUnavailable: Type.Optional(
        Type.Boolean({
          description:
            "When true, list all registered models and include an auth column. Defaults to false.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum rows to render. Defaults to all." }),
      ),
    }),
    renderCall(args, theme) {
      return renderModelsCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = requireModelRegistry(ctx);
      const includeUnavailable = normalizeBoolean(
        params.includeUnavailable,
        false,
        "includeUnavailable",
      );
      const provider = normalizeOptionalString(params.provider, "provider");
      const query = normalizeOptionalString(params.query, "query");
      const limit = normalizeLimit(params.limit);

      const baseModels = includeUnavailable
        ? registry.getAll()
        : await Promise.resolve(registry.getAvailable());
      const entries = baseModels
        .map((model) => toModelEntry(model, registry, includeUnavailable))
        .filter((entry) => matchesProvider(entry, provider))
        .filter((entry) => matchesQuery(entry, query))
        .sort(compareModelEntries);
      const renderedEntries = limit === undefined ? entries : entries.slice(0, limit);
      const omitted = Math.max(0, entries.length - renderedEntries.length);
      const registryError = registry.getError?.();
      const text = renderModels({
        entries: renderedEntries,
        totalMatched: entries.length,
        omitted,
        includeUnavailable,
        provider,
        query,
        registryError,
      });
      return {
        content: [{ type: "text" as const, text }],
        details: {
          includeUnavailable,
          provider,
          query,
          count: renderedEntries.length,
          totalMatched: entries.length,
          omitted,
          registryError,
          models: renderedEntries,
        },
      };
    },
  });
}

export default function piModelsExtension(pi: PiModelsExtensionApi): void {
  registerPiModelsTool(pi);
}

function requireModelRegistry(ctx: unknown): ModelRegistryLike {
  const registry = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry;
  if (!isModelRegistryLike(registry)) {
    throw new Error(
      "models requires ctx.modelRegistry from the pi-coding-agent host; spark-cli native host support is not wired yet.",
    );
  }
  return registry;
}

function isModelRegistryLike(value: unknown): value is ModelRegistryLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelRegistryLike>;
  return (
    typeof candidate.getAvailable === "function" &&
    typeof candidate.getAll === "function" &&
    typeof candidate.hasConfiguredAuth === "function"
  );
}

function toModelEntry(
  model: RegistryModel,
  registry: ModelRegistryLike,
  includeUnavailable: boolean,
): ModelEntry {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: normalizeTokenCount(model.contextWindow),
    maxTokens: normalizeTokenCount(model.maxTokens),
    thinking: model.reasoning === true,
    images: model.input?.includes("image") === true,
    available: includeUnavailable ? registry.hasConfiguredAuth(model) : true,
  };
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`models.${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`models.${field} must be a boolean`);
  return value;
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("models.limit must be a positive integer");
  }
  return value;
}

function normalizeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function matchesProvider(entry: ModelEntry, provider: string | undefined): boolean {
  return provider === undefined || entry.provider === provider;
}

function matchesQuery(entry: ModelEntry, query: string | undefined): boolean {
  if (!query) return true;
  const haystack = `${entry.provider} ${entry.id} ${entry.name}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function compareModelEntries(a: ModelEntry, b: ModelEntry): number {
  const provider = a.provider.localeCompare(b.provider);
  if (provider !== 0) return provider;
  return a.id.localeCompare(b.id);
}

function renderModels(input: {
  entries: ModelEntry[];
  totalMatched: number;
  omitted: number;
  includeUnavailable: boolean;
  provider: string | undefined;
  query: string | undefined;
  registryError: string | undefined;
}): string {
  const scope = input.includeUnavailable ? "Registered models" : "Available models";
  const filters = [
    input.provider ? `provider=${input.provider}` : undefined,
    input.query ? `query=${JSON.stringify(input.query)}` : undefined,
  ].filter(Boolean);
  const title = `${scope} (${input.totalMatched}${filters.length ? `; ${filters.join(", ")}` : ""})`;
  const lines = input.registryError
    ? [`Warning: errors loading models.json: ${input.registryError}`, "", title]
    : [title];
  if (input.entries.length === 0) {
    lines.push("No matching models.");
    return lines.join("\n");
  }
  lines.push(renderTable(input.entries, input.includeUnavailable));
  if (input.omitted > 0) lines.push(`… ${input.omitted} more model(s) omitted by limit.`);
  return lines.join("\n");
}

function renderTable(entries: ModelEntry[], includeAuthColumn: boolean): string {
  const rows = entries.map(
    (entry): ModelDisplayRow => ({
      provider: entry.provider,
      model: entry.id,
      context: formatTokenCount(entry.contextWindow),
      maxOut: formatTokenCount(entry.maxTokens),
      thinking: entry.thinking ? "yes" : "no",
      images: entry.images ? "yes" : "no",
      auth: includeAuthColumn ? (entry.available ? "yes" : "no") : undefined,
    }),
  );
  const columns = includeAuthColumn
    ? (["provider", "model", "context", "maxOut", "thinking", "images", "auth"] as const)
    : (["provider", "model", "context", "maxOut", "thinking", "images"] as const);
  const headers: Record<(typeof columns)[number], string> = {
    provider: "provider",
    model: "model",
    context: "context",
    maxOut: "max-out",
    thinking: "thinking",
    images: "images",
    auth: "auth",
  };
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(headers[column].length, ...rows.map((row) => String(row[column] ?? "").length)),
    ]),
  ) as Record<(typeof columns)[number], number>;
  const formatRow = (row: Record<(typeof columns)[number], string>) =>
    columns
      .map((column) => row[column].padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  const headerRow = Object.fromEntries(
    columns.map((column) => [column, headers[column]]),
  ) as Record<(typeof columns)[number], string>;
  return [
    formatRow(headerRow),
    ...rows.map((row) => formatRow(row as Record<(typeof columns)[number], string>)),
  ].join("\n");
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(value);
}

function renderModelsCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const parts = [
    "models",
    args.provider ? `provider=${String(args.provider)}` : undefined,
    args.query ? `query=${JSON.stringify(args.query)}` : undefined,
    args.includeUnavailable === true ? "all" : undefined,
    typeof args.limit === "number" ? `limit=${args.limit}` : undefined,
  ].filter(Boolean);
  const text = parts.join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
