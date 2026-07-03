import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import { sparkTuiPiParityStrings } from "@zendev-lab/spark-i18n/cli";

import type {
  SparkNativeMessage,
  SparkNativeSlashCommandContext,
  SparkNativeSlashCommandMap,
} from "../native-tui.ts";
import {
  exportSparkSessionRecord,
  formatBranchRows,
  formatSessionList,
  formatSessionReplay,
  getSparkSessionLeafId,
  readSparkSessionExportFormat,
} from "../host/session-navigation.ts";
import {
  sparkSessionRecordToHtmlMessages,
  writeSparkTranscriptHtml,
  type SparkHtmlTranscriptMessage,
} from "../host/html-export.ts";
import {
  compactSparkVisibleTranscript,
  navigateSparkSessionBranchWithSummary,
} from "../host/compaction.ts";
import { listOAuthProviderSummaries } from "../host/auth.ts";
import type { SparkCliHostServices } from "../host/index.ts";
import type { SparkConfig } from "../host/config.ts";
import type { SparkSessionMessage, SparkSessionRecord } from "../host/session-store.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const STRINGS = sparkTuiPiParityStrings();

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
      description: STRINGS.descriptions.settings,
      argumentHint: "[set thinking <off|minimal|low|medium|high|xhigh>|set theme <id>]",
      getArgumentCompletions: (prefix) => settingsCompletions(prefix),
      handler: async (args) => handleSettingsCommand(services, args),
    },
    "scoped-models": {
      description: STRINGS.descriptions.scopedModels,
      handler: () => renderScopedModels(services),
    },
    export: {
      description: STRINGS.descriptions.export,
      argumentHint: "[json|jsonl|text|html] [session-id|path] [output.html]",
      getArgumentCompletions: (prefix) => exportCompletions(prefix),
      handler: async (args, ctx) => handleExportCommand(services, args, ctx.session.messages),
    },
    import: {
      description: STRINGS.descriptions.import,
      argumentHint: "<jsonl-path>",
      handler: async (args) => handleImportCommand(services, args),
    },
    share: {
      description: STRINGS.descriptions.share,
      argumentHint: "[session-id|path] [output.html]",
      handler: async (args, ctx) => handleShareCommand(services, args, ctx.session.messages),
    },
    copy: {
      description: STRINGS.descriptions.copy,
      handler: (_args, ctx) =>
        lastAssistantMessage(ctx.session.messages) ?? STRINGS.noAssistantMessage,
    },
    name: {
      description: STRINGS.descriptions.name,
      argumentHint: "[name]",
      handler: (args, ctx) => handleNameCommand(ctx.session.messages, args),
    },
    session: {
      description: STRINGS.descriptions.session,
      handler: (_args, ctx) => renderNativeSessionInfo(ctx.session.messages),
    },
    changelog: {
      description: STRINGS.descriptions.changelog,
      handler: () => STRINGS.changelog,
    },
    hotkeys: {
      description: STRINGS.descriptions.hotkeys,
      handler: () => renderHotkeys(services),
    },
    fork: {
      description: STRINGS.descriptions.fork,
      handler: async (_args, ctx) => forkVisibleTranscript(services, ctx.session.messages),
    },
    clone: {
      description: STRINGS.descriptions.clone,
      handler: async (_args, ctx) => cloneVisibleTranscript(services, ctx.session.messages),
    },
    tree: {
      description: STRINGS.descriptions.tree,
      argumentHint: "[session-id|path] [summarize <entry-id> [instructions]]",
      handler: async (args) => handleTreeCommand(services, args),
    },
    trust: {
      description: STRINGS.descriptions.trust,
      handler: () => STRINGS.trust(services.cwd),
    },
    login: {
      description: STRINGS.descriptions.login,
      argumentHint: "[oauth-provider]",
      getArgumentCompletions: (prefix) => oauthProviderCompletions(prefix),
      handler: async (args, ctx) => handleLoginCommand(services, args, ctx),
    },
    logout: {
      description: STRINGS.descriptions.logout,
      argumentHint: "<provider>",
      getArgumentCompletions: (prefix) => storedCredentialCompletions(services, prefix),
      handler: async (args) => handleLogoutCommand(services, args),
    },
    new: {
      description: STRINGS.descriptions.new,
      handler: (_args, ctx) => {
        ctx.session.clearTranscript(STRINGS.newTranscript);
      },
    },
    compact: {
      description: STRINGS.descriptions.compact,
      argumentHint: "[custom instructions]",
      handler: async (args, ctx) => handleCompactCommand(services, args, ctx.session.messages),
    },
    resume: {
      description: STRINGS.descriptions.resume,
      argumentHint: "[session-id|path]",
      handler: async (args) => handleResumeCommand(services, args),
    },
    reload: {
      description: STRINGS.descriptions.reload,
      handler: () => STRINGS.reload,
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
    "set theme dark",
    "set theme light",
  ];
  return filterValues(options, prefix).map((value) => ({ value, label: value }));
}

