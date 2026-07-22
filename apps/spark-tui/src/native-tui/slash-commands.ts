/** Slash-command factories for the native TUI. */

import {
  SPARK_COCKPIT_PANELS,
  SPARK_NATIVE_KERNEL_SLASH_COMMANDS,
  SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
  type SparkNativeCockpitPanel,
  type SparkNativeRuntimeCommandHost,
  type SparkNativeRuntimeSlashCommandOptions,
  type SparkNativeSlashCommand,
  type SparkNativeSlashCommandMap,
} from "./types.ts";
import { isSparkNativeCockpitPanel } from "./cockpit-helpers.ts";
import { nativeTuiStrings } from "./strings.ts";

function toIterable<T>(value: Iterable<T> | undefined): Iterable<T> {
  return value ?? [];
}

export function parseSlashCommand(input: string): { name: string; args: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) return undefined;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(withoutSlash);
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), args: match[2] ?? "" };
}

export function createSparkNativeLocalControlSlashCommands(): SparkNativeSlashCommandMap {
  const panelCommand = (
    panel: SparkNativeCockpitPanel,
    canonicalCliTarget: string,
    resource: string,
  ): SparkNativeSlashCommand => ({
    description: `open the ${panel} cockpit panel`,
    metadata: {
      source: "extension",
      extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
      plane: canonicalCliTarget.startsWith("spark daemon")
        ? "daemon"
        : canonicalCliTarget.startsWith("spark cockpit")
          ? "cockpit"
          : "tui",
      resource,
      verbs: ["list", "open"],
      canonicalCliTarget,
    },
    handler: (_args, ctx) => ctx.app.openCockpitPanel(panel) || undefined,
  });
  return {
    stop: {
      description: "stop the current Spark turn and clear queued follow-ups",
      argumentHint: "[reason]",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "daemon",
        resource: "run",
        verbs: ["cancel"],
        canonicalCliTarget: "spark daemon run cancel <run>",
      },
      handler: (args, ctx) => {
        const result = ctx.session.abort(args.trim() || "user stop");
        if (result.restoredText) ctx.app.setEditorText(result.restoredText);
        if (result.aborted) return;
        return result.clearedQueued > 0
          ? `Restored ${result.clearedQueued} queued input(s) to the editor.`
          : nativeTuiStrings.noTurnRunning;
      },
    },
    retry: {
      description: "resubmit the previous user prompt",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "tui",
        resource: "session",
        verbs: ["retry"],
        canonicalCliTarget: "spark tui retry",
      },
      handler: (_args, ctx) => {
        void ctx.session.retryLast();
      },
    },
    thinking: {
      description: "choose or set the active thinking level",
      argumentHint: "[off|minimal|low|medium|high|xhigh]",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "tui",
        resource: "thinking",
        verbs: ["select", "set"],
        canonicalCliTarget: "spark tui settings set thinking <level>",
      },
      getArgumentCompletions: (prefix) =>
        ["off", "minimal", "low", "medium", "high", "xhigh"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const level = args.trim().toLowerCase();
        if (!level) return;
        await ctx.app.executeSlashCommand(`/settings set thinking ${level}`);
      },
    },
    queue: {
      description: "inspect or restore queued turn input",
      argumentHint: "[inspect|restore]",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "tui",
        resource: "queue",
        verbs: ["inspect", "restore"],
        canonicalCliTarget: "spark tui queue",
      },
      getArgumentCompletions: (prefix) =>
        ["inspect", "restore"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: (args, ctx) => {
        const action = args.trim().toLowerCase();
        if (!action || action === "inspect") return ctx.app.renderQueueInspection();
        if (action === "restore") {
          const restored = ctx.session.restoreQueuedText();
          if (!restored) return nativeTuiStrings.noQueuedInputToRestore;
          ctx.app.setEditorText(restored);
          return;
        }
        return "Usage: /queue [inspect|restore]";
      },
    },
    cockpit: {
      description: "show Spark cockpit panels",
      argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "cockpit",
        resource: "status",
        verbs: ["open"],
        canonicalCliTarget: "spark cockpit status",
      },
      getArgumentCompletions: (prefix) =>
        ["overview", "workflows", "runs", "tasks", "artifacts", "reviews", "graft", "off"]
          .filter((value) => value.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: (args, ctx) => ctx.app.openCockpitPanelFromArgs(args) || undefined,
    },
    workflows: panelCommand("workflows", "spark cockpit workflow list", "workflow"),
    runs: panelCommand("runs", "spark daemon run list", "run"),
    run: panelCommand("runs", "spark daemon run list", "run"),
    tasks: panelCommand("tasks", "spark cockpit task list", "task"),
    task: panelCommand("tasks", "spark cockpit task list", "task"),
    artifacts: panelCommand("artifacts", "spark cockpit artifact list", "artifact"),
    artifact: panelCommand("artifacts", "spark cockpit artifact list", "artifact"),
    evidence: panelCommand("artifacts", "spark cockpit artifact list", "artifact"),
    reviews: panelCommand("reviews", "spark cockpit review list", "review"),
    review: panelCommand("reviews", "spark cockpit review list", "review"),
    graft: panelCommand("graft", "spark cockpit status", "graft"),
  };
}

export function createSparkNativeRuntimeSlashCommands(
  runtime: SparkNativeRuntimeCommandHost,
  options: SparkNativeRuntimeSlashCommandOptions = {},
): SparkNativeSlashCommandMap {
  const excluded = new Set([...toIterable(options.exclude)].map((name) => name.toLowerCase()));
  const commands: SparkNativeSlashCommandMap = {};
  for (const { name, command } of runtime.listCommands()) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || excluded.has(normalizedName)) continue;
    commands[normalizedName] = {
      description: command.description,
      argumentHint: command.argumentHint,
      metadata: command.metadata ?? { source: "extension" },
      getArgumentCompletions: command.getArgumentCompletions,
      handler: async (args, context) => {
        const commandContext = runtime.makeContext({
          waitForIdle: options.waitForIdle ?? (async () => undefined),
          ...(options.sendUserMessage
            ? {
                sendUserMessage: async (content: string) => {
                  await options.sendUserMessage?.(content, context);
                },
              }
            : {}),
          setEditorText:
            options.setEditorText ?? ((text: string) => context.app.setEditorText(text)),
        });
        await command.handler(args, commandContext);
      },
    };
  }
  return commands;
}

export function nativeKernelSlashCommandEntries(): Array<{
  name: (typeof SPARK_NATIVE_KERNEL_SLASH_COMMANDS)[number];
  description: string;
  argumentHint?: string;
}> {
  return [
    { name: "help", description: "show native TUI commands" },
    { name: "exit", description: "exit the native TUI" },
    { name: "quit", description: "exit the native TUI" },
    { name: "clear", description: "clear the visible transcript" },
    { name: "reload", description: "reload extension-owned slash command state" },
  ];
}
