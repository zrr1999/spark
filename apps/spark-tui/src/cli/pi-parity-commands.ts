import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { SparkNativeMessage, SparkNativeSlashCommandMap } from "../native-tui.ts";
import {
  exportSparkSessionRecord,
  formatBranchRows,
  formatSessionList,
  formatSessionReplay,
  getSparkSessionLeafId,
  readSparkSessionExportFormat,
} from "../host/session-navigation.ts";
import type { SparkCliHostServices } from "../host/index.ts";
import type { SparkConfig } from "../host/config.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type SparkThinkingLevel = NonNullable<SparkConfig["activeThinkingLevel"]>;

const PI_COMMANDS = [
  "settings",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
] as const;

export const PI_PARITY_COMMAND_NAMES: readonly string[] = PI_COMMANDS;

export function createSparkPiParitySlashCommands(
  services: SparkCliHostServices,
): SparkNativeSlashCommandMap {
  return {
    settings: {
      description: "show Spark settings and provider/session configuration",
      argumentHint: "[set thinking <off|minimal|low|medium|high|xhigh>]",
      getArgumentCompletions: (prefix) => settingsCompletions(prefix),
      handler: async (args) => handleSettingsCommand(services, args),
    },
    "scoped-models": {
      description: "show models enabled for Spark model selection/cycling",
      handler: () => renderScopedModels(services),
    },
    export: {
      description: "export visible Spark transcript or a persisted session",
      argumentHint: "[json|jsonl|text] [session-id|path]",
      getArgumentCompletions: (prefix) => exportCompletions(prefix),
      handler: async (args, ctx) => handleExportCommand(services, args, ctx.session.messages),
    },
    import: {
      description: "import a Spark/Pi JSONL session and show resume guidance",
      argumentHint: "<jsonl-path>",
      handler: async (args) => handleImportCommand(services, args),
    },
    share: {
      description: "prepare a share-safe session export through Spark artifact workflow",
      handler: () =>
        "Spark share is daemon-first: use /export json or /export text, then record/share via the artifact tool or cockpit. Secret Gist upload is intentionally not automatic.",
    },
    copy: {
      description: "copy/show the last Spark assistant message",
      handler: (_args, ctx) =>
        lastAssistantMessage(ctx.session.messages) ?? "No assistant message to copy yet.",
    },
    name: {
      description: "set or show the current Spark session display name",
      argumentHint: "[name]",
      handler: (args, ctx) => handleNameCommand(ctx.session.messages, args),
    },
    session: {
      description: "show Spark native session info and transcript stats",
      handler: (_args, ctx) => renderNativeSessionInfo(ctx.session.messages),
    },
    changelog: {
      description: "show Spark parity changelog highlights",
      handler: () =>
        [
          "Spark native TUI parity highlights:",
          "- daemon-first native pi-tui host",
          "- slash autocomplete and /model selection",
          "- native widget factory rendering",
          "- Spark cockpit panels for workflows, runs, tasks, artifacts, reviews, and Graft",
        ].join("\n"),
    },
    hotkeys: {
      description: "show all Spark keyboard shortcuts",
      handler: () => renderHotkeys(services),
    },
    fork: {
      description: "fork the current visible transcript into a new Spark session record",
      handler: async (_args, ctx) => forkVisibleTranscript(services, ctx.session.messages),
    },
    clone: {
      description: "clone the current visible transcript into a new Spark session record",
      handler: async (_args, ctx) => cloneVisibleTranscript(services, ctx.session.messages),
    },
    tree: {
      description: "show the active persisted session tree or recent sessions",
      handler: async (args) => handleTreeCommand(services, args),
    },
    trust: {
      description: "show Spark project trust status and safe next steps",
      handler: () =>
        `Spark trusts this workspace only through explicit config and tool-approval flows. cwd=${services.cwd}`,
    },
    login: {
      description: "show provider authentication setup for Spark providers",
      handler: () =>
        [
          "Spark provider authentication is provider-plugin based.",
          "Configure API keys through provider environment variables or ~/.spark/config.json provider plugins, then /reload.",
          renderProviderSummary(services),
        ].join("\n"),
    },
    logout: {
      description: "show provider credential removal guidance",
      handler: () =>
        "Remove the provider credential from its environment/config source, then run /reload. Spark does not delete secrets implicitly.",
    },
    new: {
      description: "start a new visible Spark transcript",
      handler: (_args, ctx) => {
        ctx.session.clearTranscript("Started a new Spark native transcript.");
      },
    },
    compact: {
      description: "summarize visible Spark transcript and clear older context",
      handler: (_args, ctx) => compactVisibleTranscript(ctx.session.messages),
    },
    resume: {
      description: "list or preview a persisted Spark session for resume",
      argumentHint: "[session-id|path]",
      handler: async (args) => handleResumeCommand(services, args),
    },
    reload: {
      description: "reload Spark keybindings/settings guidance",
      handler: () =>
        "Restart or relaunch the native Spark TUI to reload extensions, providers, skills, prompts, themes, and keybindings from disk.",
    },
  };
}