function exportCompletions(prefix: string): Array<{ value: string; label: string }> {
  return filterValues(["json", "jsonl", "text", "html"], prefix).map((value) => ({
    value,
    label: value,
  }));
}

function oauthProviderCompletions(prefix: string): Array<{ value: string; label: string }> {
  return filterValues(
    listOAuthProviderSummaries().map((provider) => provider.id),
    prefix,
  ).map((value) => ({ value, label: value }));
}

function storedCredentialCompletions(
  services: SparkCliHostServices,
  prefix: string,
): Array<{ value: string; label: string }> {
  return filterValues(services.authStore?.listProviders() ?? [], prefix).map((value) => ({
    value,
    label: value,
  }));
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
      return STRINGS.settingsUsageThinking(THINKING_LEVELS);
    }
    services.config.activeThinkingLevel = level;
    await services.saveConfig?.(services.config);
    return STRINGS.thinkingLevelSet(level);
  }
  if (tokens[0] === "set" && tokens[1] === "theme") {
    const themeId = tokens[2];
    const themes = services.themeCatalog?.themes ?? [];
    if (!themeId || !themes.some((theme) => theme.id === themeId)) {
      return STRINGS.settingsUsageTheme(themes.map((theme) => theme.id));
    }
    services.config.activeTheme = themeId;
    await services.saveConfig?.(services.config);
    return STRINGS.themeSet(themeId);
  }

  const active = services.modelSelector.getActive();
  const lines = [
    `${STRINGS.settingsHeader}:`,
    `cwd: ${services.cwd}`,
    `active model: ${active ? `${active.providerName}/${active.modelId}` : "none"}`,
    `thinking level: ${services.config.activeThinkingLevel ?? "default"}`,
    `theme: ${services.theme?.id ?? services.config.activeTheme ?? "dark"}`,
    `extensions: ${services.config.extensions.length}`,
    `providers: ${services.providerRegistry.listProviders().length}`,
    `prompt templates: ${services.promptTemplates?.templates.length ?? 0}`,
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
  const items = services.modelSelector.getPickerState().items;
  if (items.length === 0) return STRINGS.noModelsRegistered;
  return items
    .map((model) => `${model.active ? "*" : " "} ${model.value} — ${model.description}`)
    .join("\n");
}

