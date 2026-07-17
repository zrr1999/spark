import { Type } from "typebox";
import type {
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-extension-api";

export type PiContextAction = "list" | "preview";

export interface PiContextBundle {
  providerId: string;
  label: string;
  content: string;
  budgetChars: number;
  truncated: boolean;
  priority?: number;
  refs?: string[];
}

export interface PiContextProvider {
  id: string;
  label: string;
  description: string;
  defaultBudgetChars: number;
  priority?: number;
  render(
    ctx: unknown,
    budgetChars: number,
  ): Promise<
    Omit<PiContextBundle, "providerId" | "label" | "budgetChars" | "truncated"> | string | undefined
  >;
}

export interface PiContextExtensionApi {
  registerTool(config: ToolConfig): void;
}

export interface PiContextToolOptions {
  providers: PiContextProvider[];
}

interface CompactContextProvider {
  id: string;
  label: string;
  description: string;
  defaultBudgetChars: number;
  priority?: number;
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

export function registerPiContextTool(
  pi: PiContextExtensionApi,
  options: PiContextToolOptions,
): void {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  pi.registerTool({
    name: "context",
    label: "Context",
    description:
      "Canonical registered context provider tool. List or preview bounded provider output; no freeform prompt injection.",
    promptGuidelines: [
      "Use context preview/list to inspect registered context providers before relying on injected context.",
      "Do not pass arbitrary system prompt text; context content must come from registered providers with budgets.",
      "Use providerIds and budgetChars to keep context bounded and explicit.",
    ],
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["context"],
      phases: ["plan", "implement"],
      approval: "none",
    },
    parameters: Type.Object({
      action: Type.String({ description: "list | preview" }),
      providerIds: Type.Optional(
        Type.Array(Type.String({ description: "Provider ids to preview." })),
      ),
      budgetChars: Type.Optional(Type.Number({ description: "Per-provider preview budget." })),
    }),
    renderCall(args, theme) {
      return renderContextCall(args, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeContextAction(params.action);
      if (action === "list") {
        const rows = [...providers.values()].map((provider) => compactProvider(provider));
        return {
          content: [
            {
              type: "text" as const,
              text: rows.length
                ? rows
                    .map(
                      (provider) =>
                        `- ${provider.id}: ${provider.label} (budget=${provider.defaultBudgetChars})`,
                    )
                    .join("\n")
                : "No context providers registered.",
            },
          ],
          details: { providers: rows },
        };
      }

      const selected = selectProviders(providers, params.providerIds);
      const budgetChars = normalizeBudget(params.budgetChars);
      const bundles = await Promise.all(
        selected.map((provider) =>
          renderProvider(provider, ctx, budgetChars ?? provider.defaultBudgetChars),
        ),
      );
      const visible = bundles.filter((bundle): bundle is PiContextBundle => Boolean(bundle));
      return {
        content: [
          {
            type: "text" as const,
            text: visible.length
              ? visible
                  .map((bundle) => `## ${bundle.label} (${bundle.providerId})\n${bundle.content}`)
                  .join("\n\n")
              : "No context content available.",
          },
        ],
        details: { bundles: visible },
      };
    },
  });
}

function compactProvider(provider: PiContextProvider): CompactContextProvider {
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    defaultBudgetChars: provider.defaultBudgetChars,
    priority: provider.priority,
  };
}

async function renderProvider(
  provider: PiContextProvider,
  ctx: unknown,
  budgetChars: number,
): Promise<PiContextBundle | undefined> {
  const rendered = await provider.render(ctx, budgetChars);
  if (!rendered) return undefined;
  const content = typeof rendered === "string" ? rendered : rendered.content;
  const truncatedContent = truncateToBudget(content, budgetChars);
  return {
    providerId: provider.id,
    label: provider.label,
    content: truncatedContent.content,
    budgetChars,
    truncated: truncatedContent.truncated,
    priority: provider.priority,
    refs: typeof rendered === "string" ? undefined : rendered.refs,
  };
}

function truncateToBudget(
  content: string,
  budgetChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= budgetChars) return { content, truncated: false };
  return {
    content: `${content.slice(0, Math.max(0, budgetChars - 1)).trimEnd()}…`,
    truncated: true,
  };
}

function selectProviders(
  providers: Map<string, PiContextProvider>,
  providerIds: unknown,
): PiContextProvider[] {
  if (providerIds === undefined || providerIds === null) return [...providers.values()];
  if (!Array.isArray(providerIds)) throw new Error("context.providerIds must be an array");
  return providerIds.map((id, index) => {
    if (typeof id !== "string" || !id.trim())
      throw new Error(`context.providerIds[${index}] must be a string`);
    const provider = providers.get(id);
    if (!provider) throw new Error(`unknown context provider: ${id}`);
    return provider;
  });
}

function normalizeContextAction(value: unknown): PiContextAction {
  if (value === "list" || value === "preview") return value;
  throw new Error("context.action must be list or preview");
}

function normalizeBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("context.budgetChars must be a positive integer");
  }
  return value;
}

function renderContextCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const providers = Array.isArray(args.providerIds)
    ? `${args.providerIds.length} provider(s)`
    : undefined;
  const text = ["context", `action=${action}`, providers].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