function settingsCompletions(prefix: string): Array<{ value: string; label: string }> {
  const options = [
    "set thinking off",
    "set thinking minimal",
    "set thinking low",
    "set thinking medium",
    "set thinking high",
    "set thinking xhigh",
  ];
  return filterValues(options, prefix).map((value) => ({ value, label: value }));
}

function exportCompletions(prefix: string): Array<{ value: string; label: string }> {
  return filterValues(["json", "jsonl", "text"], prefix).map((value) => ({ value, label: value }));
}

function filterValues(values: readonly string[], prefix: string): string[] {
  const normalized = prefix.trim().toLowerCase();
  return values.filter((value) => value.toLowerCase().startsWith(normalized));
}

async function handleSettingsCommand(
  services: SparkCliHostServices,
  args: string,
): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  if (tokens[0] === "set" && tokens[1] === "thinking") {
    const level = tokens[2];
    if (!isThinkingLevel(level)) {
      return `Usage: /settings set thinking ${THINKING_LEVELS.join("|")}`;
    }
    services.config.activeThinkingLevel = level;
    return `Spark thinking level set for this session: ${level}. Persisted config updates are handled by the provider/settings parity task.`;
  }

  const active = services.modelSelector.getActive();
  const lines = [
    "Spark settings:",
    `cwd: ${services.cwd}`,
    `active model: ${active ? `${active.providerName}/${active.modelId}` : "none"}`,
    `thinking level: ${services.config.activeThinkingLevel ?? "default"}`,
    `extensions: ${services.config.extensions.length}`,
    `providers: ${services.providerRegistry.listProviders().length}`,
  ];
  if (services.diagnostics.length) {
    lines.push("diagnostics:");
    for (const diagnostic of services.diagnostics)
      lines.push(`- ${diagnostic.type}: ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function isThinkingLevel(value: string | undefined): value is SparkThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value ?? "");
}

function renderScopedModels(services: SparkCliHostServices): string {
  const groups = services.modelSelector.listProviderGroups();
  if (groups.length === 0) return "No Spark providers/models are registered.";
  return groups
    .map((group) => {
      const header = `${group.active ? "*" : " "} ${group.providerName}`;
      const models = group.models.map((model) => `  ${model.active ? "*" : " "} ${model.modelId}`);
      return [header, ...models].join("\n");
    })
    .join("\n");
}

async function handleExportCommand(
  services: SparkCliHostServices,
  args: string,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const [first, second] = args.trim().split(/\s+/u).filter(Boolean);
  const format = first === "json" || first === "jsonl" || first === "text" ? first : undefined;
  const sessionRef = format ? second : first;
  if (sessionRef) {
    const record = await services.sessionStore.loadByRef(sessionRef);
    return exportSparkSessionRecord(record, {
      format: format ? readSparkSessionExportFormat(format) : "jsonl",
    });
  }
  if (format === "jsonl") return visibleTranscriptJsonl(services, messages);
  if (format === "text" || !format) return visibleTranscriptText(messages);
  return JSON.stringify(
    { version: 1, cwd: services.cwd, messages: exportableMessages(messages) },
    null,
    2,
  );
}

async function handleImportCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const filePath = args.trim();
  if (!filePath) return "Usage: /import <jsonl-path>";
  const record = await services.sessionStore.load(filePath);
  return `Imported Spark/Pi session ${record.header.id} from ${basename(filePath)}. Resume with /resume ${record.header.id} or inspect with /tree ${record.header.id}.`;
}

function handleNameCommand(messages: SparkNativeMessage[], args: string): string {
  const name = args.trim();
  const existing = [...messages].reverse().find((message) => message.customType === "session_name");
  if (!name) return existing ? `Session name: ${existing.text}` : "No Spark session name set.";
  messages.push({ role: "custom", customType: "session_name", text: name, display: false });
  return `Session name set: ${name}`;
}

function renderNativeSessionInfo(messages: readonly SparkNativeMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  const lines = ["Spark native session:", `messages: ${messages.length}`];
  for (const [role, count] of [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`${role}: ${count}`);
  }
  return lines.join("\n");
}

function renderHotkeys(services: SparkCliHostServices): string {
  return services.keybindings
    .snapshot()
    .bindings.map((binding) => `${binding.key} — ${binding.id}: ${binding.description}`)
    .join("\n");
}

async function forkVisibleTranscript(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const record = services.sessionStore.createSession({ id: `fork-${randomUUID()}` });
  for (const message of exportableMessages(messages)) {
    services.sessionStore.appendMessage(record, {
      role: message.role,
      content: message.text,
      timestamp: Date.now(),
    });
  }
  await services.sessionStore.save(record);
  return `Forked visible transcript into Spark session ${record.header.id}`;
}

async function cloneVisibleTranscript(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const record = services.sessionStore.createSession({ id: `clone-${randomUUID()}` });
  for (const message of exportableMessages(messages)) {
    services.sessionStore.appendMessage(record, {
      role: message.role,
      content: message.text,
      timestamp: Date.now(),
    });
  }
  await services.sessionStore.save(record);
  return `Cloned visible transcript into Spark session ${record.header.id}`;
}

async function handleTreeCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const sessionRef = args.trim();
  if (!sessionRef) return formatSessionList(await services.sessionStore.list());
  const record = await services.sessionStore.loadByRef(sessionRef);
  return formatBranchRows(
    record.entries.length === 0
      ? []
      : record.entries.map((entry, index) => ({
          id: entry.id,
          depth: entry.parentId ? 1 : 0,
          active: entry.id === getSparkSessionLeafId(record),
          label: `${index + 1}. ${entry.type}`,
          description: entry.timestamp,
          entry,
        })),
  );
}

function compactVisibleTranscript(messages: SparkNativeMessage[]): string {
  const exportable = exportableMessages(messages);
  if (exportable.length === 0) return "No visible transcript messages to compact.";
  const summary = exportable
    .slice(-8)
    .map((message) => `${message.role}: ${message.text.replace(/\s+/gu, " ").slice(0, 120)}`)
    .join("\n");
  messages.splice(1, Math.max(0, messages.length - 2), {
    role: "system",
    text: `Compacted visible transcript summary:\n${summary}`,
  });
  return "Compacted visible Spark transcript into a summary message.";
}

async function handleResumeCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const sessionRef = args.trim();
  if (!sessionRef) return formatSessionList(await services.sessionStore.list());
  const record = await services.sessionStore.loadByRef(sessionRef);
  return [
    `Resume target: ${record.header.id}`,
    formatSessionReplay(record),
    "Submit a new prompt to continue this Spark daemon session, or use /tree to inspect branches.",
  ].join("\n");
}

function visibleTranscriptText(messages: readonly SparkNativeMessage[]): string {
  const exportable = exportableMessages(messages);
  if (exportable.length === 0) return "No visible transcript messages yet.";
  return exportable.map((message) => `${message.role}> ${message.text}`).join("\n");
}

function visibleTranscriptJsonl(
  services: SparkCliHostServices,
  messages: readonly SparkNativeMessage[],
): string {
  const now = new Date().toISOString();
  const header = {
    type: "session",
    version: 3,
    id: `visible-${Date.now().toString(36)}`,
    timestamp: now,
    cwd: services.cwd,
  };
  const entries = exportableMessages(messages).map((message, index) => ({
    type: "message",
    id: `m${index + 1}`,
    parentId: index === 0 ? null : `m${index}`,
    timestamp: now,
    message: { role: message.role, content: message.text, timestamp: Date.now() },
  }));
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function exportableMessages(messages: readonly SparkNativeMessage[]): SparkNativeMessage[] {
  return messages.filter((message) => message.display !== false && message.text.trim().length > 0);
}

function lastAssistantMessage(messages: readonly SparkNativeMessage[]): string | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant")?.text;
}

function renderProviderSummary(services: SparkCliHostServices): string {
  const providers = services.providerRegistry.listProviders();
  if (providers.length === 0) return "No providers registered.";
  return `Registered providers: ${providers.map((provider) => provider.name).join(", ")}`;
}