async function handleExportCommand(
  services: SparkCliHostServices,
  args: string,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const first = tokens[0];
  const format =
    first === "json" || first === "jsonl" || first === "text" || first === "html"
      ? first
      : undefined;
  if (format === "html") {
    return await handleHtmlExportCommand(services, tokens.slice(1), messages, "export");
  }

  const sessionRef = format ? tokens[1] : first;
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

async function handleShareCommand(
  services: SparkCliHostServices,
  args: string,
  messages: readonly SparkNativeMessage[],
): Promise<string> {
  const result = await handleHtmlExportCommand(
    services,
    args.trim().split(/\s+/u).filter(Boolean),
    messages,
    "share",
  );
  return [
    result.replace(/^Exported HTML:/u, "Share-safe HTML export:"),
    STRINGS.noExternalUpload,
  ].join("\n");
}

async function handleHtmlExportCommand(
  services: SparkCliHostServices,
  tokens: readonly string[],
  messages: readonly SparkNativeMessage[],
  kind: "export" | "share",
): Promise<string> {
  const target = parseHtmlExportTarget(tokens);
  if (target.sessionRef) {
    const record = await services.sessionStore.loadByRef(target.sessionRef);
    const result = await writeSparkTranscriptHtml(
      {
        title: `Spark session ${record.header.id}`,
        cwd: record.header.cwd,
        sessionId: record.header.id,
        messages: sparkSessionRecordToHtmlMessages(record),
        theme: services.theme,
      },
      {
        cwd: services.cwd,
        sparkHome: sparkHomeForExports(services),
        kind,
        outputPath: target.outputPath,
        filenameStem: `spark-${kind}-${record.header.id}`,
      },
    );
    return `Exported HTML: ${result.path}`;
  }

  const result = await writeSparkTranscriptHtml(
    {
      title: "Spark visible transcript",
      cwd: services.cwd,
      sessionId: `visible-${Date.now().toString(36)}`,
      messages: visibleTranscriptHtmlMessages(messages),
      theme: services.theme,
    },
    {
      cwd: services.cwd,
      sparkHome: sparkHomeForExports(services),
      kind,
      outputPath: target.outputPath,
      filenameStem: `spark-${kind}-visible-${Date.now().toString(36)}`,
    },
  );
  return `Exported HTML: ${result.path}`;
}

async function handleImportCommand(services: SparkCliHostServices, args: string): Promise<string> {
  const filePath = args.trim();
  if (!filePath) return STRINGS.importUsage;
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
  const lines = [`${STRINGS.nativeSessionHeader}:`, `messages: ${messages.length}`];
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
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const sessionRef = tokens[0];
  if (!sessionRef) return formatSessionList(await services.sessionStore.list());
  const record = await services.sessionStore.loadByRef(sessionRef);
  if (tokens[1] === "summarize" || tokens[1] === "summary") {
    const targetId = tokens[2];
    if (!targetId)
      return "Usage: /tree <session-id|path> summarize <entry-id> [custom instructions]";
    const result = navigateSparkSessionBranchWithSummary(record, targetId, {
      summarize: true,
      customInstructions: tokens.slice(3).join(" ") || undefined,
    });
    await services.sessionStore.save(record);
    return [
      `Branch summary appended: ${result.summaryEntry?.id ?? "none"}`,
      `Active branch: ${result.activeLeafId ?? "root"}`,
      formatBranchRows(branchRowsForRecord(record)),
    ].join("\n");
  }
  return formatBranchRows(branchRowsForRecord(record));
}

async function handleCompactCommand(
  services: SparkCliHostServices,
  args: string,
  messages: SparkNativeMessage[],
): Promise<string> {
  const customInstructions = args.trim() || undefined;
  const beforeCompactResults = await services.runtime.emit("session_before_compact", {
    reason: "manual",
    customInstructions,
    willRetry: false,
    consumeMessage: true,
  });
  const checkpointMessages = compactCheckpointMessagesFromEvents(beforeCompactResults);
  const messagesForCompaction =
    checkpointMessages.length > 0 ? [...messages, ...checkpointMessages] : messages;
  const result = await compactSparkVisibleTranscript(services.sessionStore, messagesForCompaction, {
    customInstructions,
  });
  if (!result) return "Nothing to compact (visible transcript is too small).";

  const firstMessageIndex = messages.findIndex(
    (message) => message.display !== false && message.text.trim().length > 0,
  );
  const deleteStart = firstMessageIndex < 0 ? 0 : firstMessageIndex;
  messages.splice(deleteStart, messages.length - deleteStart, {
    role: "custom",
    customType: "compactionSummary",
    text: `Compacted visible transcript summary:\n${result.entry.summary}`,
  });
  for (const kept of result.keptMessages) {
    messages.push({ role: normalizeSessionMessageRole(kept.role), text: sessionMessageText(kept) });
  }
  await services.runtime.emit("session_compact", {
    reason: "manual",
    customInstructions,
    willRetry: false,
    sessionId: result.record.header.id,
    compactionEntryId: result.entry.id,
  });
  return `Compacted visible Spark transcript into session ${result.record.header.id} (${result.entry.tokensBefore} estimated tokens before compaction).`;
}

function compactCheckpointMessagesFromEvents(results: unknown[]): SparkNativeMessage[] {
  const messages: SparkNativeMessage[] = [];
  for (const result of results) {
    const message = isRecord(result) ? result.message : undefined;
    if (!isRecord(message)) continue;
    const customType = typeof message.customType === "string" ? message.customType : undefined;
    const content = typeof message.content === "string" ? message.content : undefined;
    if (!customType || !content) continue;
    messages.push({
      role: "custom",
      customType,
      text: content,
      display: true,
      details: isRecord(message.details) ? message.details : undefined,
    });
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function branchRowsForRecord(record: SparkSessionRecord) {
  return record.entries.length === 0
    ? []
    : record.entries.map((entry, index) => ({
        id: entry.id,
        depth: entry.parentId ? 1 : 0,
        active: entry.id === getSparkSessionLeafId(record),
        label: `${index + 1}. ${entry.type}${entry.type === "branch_summary" ? ` — ${entry.summary.slice(0, 80)}` : ""}`,
        description: entry.timestamp,
        entry,
      }));
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

function normalizeSessionMessageRole(role: string): SparkNativeMessage["role"] {
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "toolResult") return "tool";
  return "custom";
}

function sessionMessageText(message: SparkSessionMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
      if (record.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
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

function visibleTranscriptHtmlMessages(
  messages: readonly SparkNativeMessage[],
): SparkHtmlTranscriptMessage[] {
  return exportableMessages(messages).map((message) => ({
    role: message.role,
    label: htmlMessageLabel(message),
    text: message.text,
    details: htmlMessageDetails(message),
  }));
}

function htmlMessageLabel(message: SparkNativeMessage): string {
  if (message.role === "tool") return `tool:${message.toolName ?? "tool"}`;
  if (message.role === "custom") return message.customType ?? "custom";
  return message.role;
}

function htmlMessageDetails(message: SparkNativeMessage): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  if (message.toolCallId) details.toolCallId = message.toolCallId;
  if (message.toolStatus) details.status = message.toolStatus;
  if (message.details && typeof message.details === "object") details.details = message.details;
  return Object.keys(details).length ? details : undefined;
}

function parseHtmlExportTarget(tokens: readonly string[]): {
  sessionRef?: string;
  outputPath?: string;
} {
  const [first, second] = tokens;
  if (!first) return {};
  if (isHtmlPath(first)) return { outputPath: first };
  return { sessionRef: first, ...(second ? { outputPath: second } : {}) };
}

function isHtmlPath(value: string): boolean {
  return value.toLowerCase().endsWith(".html") || value.toLowerCase().endsWith(".htm");
}

function sparkHomeForExports(services: SparkCliHostServices): string | undefined {
  const root = services.sessionStore.sessionsRoot;
  return basename(root) === "sessions" ? dirname(root) : undefined;
}

function lastAssistantMessage(messages: readonly SparkNativeMessage[]): string | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant")?.text;
}

async function handleLoginCommand(
  services: SparkCliHostServices,
  args: string,
  ctx: SparkNativeSlashCommandContext,
): Promise<string> {
  if (!services.authStore) return STRINGS.authStoreUnavailable;
  const providerId = args.trim();
  if (!providerId) return renderAuthSummary(services);

  const supported = listOAuthProviderSummaries();
  if (!supported.some((provider) => provider.id === providerId)) {
    return [
      `Unknown OAuth provider: ${providerId}`,
      `Supported OAuth providers: ${supported.map((provider) => provider.id).join(", ") || "none"}`,
      renderProviderSummary(services),
    ].join("\n");
  }

  const progress: string[] = [];
  const callbacks = createOAuthLoginCallbacks(services, ctx, progress);
  await services.authStore.loginOAuth(providerId, callbacks);
  return [`Logged in OAuth provider: ${providerId}`, ...progress].join("\n");
}

async function handleLogoutCommand(services: SparkCliHostServices, args: string): Promise<string> {
  if (!services.authStore) return STRINGS.authStoreUnavailable;
  const providerId = args.trim();
  if (!providerId) {
    const stored = services.authStore.listProviders();
    return stored.length ? STRINGS.logoutUsageStored(stored) : STRINGS.logoutUsageEmpty;
  }

  const provider = services.providerRegistry.getProvider(providerId);
  const status = provider && services.authResolver?.status(provider);
  if (status && status.kind !== "oauth" && !services.authStore.has(providerId)) {
    return `Provider ${providerId} uses ${status.kind} auth${status.ref ? ` (${status.ref})` : ""}; remove it from its environment/config source instead of Spark auth.json.`;
  }

  const removed = await services.authStore.remove(providerId);
  return removed ? STRINGS.removedCredential(providerId) : STRINGS.noCredential(providerId);
}

function createOAuthLoginCallbacks(
  services: SparkCliHostServices,
  ctx: SparkNativeSlashCommandContext,
  progress: string[],
): OAuthLoginCallbacks {
  const push = (message: string) => {
    progress.push(message);
    ctx.session.addSystemMessage(message);
  };
  return {
    onAuth: (info) => {
      push(
        [
          `Open OAuth authorization URL: ${info.url}`,
          info.instructions ? `Instructions: ${info.instructions}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
    onDeviceCode: (info) => {
      push(
        [
          `OAuth device code: ${info.userCode}`,
          `Verification URL: ${info.verificationUri}`,
          info.expiresInSeconds ? `Expires in: ${info.expiresInSeconds}s` : undefined,
          info.intervalSeconds ? `Polling interval: ${info.intervalSeconds}s` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
    onProgress: (message) => push(`OAuth: ${message}`),
    onPrompt: async (prompt) => {
      const value = await services.runtime
        .makeContext()
        .ui?.input?.(prompt.message, prompt.placeholder);
      if (value !== undefined) return value;
      if (prompt.allowEmpty) return "";
      throw new Error(`OAuth provider requested interactive input: ${prompt.message}`);
    },
    onManualCodeInput: async () => {
      const value = await services.runtime
        .makeContext()
        .ui?.input?.("Enter OAuth callback code", undefined);
      if (value !== undefined) return value;
      throw new Error("OAuth provider requested manual code input, but this UI cannot collect it.");
    },
    onSelect: async (prompt) => {
      const selected = await services.runtime.makeContext().ui?.select?.(
        prompt.message,
        prompt.options.map((option) => option.id),
      );
      return selected ?? prompt.options[0]?.id;
    },
  };
}

function renderAuthSummary(services: SparkCliHostServices): string {
  const oauthProviders = listOAuthProviderSummaries();
  const lines = [
    "Spark provider authentication:",
    `auth store: ${services.authStore?.path ?? "unavailable"}`,
    `supported OAuth providers: ${oauthProviders.map((provider) => provider.id).join(", ") || "none"}`,
    renderProviderSummary(services),
  ];
  const stored = services.authStore?.listProviders() ?? [];
  lines.push(
    stored.length
      ? `stored Spark credentials: ${stored.join(", ")}`
      : "stored Spark credentials: none",
  );
  return lines.join("\n");
}

function renderProviderSummary(services: SparkCliHostServices): string {
  const providers = services.providerRegistry.listProviders();
  if (providers.length === 0) return "No providers registered.";
  const rendered = providers.map((provider) => {
    const status = services.authResolver?.status(provider);
    const auth = status
      ? `${status.kind}${status.ref ? `:${status.ref}` : ""}=${status.configured ? "configured" : "missing"}`
      : "auth=unknown";
    return `${provider.name} (${auth})`;
  });
  return `Registered providers: ${rendered.join(", ")}`;
}
