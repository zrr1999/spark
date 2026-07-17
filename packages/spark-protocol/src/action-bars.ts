import { z } from "zod";
import { sparkProtocolJsonObjectSchema } from "./command-events.ts";

/**
 * Stable, surface-neutral intents exposed by a Spark action bar.
 *
 * These are semantic intents, not slash commands, CLI arguments, RPC method
 * names, or transport routes. Each host resolves an intent through its own
 * trusted control path.
 */
export const sparkActionIntentOptions = [
  "model.select",
  "thinking.select",
  "settings.inspect",
  "settings.providers",
  "status.inspect",
  "session.select",
  "session.create",
  "session.inspect",
  "queue.inspect",
  "turn.stop",
  "turn.retry",
  "goal.status",
  "goal.start",
  "goal.restart",
  "goal.stop",
  "loop.status",
  "loop.start",
  "loop.restart",
  "loop.stop",
  "repro.status",
  "repro.start",
  "repro.restart",
  "repro.stop",
  "workflow.open",
  "workflow.inspect",
  "help.commands",
  "help.hotkeys",
] as const;

export const sparkActionIntentSchema = z.enum(sparkActionIntentOptions);

export const sparkActionToneOptions = ["default", "primary", "danger"] as const;
export const sparkActionToneSchema = z.enum(sparkActionToneOptions);

/** One display-safe operation that a host may render as a button or key action. */
export const sparkActionViewSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    intent: sparkActionIntentSchema,
    payload: sparkProtocolJsonObjectSchema.default({}),
    tone: sparkActionToneSchema.optional(),
  })
  .strict();

/** A small operation surface shared by terminal and graphical Spark hosts. */
export const sparkActionBarViewSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    actions: z.array(sparkActionViewSchema).min(1),
  })
  .strict()
  .superRefine((bar, context) => {
    const seen = new Set<string>();
    for (const [index, action] of bar.actions.entries()) {
      if (seen.has(action.id)) {
        context.addIssue({
          code: "custom",
          path: ["actions", index, "id"],
          message: `Action bar ${bar.id} contains duplicate action id ${action.id}`,
        });
      }
      seen.add(action.id);
    }
  });

export type SparkActionIntent = z.infer<typeof sparkActionIntentSchema>;
export type SparkActionTone = z.infer<typeof sparkActionToneSchema>;
export type SparkActionView = z.infer<typeof sparkActionViewSchema>;
export type SparkActionBarView = z.infer<typeof sparkActionBarViewSchema>;

export interface SparkSlashInput {
  /** Normalized command name without the leading slash. */
  command: string;
  /** Trimmed argument text; empty for a bare command. */
  args: string;
}

/** One canonical editor command and the compatibility aliases that open the same action bar. */
export interface SparkSlashCommandDescriptor {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly actionBar: SparkActionBarView;
}

/** One prefix match that can be inserted into an editor. */
export interface SparkSlashSuggestion {
  readonly command: string;
  readonly canonicalCommand: string;
  readonly descriptor: SparkSlashCommandDescriptor;
}

/**
 * Surface-neutral interpretation of the complete editor value.
 *
 * Keyboard selection and focus remain host concerns. This result only
 * distinguishes ordinary input, completion, exact commands, and rejected
 * slash-command shapes without assigning execution semantics.
 */
export type SparkSlashEditorResolution =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "suggest";
      query: string;
      suggestions: readonly SparkSlashSuggestion[];
    }>
  | Readonly<{
      kind: "exact";
      command: string;
      descriptor: SparkSlashCommandDescriptor;
    }>
  | Readonly<{ kind: "unknown"; command: string }>
  | Readonly<{
      kind: "arguments";
      command: string;
      args: string;
      descriptor?: SparkSlashCommandDescriptor;
    }>;

const slashInputPattern = /^\/([\p{L}\p{N}][\p{L}\p{N}:_-]*)(?:\s+([\s\S]*))?$/u;

/** Parse one slash-prefixed editor input without assigning execution semantics. */
export function parseSparkSlashInput(input: string): SparkSlashInput | undefined {
  const match = slashInputPattern.exec(input.trim());
  if (!match?.[1]) return undefined;
  return {
    command: match[1].toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}

const modelActionBar = actionBar({
  id: "model",
  title: "Model controls",
  description: "Choose the active model or inspect configured providers.",
  actions: [
    action("select-model", "Choose model", "model.select", "primary"),
    action("choose-thinking", "Thinking level", "thinking.select"),
    action("inspect-providers", "Providers", "settings.providers"),
  ],
});

const thinkingActionBar = actionBar({
  id: "thinking",
  title: "Thinking level",
  description: "Choose the reasoning effort for subsequent turns.",
  actions: [
    ...(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((thinkingLevel) =>
      action(
        `thinking-${thinkingLevel}`,
        thinkingLevel,
        "thinking.select",
        thinkingLevel === "medium" ? "primary" : undefined,
        { thinkingLevel },
      ),
    ),
  ],
});

const settingsActionBar = actionBar({
  id: "settings",
  title: "Session settings",
  description: "Inspect settings and open the controls most often changed during a session.",
  actions: [
    action("inspect-settings", "Overview", "settings.inspect", "primary"),
    action("inspect-providers", "Providers", "settings.providers"),
    action("select-model", "Model", "model.select"),
    action("select-thinking", "Thinking", "thinking.select"),
  ],
});

const statusActionBar = actionBar({
  id: "status",
  title: "Runtime status",
  actions: [
    action("inspect-status", "Refresh status", "status.inspect", "primary"),
    action("inspect-queue", "Queue", "queue.inspect"),
    action("inspect-session", "Session", "session.inspect"),
  ],
});

const sessionActionBar = actionBar({
  id: "session",
  title: "Session controls",
  description: "Switch, create, or inspect a Spark session.",
  actions: [
    action("select-session", "Choose session", "session.select", "primary"),
    action("create-session", "New session", "session.create"),
    action("inspect-session", "Current session", "session.inspect"),
  ],
});

const queueActionBar = actionBar({
  id: "queue",
  title: "Turn queue",
  description: "Inspect pending input or control the current turn.",
  actions: [
    action("inspect-queue", "Show queue", "queue.inspect", "primary"),
    action("retry-turn", "Retry", "turn.retry"),
    action("stop-turn", "Stop and restore", "turn.stop", "danger"),
  ],
});

const scopedModelsActionBar = actionBar({
  id: "scoped-models",
  title: "Available models",
  actions: [
    action("select-model", "Choose model", "model.select", "primary"),
    action("inspect-providers", "Provider settings", "settings.providers"),
  ],
});

const goalActionBar = lifecycleActionBar("goal", "Goal controls", {
  status: "Inspect goal",
  start: "Start goal",
  restart: "Restart goal",
  stop: "Stop goal",
});

const loopActionBar = lifecycleActionBar("loop", "Loop controls", {
  status: "Inspect loop",
  start: "Start loop",
  restart: "Restart loop",
  stop: "Stop loop",
});

const reproActionBar = lifecycleActionBar("repro", "Reproduction controls", {
  status: "Inspect repro",
  start: "Start repro",
  restart: "Restart repro",
  stop: "Stop repro",
});

const workflowRunsActionBar = actionBar({
  id: "workflow-runs",
  title: "Workflow runs",
  description: "Open the run board or inspect the selected workflow run.",
  actions: [
    action("open-workflows", "Open runs", "workflow.open", "primary"),
    action("inspect-workflow", "Inspect selected", "workflow.inspect"),
  ],
});

const helpActionBar = actionBar({
  id: "help",
  title: "Spark help",
  actions: [
    action("show-commands", "Commands", "help.commands", "primary"),
    action("show-hotkeys", "Hotkeys", "help.hotkeys"),
  ],
});

const hotkeysActionBar = actionBar({
  id: "hotkeys",
  title: "Keyboard controls",
  actions: [
    action("show-hotkeys", "Hotkeys", "help.hotkeys", "primary"),
    action("show-commands", "Commands", "help.commands"),
  ],
});

/**
 * Canonical slash commands in their stable discovery order.
 *
 * Aliases remain valid lookup names, but discovery surfaces can render this
 * list once per operation surface instead of repeating identical action bars.
 */
export const sparkSlashCommandDescriptors: readonly SparkSlashCommandDescriptor[] = Object.freeze([
  slashCommand("model", modelActionBar),
  slashCommand("thinking", thinkingActionBar),
  slashCommand("settings", settingsActionBar),
  slashCommand("status", statusActionBar),
  slashCommand("session", sessionActionBar, ["sessions", "resume", "new"]),
  slashCommand("queue", queueActionBar),
  slashCommand("scoped-models", scopedModelsActionBar),
  slashCommand("goal", goalActionBar),
  slashCommand("loop", loopActionBar),
  slashCommand("repro", reproActionBar),
  slashCommand("workflow-runs", workflowRunsActionBar, ["runs", "run", "workflows"]),
  slashCommand("help", helpActionBar),
  slashCommand("hotkeys", hotkeysActionBar),
]);

const slashCommandDescriptorByName = indexSlashCommandDescriptors(sparkSlashCommandDescriptors);

/**
 * Canonical operation surfaces for bare slash commands.
 *
 * Catalog keys are parser lookup names only. The returned views deliberately
 * contain no slash input or CLI command string; execution is always resolved
 * from the semantic action intent by the consuming host.
 */
export const sparkSlashActionBarCatalog: Readonly<Record<string, SparkActionBarView>> =
  Object.freeze(
    Object.fromEntries(
      [...slashCommandDescriptorByName].map(([name, descriptor]) => [name, descriptor.actionBar]),
    ),
  );

/** Resolve a complete editor value for prefix completion or exact action-bar handoff. */
export function resolveSparkSlashEditorInput(input: string): SparkSlashEditorResolution {
  const normalized = input.trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//")) {
    return { kind: "inactive" };
  }

  if (normalized === "/") {
    return {
      kind: "suggest",
      query: "",
      suggestions: slashSuggestionsForQuery(""),
    };
  }

  const parsed = parseSparkSlashInput(normalized);
  if (!parsed) return { kind: "inactive" };

  const descriptor = slashCommandDescriptorByName.get(parsed.command);
  if (parsed.args) {
    return descriptor
      ? {
          kind: "arguments",
          command: parsed.command,
          args: parsed.args,
          descriptor,
        }
      : { kind: "arguments", command: parsed.command, args: parsed.args };
  }

  if (descriptor) {
    return { kind: "exact", command: parsed.command, descriptor };
  }

  const suggestions = slashSuggestionsForQuery(parsed.command);
  return suggestions.length > 0
    ? { kind: "suggest", query: parsed.command, suggestions }
    : { kind: "unknown", command: parsed.command };
}

/** Return an action bar only for an exact, argument-free catalog command. */
export function sparkSlashActionBarForInput(input: string): SparkActionBarView | undefined {
  const parsed = parseSparkSlashInput(input);
  if (!parsed || parsed.args) return undefined;
  return sparkSlashActionBarCatalog[parsed.command];
}

function action(
  id: string,
  label: string,
  intent: SparkActionIntent,
  tone?: SparkActionTone,
  payload: Record<string, string> = {},
): SparkActionView {
  return sparkActionViewSchema.parse({ id, label, intent, payload, ...(tone ? { tone } : {}) });
}

function actionBar(input: z.input<typeof sparkActionBarViewSchema>): SparkActionBarView {
  return sparkActionBarViewSchema.parse(input);
}

function lifecycleActionBar(
  resource: "goal" | "loop" | "repro",
  title: string,
  labels: { status: string; start: string; restart: string; stop: string },
): SparkActionBarView {
  return actionBar({
    id: resource,
    title,
    actions: [
      action(`${resource}-status`, labels.status, `${resource}.status`, "primary"),
      action(`${resource}-start`, labels.start, `${resource}.start`),
      action(`${resource}-restart`, labels.restart, `${resource}.restart`),
      action(`${resource}-stop`, labels.stop, `${resource}.stop`, "danger"),
    ],
  });
}

function slashCommand(
  name: string,
  actionBar: SparkActionBarView,
  aliases: readonly string[] = [],
): SparkSlashCommandDescriptor {
  return Object.freeze({
    name,
    aliases: Object.freeze([...aliases]),
    actionBar,
  });
}

function indexSlashCommandDescriptors(
  descriptors: readonly SparkSlashCommandDescriptor[],
): ReadonlyMap<string, SparkSlashCommandDescriptor> {
  const indexed = new Map<string, SparkSlashCommandDescriptor>();
  for (const descriptor of descriptors) {
    for (const name of [descriptor.name, ...descriptor.aliases]) {
      if (indexed.has(name)) throw new Error(`Duplicate Spark slash command name: ${name}`);
      indexed.set(name, descriptor);
    }
  }
  return indexed;
}

function slashSuggestionsForQuery(query: string): readonly SparkSlashSuggestion[] {
  const canonicalMatches: SparkSlashSuggestion[] = [];
  const aliasMatches: SparkSlashSuggestion[] = [];

  for (const descriptor of sparkSlashCommandDescriptors) {
    if (!query || descriptor.name.startsWith(query)) {
      canonicalMatches.push(slashSuggestion(descriptor.name, descriptor));
      continue;
    }

    const alias = descriptor.aliases.find((candidate) => candidate.startsWith(query));
    if (alias) aliasMatches.push(slashSuggestion(alias, descriptor));
  }

  return Object.freeze([...canonicalMatches, ...aliasMatches]);
}

function slashSuggestion(
  command: string,
  descriptor: SparkSlashCommandDescriptor,
): SparkSlashSuggestion {
  return Object.freeze({
    command,
    canonicalCommand: descriptor.name,
    descriptor,
  });
}
