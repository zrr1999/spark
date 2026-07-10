import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { sparkNativeTuiStrings } from "@zendev-lab/spark-i18n/cli";

import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  Markdown,
  matchesKey,
  parseKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
  type Focusable,
  type OverlayOptions,
  type SelectListTheme,
  type SlashCommand,
} from "./tui/pi-tui-adapter.ts";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  parseSparkInteractionRequest,
  parseSparkInteractionResponse,
  parseSparkViewModelEvent,
  type SparkArtifactView,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkRunView,
  type SparkSessionView,
  type SparkTaskView,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";
import type { CommandMetadata, ExtensionCommandContext } from "@zendev-lab/spark-extension-api";

import type { SparkKeybindingContext, SparkKeybindings } from "./host/keybindings.ts";
import {
  BUILTIN_SPARK_THEMES,
  createSparkHostRenderTheme,
  createSparkMarkdownTheme,
  styleSparkDiffLine,
  styleSparkRoleLine,
  type SparkTheme,
} from "./host/theme.ts";
import type {
  RegisteredCommand,
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostRenderTheme,
  SparkHostUiTransport,
} from "./host/types.ts";
import type { SparkModelSelectorTheme, SparkModelSelectorTuiLike } from "./tui/model-selector.ts";

const nativeTuiStrings = sparkNativeTuiStrings();

export type SparkNativeMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "custom"
  | "tool"
  | "thinking";

export type SparkNativeToolStatus = "pending" | "success" | "error";
export type SparkNativeQueueMode = "steer" | "followUp";

export interface SparkNativeMessage {
  role: SparkNativeMessageRole;
  text: string;
  viewId?: string;
  queued?: boolean;
  streaming?: boolean;
  customType?: string;
  display?: boolean;
  details?: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: SparkNativeToolStatus;
  createdAt?: string;
  updatedAt?: string;
  nativeOrder?: number;
}

export interface SparkNativeToolMessageInput {
  toolName: string;
  text: string;
  toolCallId?: string;
  status?: SparkNativeToolStatus;
  details?: Record<string, unknown>;
}

export interface SparkNativeCustomMessageInput {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface SparkNativeResponderContext {
  readonly messages: readonly SparkNativeMessage[];
  readonly signal?: AbortSignal;
  readonly appendAssistantChunk?: (chunk: string) => void;
  readonly finishAssistantMessage?: () => void;
}

export type SparkNativeResponder = (
  input: string,
  context: SparkNativeResponderContext,
) => string | Promise<string>;

interface SparkNativeQueuedInput {
  text: string;
  mode: SparkNativeQueueMode;
}

export interface SparkNativeAbortResult {
  aborted: boolean;
  clearedQueued: number;
  restoredText?: string;
}

export interface SparkNativeSlashCommandContext {
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
  exit(): void;
}

export interface SparkNativeInteractionContext {
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
}

export type SparkNativeInteractionHandler = (
  request: SparkInteractionRequest,
  context: SparkNativeInteractionContext,
) => SparkInteractionResponse | Promise<SparkInteractionResponse>;

export type SparkNativeSlashCommandHandler = (
  args: string,
  context: SparkNativeSlashCommandContext,
) => string | void | Promise<string | void>;

export interface SparkNativeSlashCommand {
  description: string;
  argumentHint?: string;
  metadata?: CommandMetadata;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: SparkNativeSlashCommandHandler;
}

export type SparkNativeSlashCommandMap = Record<string, SparkNativeSlashCommand>;

export interface SparkNativeRuntimeCommandHost {
  listCommands(): Array<{
    name: string;
    command: Pick<
      RegisteredCommand,
      "description" | "argumentHint" | "metadata" | "getArgumentCompletions" | "handler"
    >;
  }>;
  makeContext(
    extra?: Partial<ExtensionCommandContext> & { setEditorText?: (text: string) => void },
  ): ExtensionCommandContext & { setEditorText?: (text: string) => void };
}

export interface SparkNativeRuntimeSlashCommandOptions {
  exclude?: Iterable<string>;
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => void | Promise<void>;
  setEditorText?: (text: string) => void;
}

export const SPARK_NATIVE_KERNEL_SLASH_COMMANDS = [
  "help",
  "exit",
  "quit",
  "clear",
  "reload",
] as const;

const MAX_TRANSCRIPT_MESSAGES = 80;
const MAX_NATIVE_WIDGET_LINES = 12;

interface SparkNativeWidgetComponent {
  render(width?: number): string[];
  invalidate?(): void;
}

interface SparkNativeWidget {
  key: string;
  placement: "aboveEditor" | "belowEditor";
  lines?: string[];
  component?: SparkNativeWidgetComponent;
}

export type SparkNativeCockpitPanel =
  | "overview"
  | "workflows"
  | "runs"
  | "tasks"
  | "artifacts"
  | "reviews"
  | "graft";

interface SparkNativeWorkflowOption {
  selector: string;
  label: string;
  description?: string;
  source: "interaction" | "run";
}

interface SparkNativeCockpitState {
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: SparkSessionView["status"];
  selectedWorkflowRunId?: string;
  readonly workflows: Map<string, SparkNativeWorkflowOption>;
  readonly runs: Map<string, SparkRunView>;
  readonly tasks: Map<string, SparkTaskView>;
  readonly artifacts: Map<string, SparkArtifactView>;
  readonly interactions: Map<string, SparkInteractionRequest>;
}

interface SparkNativeFooterMetrics {
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  totalTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
}

export interface SparkNativeCockpitSnapshot {
  activePanel?: SparkNativeCockpitPanel;
  sessionId?: string;
  sessionStatus?: SparkSessionView["status"];
  workflows: number;
  workflowRuns: number;
  roleRuns: number;
  tasks: number;
  artifacts: number;
  reviews: number;
  graftItems: number;
  interactions: number;
}

const SPARK_COCKPIT_PANELS: readonly SparkNativeCockpitPanel[] = [
  "overview",
  "workflows",
  "runs",
  "tasks",
  "artifacts",
  "reviews",
  "graft",
];
const MAX_COCKPIT_PANEL_ROWS = 6;
const SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID = "spark-tui-local-control";

function isSparkNativeCockpitPanel(value: string): value is SparkNativeCockpitPanel {
  return (SPARK_COCKPIT_PANELS as readonly string[]).includes(value);
}

function isSparkNativeLocalControlCommand(command: SparkNativeSlashCommand): boolean {
  return command.metadata?.extensionId === SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID;
}

function createSparkNativeCockpitState(): SparkNativeCockpitState {
  return {
    workflows: new Map(),
    runs: new Map(),
    tasks: new Map(),
    artifacts: new Map(),
    interactions: new Map(),
  };
}

export class SparkNativeSession {
  readonly messages: SparkNativeMessage[] = [];
  private readonly queuedFollowUps: SparkNativeQueuedInput[] = [];
  private readonly responder: SparkNativeResponder;
  private lastSubmittedInput: string | undefined;
  private processing = false;
  private activeTurnId = 0;
  private currentAbort: AbortController | undefined;
  private nextNativeMessageOrder = 0;

  onChange?: () => void;

  constructor(responder: SparkNativeResponder = defaultSparkNativeResponder) {
    this.responder = responder;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.welcome,
    });
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get queuedCount(): number {
    return this.queuedFollowUps.length;
  }

  async submit(
    input: string,
    options: { mode?: SparkNativeQueueMode } = {},
  ): Promise<"started" | "queued" | "ignored"> {
    const text = input.trim();
    if (!text) return "ignored";
    this.lastSubmittedInput = text;

    if (this.processing) {
      const mode = options.mode ?? "steer";
      this.queuedFollowUps.push({ text, mode });
      this.pushMessage({
        role: "user",
        text: displayNativeSubmittedInput(text),
        queued: true,
        details: { queueMode: mode },
      });
      this.pushMessage({
        role: "system",
        text:
          mode === "followUp"
            ? `Queued follow-up #${this.queuedFollowUps.length}. Use /stop to clear queued work or stop the current turn; Alt+Up restores queued input.`
            : `Queued steering message #${this.queuedFollowUps.length}. Use /stop to clear queued work or stop the current turn; Alt+Up restores queued input.`,
      });
      return "queued";
    }

    void this.process(text);
    return "started";
  }

  async retryLast(): Promise<"started" | "queued" | "ignored"> {
    if (!this.lastSubmittedInput) return "ignored";
    this.pushMessage({ role: "system", text: `Retrying: ${this.lastSubmittedInput}` });
    return await this.submit(this.lastSubmittedInput);
  }

  addSystemMessage(text: string): void {
    this.pushMessage({ role: "system", text });
  }

  addMessageView(message: SparkMessageView): void {
    const native = messageViewToNativeMessage(message);
    const index = this.findMessageViewIndex(native);
    if (index >= 0) {
      this.messages[index] = this.normalizeMessage(native, this.messages[index]);
      this.sortMessagesChronologically();
      this.emitChange();
      return;
    }
    this.pushMessage(native);
  }

  private findMessageViewIndex(native: SparkNativeMessage): number {
    if (native.viewId) {
      const byViewId = this.messages.findIndex((existing) => existing.viewId === native.viewId);
      if (byViewId >= 0) return byViewId;
    }
    if (native.role === "tool" && native.toolCallId) {
      return this.messages.findIndex(
        (existing) => existing.role === "tool" && existing.toolCallId === native.toolCallId,
      );
    }
    return -1;
  }

  toSessionView(sessionId: string = "native"): SparkSessionView {
    const status = this.processing
      ? "streaming"
      : this.queuedFollowUps.length > 0
        ? "queued"
        : "idle";
    return {
      version: SPARK_PROTOCOL_VERSION,
      sessionId,
      status,
      messages: this.messages.map((message, index) => nativeMessageToView(message, index)),
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      metadata: { queuedCount: this.queuedFollowUps.length },
    };
  }

  applySessionView(view: SparkSessionView): void {
    this.messages.splice(
      0,
      this.messages.length,
      ...view.messages.map((message) => this.normalizeMessage(messageViewToNativeMessage(message))),
    );
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  clearTranscript(note: string = "Transcript cleared."): void {
    const welcome = this.messages[0];
    this.messages.splice(0, this.messages.length);
    if (welcome) this.messages.push(welcome);
    this.pushMessage({ role: "system", text: note });
  }

  abort(reason: string = "user stop"): SparkNativeAbortResult {
    const clearedQueued = this.queuedFollowUps.length;
    const restoredText = this.restoreQueuedText();
    if (!this.processing) {
      if (clearedQueued > 0) {
        this.pushMessage({
          role: "system",
          text: `Restored ${clearedQueued} queued input(s) to the editor.`,
        });
      }
      return { aborted: false, clearedQueued, restoredText };
    }

    this.activeTurnId += 1;
    this.currentAbort?.abort(new Error(reason));
    this.currentAbort = undefined;
    this.processing = false;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.stoppedTurn(reason, clearedQueued),
    });
    return { aborted: true, clearedQueued, restoredText };
  }

  restoreQueuedText(): string | undefined {
    if (this.queuedFollowUps.length === 0) return undefined;
    const restored = this.queuedFollowUps.map((entry) => entry.text).join("\n\n");
    this.queuedFollowUps.splice(0, this.queuedFollowUps.length);
    return restored;
  }

  addCustomMessage(input: SparkNativeCustomMessageInput): void {
    this.pushMessage({
      role: "custom",
      text: input.content,
      customType: input.customType,
      display: input.display,
      details: input.details,
    });
  }

  addToolMessage(input: SparkNativeToolMessageInput): void {
    this.pushMessage({
      role: "tool",
      text: input.text,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      toolStatus: input.status ?? "success",
      details: input.details,
    });
  }

  addThinking(text: string, details?: Record<string, unknown>): void {
    this.pushMessage({ role: "thinking", text, details });
  }

  appendAssistantChunk(chunk: string): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant" && tail.streaming) {
      tail.text += chunk;
      this.emitChange();
      return;
    }
    this.pushMessage({ role: "assistant", text: chunk, streaming: true });
  }

  finishAssistantMessage(): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant") {
      tail.streaming = false;
      this.emitChange();
    }
  }

  private pushMessage(message: SparkNativeMessage): void {
    this.messages.push(this.normalizeMessage(message));
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  private normalizeMessage(
    message: SparkNativeMessage,
    existing?: SparkNativeMessage,
  ): SparkNativeMessage {
    return {
      ...message,
      createdAt: message.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
      updatedAt: message.updatedAt ?? existing?.updatedAt,
      nativeOrder: existing?.nativeOrder ?? message.nativeOrder ?? ++this.nextNativeMessageOrder,
    };
  }

  private sortMessagesChronologically(): void {
    this.messages.sort((left, right) => {
      const leftTime = nativeMessageTime(left);
      const rightTime = nativeMessageTime(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return (left.nativeOrder ?? 0) - (right.nativeOrder ?? 0);
    });
  }

  private async process(input: string): Promise<void> {
    this.processing = true;
    const turnId = ++this.activeTurnId;
    const abortController = new AbortController();
    this.currentAbort = abortController;
    this.pushMessage({ role: "user", text: displayNativeSubmittedInput(input) });

    let streamedAssistant = false;
    try {
      const response = await this.responder(input, {
        messages: this.messages,
        signal: abortController.signal,
        appendAssistantChunk: (chunk) => {
          streamedAssistant = true;
          this.appendAssistantChunk(chunk);
        },
        finishAssistantMessage: () => this.finishAssistantMessage(),
      });
      if (this.activeTurnId !== turnId) return;
      if (streamedAssistant) {
        this.finishAssistantMessage();
      } else {
        this.pushMessage({ role: "assistant", text: response });
      }
    } catch (error) {
      if (this.activeTurnId !== turnId) return;
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.turnFailed(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (this.activeTurnId === turnId) {
        this.currentAbort = undefined;
        this.processing = false;
        this.trimTranscript();
        this.emitChange();
      }
    }

    const next = this.nextQueuedSubmission();
    if (next !== undefined) {
      void this.process(next.text);
    }
  }

  private nextQueuedSubmission(): SparkNativeQueuedInput | undefined {
    const next = this.queuedFollowUps.shift();
    if (!next) return undefined;
    if (next.mode === "followUp") return next;

    const steeringInputs = [next.text];
    while (this.queuedFollowUps[0]?.mode === "steer") {
      steeringInputs.push(this.queuedFollowUps.shift()?.text ?? "");
    }
    return {
      mode: "steer",
      text: formatSteeringSubmission(steeringInputs),
    };
  }

  private trimTranscript(): void {
    if (this.messages.length <= MAX_TRANSCRIPT_MESSAGES) return;
    this.messages.splice(1, this.messages.length - MAX_TRANSCRIPT_MESSAGES);
  }

  private emitChange(): void {
    this.onChange?.();
  }
}

function formatSteeringSubmission(inputs: string[]): string {
  const body = inputs.map((input, index) => `Steering ${index + 1}:\n${input.trim()}`).join("\n\n");
  return nativeTuiStrings.steeringUpdate(body);
}

export function defaultSparkNativeResponder(input: string): string {
  if (input === "/help") {
    return nativeTuiStrings.defaultHelp;
  }

  if (input.startsWith("/")) {
    return nativeTuiStrings.capturedCommand(input);
  }

  return nativeTuiStrings.capturedIntent(input);
}

const DEFAULT_NATIVE_THEME = BUILTIN_SPARK_THEMES.find((theme) => theme.id === "dark")!;
const SPARK_APP_KEYS = new Set([
  "ctrl+k",
  "shift+ctrl+k",
  "ctrl+l",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+o",
  "ctrl+t",
]);
function createEditorTheme(theme: SparkTheme) {
  const renderTheme = createSparkHostRenderTheme(theme);
  const editorSelectListTheme: SelectListTheme = {
    selectedPrefix: (text) => renderTheme.fg("accent", text),
    selectedText: (text) => renderTheme.fg("foreground", text),
    description: (text) => renderTheme.fg("muted", text),
    scrollInfo: (text) => renderTheme.fg("muted", text),
    noMatch: (text) => renderTheme.fg("warning", text),
  };
  return {
    borderColor: (text: string) => renderTheme.fg("border", text),
    selectList: editorSelectListTheme,
  };
}

function isSparkAppKey(key: string): boolean {
  return SPARK_APP_KEYS.has(key);
}

function isOverlayRequest(value: unknown): value is {
  overlay?: boolean;
  overlayOptions?: OverlayOptions;
} {
  return typeof value === "object" && value !== null;
}

function nativeMessageToView(message: SparkNativeMessage, index: number): SparkMessageView {
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: message.viewId ?? `native-message-${index}`,
    role: message.role,
    text: message.text,
    status: message.streaming
      ? "streaming"
      : message.role === "tool" && message.toolStatus === "error"
        ? "error"
        : "done",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    customType: message.customType,
    display: message.display,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    metadata: nativeDetailsToMetadata(message.details),
  };
}

function messageViewToNativeMessage(message: SparkMessageView): SparkNativeMessage {
  return {
    role: message.role,
    text: message.text,
    viewId: message.id,
    streaming: message.status === "streaming",
    customType: message.customType,
    display: message.display,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    toolStatus: message.status === "error" ? "error" : undefined,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    details: message.metadata,
  };
}

function nativeMessageTime(message: SparkNativeMessage): number {
  const createdAt = message.createdAt ? Date.parse(message.createdAt) : NaN;
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function toolStatusIcon(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "◌";
    case "error":
      return "✗";
    case "success":
      return "✓";
  }
}

function toolStatusColor(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "warning";
    case "error":
      return "error";
    case "success":
      return "success";
  }
}

function compactToolPreview(text: string | undefined): string | undefined {
  const firstLine = text
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const normalized = firstLine.replace(/\s+/gu, " ");
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function nativeDetailsToMetadata(details: Record<string, unknown> | undefined): SparkJsonObject {
  if (!details) return {};
  try {
    return JSON.parse(JSON.stringify(details)) as SparkJsonObject;
  } catch {
    return {};
  }
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function runTimeMs(run: SparkRunView): number {
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : NaN;
  if (Number.isFinite(completedAt)) return completedAt;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return startedAt;
  return 0;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function footerMetricsFromRun(run: SparkRunView): SparkNativeFooterMetrics {
  const fromMetadata = footerMetricsFromRecord(run.metadata);
  const fromUsageTotals = footerMetricsFromRecord(
    isRecord(run.metadata.usageTotals) ? run.metadata.usageTotals : {},
  );
  const fromSummary = footerMetricsFromSummary(run.summary);
  return mergeFooterMetrics(mergeFooterMetrics(fromMetadata, fromUsageTotals), fromSummary);
}

function footerMetricsFromRecord(record: Record<string, unknown>): SparkNativeFooterMetrics {
  return {
    cacheRead:
      numberFromRecord(record, "cacheRead") ??
      numberFromRecord(record, "cacheReadTokens") ??
      numberFromRecord(record, "promptCacheReadTokens"),
    cacheWrite:
      numberFromRecord(record, "cacheWrite") ??
      numberFromRecord(record, "cacheWriteTokens") ??
      numberFromRecord(record, "promptCacheWriteTokens"),
    costUsd:
      numberFromRecord(record, "costUsd") ??
      numberFromRecord(record, "cost") ??
      numberFromRecord(record, "costTotal"),
    totalTokens:
      numberFromRecord(record, "totalTokens") ??
      numberFromRecord(record, "tokens") ??
      numberFromRecord(record, "spentTokens"),
    contextWindow: numberFromRecord(record, "contextWindow"),
    contextPercent:
      numberFromRecord(record, "contextPercent") ?? numberFromRecord(record, "contextPct"),
  };
}

function footerMetricsFromSummary(summary: string | undefined): SparkNativeFooterMetrics {
  if (!summary) return {};
  const cache = /\bcache\s+read=(\d+(?:\.\d+)?)\s+write=(\d+(?:\.\d+)?)/iu.exec(summary);
  const cost = /\bcost=\$?(\d+(?:\.\d+)?)/iu.exec(summary);
  const tokens = /\b(?:tokens|totalTokens)=(\d+(?:\.\d+)?)/iu.exec(summary);
  const ctx = /\bctx=(\d+(?:\.\d+)?)%/iu.exec(summary);
  return {
    ...(cache ? { cacheRead: Number(cache[1]), cacheWrite: Number(cache[2]) } : {}),
    ...(cost ? { costUsd: Number(cost[1]) } : {}),
    ...(tokens ? { totalTokens: Number(tokens[1]) } : {}),
    ...(ctx ? { contextPercent: Number(ctx[1]) } : {}),
  };
}

function mergeFooterMetrics(
  current: SparkNativeFooterMetrics,
  next: SparkNativeFooterMetrics,
): SparkNativeFooterMetrics {
  return {
    cacheRead: next.cacheRead ?? current.cacheRead,
    cacheWrite: next.cacheWrite ?? current.cacheWrite,
    costUsd: next.costUsd ?? current.costUsd,
    totalTokens: next.totalTokens ?? current.totalTokens,
    contextWindow: next.contextWindow ?? current.contextWindow,
    contextPercent: next.contextPercent ?? current.contextPercent,
  };
}

function formatFooterMetrics(metrics: SparkNativeFooterMetrics): string | undefined {
  const hasMetric = Object.values(metrics).some((value) => value !== undefined);
  if (!hasMetric) return undefined;
  const cacheTotal = (metrics.cacheRead ?? 0) + (metrics.cacheWrite ?? 0);
  const cache =
    metrics.cacheRead !== undefined || metrics.cacheWrite !== undefined
      ? `cache ${cacheTotal > 0 ? Math.round(((metrics.cacheRead ?? 0) / cacheTotal) * 100) : 0}%`
      : "cache --";
  const cost = metrics.costUsd !== undefined ? `$${metrics.costUsd.toFixed(2)}` : "$--";
  const contextPercent =
    metrics.contextPercent ??
    (metrics.totalTokens !== undefined && metrics.contextWindow
      ? Math.round((metrics.totalTokens / metrics.contextWindow) * 100)
      : undefined);
  const context = contextPercent !== undefined ? `ctx ${contextPercent}%` : "ctx --";
  return `${cache} · ${cost} · ${context}`;
}

function isDoneTaskStatus(status: string): boolean {
  return ["done", "completed", "succeeded", "success"].includes(status.toLowerCase());
}

function cockpitTaskDeepLink(taskRef: string): string {
  return `cockpit://tasks/${encodeURIComponent(taskRef)}`;
}

function isReviewArtifact(artifact: SparkArtifactView): boolean {
  return (
    artifact.producer === "review" ||
    stringFromRecord(artifact.metadata, "producer") === "review" ||
    Boolean(
      stringFromRecord(artifact.metadata, "reviewer") ??
      stringFromRecord(artifact.metadata, "verdict") ??
      stringFromRecord(artifact.metadata, "outcome"),
    ) ||
    /\breview(er)?\b|verdict/iu.test(`${artifact.title} ${artifact.preview ?? ""}`)
  );
}

function graftSummaryFromRecord(record: Record<string, unknown>): string | undefined {
  const patch = stringFromRecord(record, "patchRef") ?? stringFromRecord(record, "patch");
  const candidate =
    stringFromRecord(record, "candidateRef") ?? stringFromRecord(record, "candidate");
  const base = stringFromRecord(record, "base") ?? stringFromRecord(record, "baseRef");
  const status = stringFromRecord(record, "graftStatus") ?? stringFromRecord(record, "status");
  if (!patch && !candidate && !base && !status) return undefined;
  return [
    patch ? `patch=${patch}` : undefined,
    candidate ? `candidate=${candidate}` : undefined,
    base ? `base=${base}` : undefined,
    status ? `status=${status}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function workflowRunDisplayStatus(run: SparkRunView): string {
  return stringFromRecord(run.metadata, "dynamicStatus") ?? run.status;
}

function workflowRunControlHints(run: SparkRunView): string[] {
  if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
    return ["Actions: /workflow-runs to open the live dynamic workflow dashboard"];
  }
  const inspect = `/workflow-inspect ${run.id}`;
  const save = `/workflow-save ${run.id}`;
  const status = workflowRunDisplayStatus(run);
  if (status === "running" || status === "queued") {
    return [
      `Actions: ${inspect}`,
      `         /workflow-pause ${run.id}`,
      `         /workflow-stop ${run.id}`,
      `         ${save}`,
    ];
  }
  if (status === "paused" || status === "stale") {
    return [
      `Actions: ${inspect}`,
      `         /workflow-resume ${run.id}`,
      `         /workflow-stop ${run.id}`,
      `         /workflow-restart ${run.id}`,
      `         ${save}`,
      `         /workflow-ack ${run.id}`,
    ];
  }
  return [
    `Actions: ${inspect}`,
    `         /workflow-restart ${run.id}`,
    `         ${save}`,
    `         /workflow-ack ${run.id}`,
  ];
}

function compareRunsForCockpit(left: SparkRunView, right: SparkRunView): number {
  const rank = (run: SparkRunView): number => {
    if (run.kind === "role") return 0;
    if (run.kind === "workflow") return 1;
    if (run.kind === "task") return 2;
    return 3;
  };
  return rank(left) - rank(right) || left.id.localeCompare(right.id);
}

function parseSlashCommand(input: string): { name: string; args: string } | undefined {
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
        : canonicalCliTarget.startsWith("spark server")
          ? "server"
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
    cockpit: {
      description: "show Spark cockpit panels",
      argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      metadata: {
        source: "extension",
        extensionId: SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID,
        plane: "server",
        resource: "status",
        verbs: ["open"],
        canonicalCliTarget: "spark server status",
      },
      getArgumentCompletions: (prefix) =>
        ["overview", "workflows", "runs", "tasks", "artifacts", "reviews", "graft", "off"]
          .filter((value) => value.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: (args, ctx) => ctx.app.openCockpitPanelFromArgs(args) || undefined,
    },
    workflows: panelCommand("workflows", "spark server workflow list", "workflow"),
    runs: panelCommand("runs", "spark daemon run list", "run"),
    run: panelCommand("runs", "spark daemon run list", "run"),
    tasks: panelCommand("tasks", "spark server task list", "task"),
    task: panelCommand("tasks", "spark server task list", "task"),
    artifacts: panelCommand("artifacts", "spark server artifact list", "artifact"),
    artifact: panelCommand("artifacts", "spark server artifact list", "artifact"),
    evidence: panelCommand("artifacts", "spark server artifact list", "artifact"),
    reviews: panelCommand("reviews", "spark server review list", "review"),
    review: panelCommand("reviews", "spark server review list", "review"),
    graft: panelCommand("graft", "spark server status", "graft"),
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
          sendUserMessage: async (content: string) => {
            await options.sendUserMessage?.(content);
          },
          setEditorText:
            options.setEditorText ?? ((text: string) => context.app.setEditorText(text)),
        });
        await command.handler(args, commandContext);
      },
    };
  }
  return commands;
}

function nativeKernelSlashCommandEntries(): Array<{
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

function toIterable<T>(value: Iterable<T> | undefined): Iterable<T> {
  return value ?? [];
}

function normalizeNativeWidgetLines(content: unknown): string[] {
  if (content === undefined || content === null || content === false) return [];
  const rawLines = nativeWidgetContentToLines(content);
  return normalizeNativeWidgetRenderedLines(rawLines);
}

function normalizeNativeWidgetRenderedLines(lines: readonly unknown[]): string[] {
  return lines
    .flatMap((line) => String(line).split("\n"))
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, MAX_NATIVE_WIDGET_LINES);
}

function nativeWidgetContentToLines(content: unknown): string[] {
  if (Array.isArray(content)) return content.flatMap((line) => String(line).split("\n"));
  if (typeof content === "string") return content.split("\n");
  return [JSON.stringify(content) ?? Object.prototype.toString.call(content)];
}

type NativeWidgetFactory = (
  tui: { terminal: { columns: number }; requestRender(): void },
  theme: SparkHostRenderTheme,
) => Component | { render(width?: number): string[]; invalidate?(): void } | undefined;

function createNativeWidgetComponent(
  content: NativeWidgetFactory,
  tui: TUI,
  theme: SparkHostRenderTheme,
  onRequestRender: () => void,
): SparkNativeWidgetComponent | undefined {
  try {
    const widgetTheme = {
      ...theme,
      strikethrough: theme.strikethrough
        ? (text: string) => theme.strikethrough?.(text) ?? text
        : (text: string) => text,
    };
    const component = content(createNativeWidgetTui(tui, onRequestRender), widgetTheme);
    if (!component || typeof component.render !== "function") return undefined;
    return component;
  } catch (error) {
    const message = nativeTuiStrings.widgetRenderFailed(
      error instanceof Error ? error.message : String(error),
    );
    return { render: () => [message] };
  }
}

function renderNativeWidgetComponent(
  component: SparkNativeWidgetComponent,
  width: number,
): string[] {
  try {
    return normalizeNativeWidgetRenderedLines(component.render(width));
  } catch (error) {
    return [
      nativeTuiStrings.widgetRenderFailed(error instanceof Error ? error.message : String(error)),
    ];
  }
}

function createNativeWidgetTui(
  tui: TUI,
  onRequestRender?: () => void,
): { terminal: { columns: number }; requestRender(): void } {
  return {
    terminal: {
      get columns() {
        return widgetTuiColumns(tui);
      },
    },
    requestRender: () => {
      onRequestRender?.();
      tui.requestRender();
    },
  };
}

function widgetTuiColumns(tui: TUI): number {
  const terminal = (tui as { terminal?: { columns?: number; cols?: number } }).terminal;
  return terminal?.columns ?? terminal?.cols ?? 80;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_NATIVE_IMAGE_BYTES = 256 * 1024;
const MAX_NATIVE_IMAGE_DIMENSION = 4096;
const AT_FILE_TOKEN = /(^|\s)@("[^"]+"|\S+)/gu;
const RAW_IMAGE_TOKEN =
  /(^|\s)((?:file:\/\/|~\/|\.\.?\/|\/)?\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/giu;

export async function prepareSparkNativeEditorInput(
  input: string,
  basePath: string,
): Promise<string> {
  const bang = parseBangCommand(input);
  if (bang) return await runSparkNativeBangCommand(bang.command, bang.hidden, basePath);

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const match of input.matchAll(AT_FILE_TOKEN)) {
    const leading = match[1] ?? "";
    const raw = match[2];
    if (!raw) continue;
    const tokenStart = (match.index ?? 0) + leading.length;
    const tokenEnd = tokenStart + raw.length + 1;
    const pathText = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const expanded = await expandSparkNativeFileReference(pathText, basePath);
    replacements.push({ start: tokenStart, end: tokenEnd, text: expanded });
  }
  for (const match of input.matchAll(RAW_IMAGE_TOKEN)) {
    const leading = match[1] ?? "";
    const raw = match[2];
    if (!raw || raw.startsWith("@")) continue;
    const tokenStart = (match.index ?? 0) + leading.length;
    if (tokenStart > 0 && input[tokenStart - 1] === "@") continue;
    const tokenEnd = tokenStart + raw.length;
    if (replacements.some((replacement) => rangesOverlap(tokenStart, tokenEnd, replacement))) {
      continue;
    }
    const expanded = await expandSparkNativeImageReferenceIfExists(raw, basePath);
    if (expanded) replacements.push({ start: tokenStart, end: tokenEnd, text: expanded });
  }
  if (replacements.length === 0) return input;
  replacements.sort((left, right) => left.start - right.start);

  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += input.slice(cursor, replacement.start);
    output += replacement.text;
    cursor = replacement.end;
  }
  output += input.slice(cursor);
  return output;
}

function displayNativeSubmittedInput(input: string): string {
  return input.replace(
    /<image\b([^>]*)>data:[^<]+<\/image>/gu,
    (_match, attrs: string) => `<image${attrs}>[inline image data omitted]</image>`,
  );
}

function parseBangCommand(input: string): { command: string; hidden: boolean } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!")) return undefined;
  const hidden = trimmed.startsWith("!!");
  const command = trimmed.slice(hidden ? 2 : 1).trim();
  if (!command) throw new Error("Bang command requires a shell command after ! or !!");
  return { command, hidden };
}

async function runSparkNativeBangCommand(
  command: string,
  hidden: boolean,
  cwd: string,
): Promise<string> {
  const result = await runShellCapture(command, cwd);
  if (hidden) {
    return `[hidden shell command completed]\ncommand: ${command}\nexit: ${result.code}`;
  }
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return [`$ ${command}`, `exit: ${result.code}`, output || "(no output)"].join("\n");
}

async function runShellCapture(
  command: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 20_000) });
    });
  });
}

async function expandSparkNativeFileReference(pathText: string, basePath: string): Promise<string> {
  const absolutePath = resolveSparkNativeInputPath(pathText, basePath);
  const stats = await stat(absolutePath);
  if (stats.isDirectory()) return `<file name="${absolutePath}">[Directory reference]</file>`;
  const extension = extname(absolutePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return await expandSparkNativeImageReference(absolutePath);
  const content = await readFile(absolutePath, "utf8");
  return `<file name="${absolutePath}">\n${content}\n</file>`;
}

async function expandSparkNativeImageReferenceIfExists(
  pathText: string,
  basePath: string,
): Promise<string | undefined> {
  const absolutePath = resolveSparkNativeInputPath(pathText, basePath);
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const extension = extname(absolutePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return undefined;
  return await expandSparkNativeImageReference(absolutePath);
}

async function expandSparkNativeImageReference(absolutePath: string): Promise<string> {
  const stats = await stat(absolutePath);
  if (stats.size > MAX_NATIVE_IMAGE_BYTES) {
    throw new Error(
      `Image ${absolutePath} is ${stats.size} bytes; max inline image size is ${MAX_NATIVE_IMAGE_BYTES} bytes. Resize or compress it before submitting.`,
    );
  }
  const extension = extname(absolutePath).toLowerCase();
  const data = await readFile(absolutePath);
  const dimensions = detectImageDimensions(data, extension);
  if (
    dimensions &&
    (dimensions.width > MAX_NATIVE_IMAGE_DIMENSION ||
      dimensions.height > MAX_NATIVE_IMAGE_DIMENSION)
  ) {
    throw new Error(
      `Image ${absolutePath} is ${dimensions.width}x${dimensions.height}; max dimension is ${MAX_NATIVE_IMAGE_DIMENSION}px. Resize it before submitting.`,
    );
  }
  const mime = imageMimeType(extension);
  const dimensionAttrs = dimensions
    ? ` width="${dimensions.width}" height="${dimensions.height}"`
    : "";
  return `<image name="${escapeXmlAttribute(absolutePath)}" mime="${mime}" bytes="${stats.size}"${dimensionAttrs}>data:${mime};base64,${data.toString("base64")}</image>`;
}

function detectImageDimensions(
  data: Buffer,
  extension: string,
): { width: number; height: number } | undefined {
  if (extension === ".png" && data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (extension === ".gif" && data.length >= 10) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if ((extension === ".jpg" || extension === ".jpeg") && data.length >= 4) {
    return detectJpegDimensions(data);
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectJpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (!length || offset + 2 + length > data.length) return undefined;
    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function imageMimeType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function rangesOverlap(
  start: number,
  end: number,
  replacement: { start: number; end: number },
): boolean {
  return start < replacement.end && end > replacement.start;
}

function resolveSparkNativeInputPath(pathText: string, basePath: string): string {
  if (pathText.startsWith("file://")) return fileURLToPath(pathText);
  const expanded = pathText === "~" ? homedir() : pathText.replace(/^~(?=\/|$)/u, homedir());
  return isAbsolute(expanded) ? expanded : resolvePath(basePath, expanded);
}

export type SparkNativeWorkspaceSessionMode = "select" | "attached" | "mismatch";

export interface SparkNativeWorkspaceSessionState {
  mode: SparkNativeWorkspaceSessionMode;
  workspaceDir: string;
  workspaceHash: string;
  controlPlaneSessionId?: string;
  attachTarget?: string;
  mismatchDiagnostic?: string;
}

export interface SparkNativeTuiAppOptions {
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  slashCommands?: SparkNativeSlashCommandMap;
  theme?: SparkTheme;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  workspaceSession?: SparkNativeWorkspaceSessionState;
}

export class SparkNativeTuiApp implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly session: SparkNativeSession;
  private readonly onExit: () => void;
  private readonly messageRenderers: ReadonlyMap<string, SparkHostMessageRenderer>;
  private readonly keybindings?: SparkKeybindings;
  private readonly keybindingContext: SparkKeybindingContext;
  private readonly slashCommands: SparkNativeSlashCommandMap;
  private readonly interactionHandler?: SparkNativeInteractionHandler;
  private readonly inputBasePath: string;
  private readonly theme: SparkTheme;
  private readonly renderTheme: SparkHostRenderTheme;
  private workspaceSession?: SparkNativeWorkspaceSessionState;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, SparkNativeWidget>();
  private readonly cockpit = createSparkNativeCockpitState();
  private readonly completedTaskSummaryKeys = new Set<string>();
  private activeCockpitPanel: SparkNativeCockpitPanel | undefined;
  private footerMetrics: SparkNativeFooterMetrics = {};
  private focusedValue = false;
  private toolsExpanded = false;
  private thinkingExpanded = false;

  constructor(
    tui: TUI,
    session: SparkNativeSession,
    onExit: () => void,
    options: SparkNativeTuiAppOptions = {},
  ) {
    this.tui = tui;
    this.session = session;
    this.onExit = onExit;
    this.messageRenderers = options.messageRenderers ?? new Map();
    this.keybindings = options.keybindings;
    this.keybindingContext = options.keybindingContext ?? { hasUI: true };
    this.slashCommands = {
      ...createSparkNativeLocalControlSlashCommands(),
      ...(options.slashCommands ?? {}),
    };
    this.interactionHandler = options.interactionHandler;
    this.inputBasePath = options.autocompleteBasePath ?? process.cwd();
    this.theme = options.theme ?? DEFAULT_NATIVE_THEME;
    this.renderTheme = createSparkHostRenderTheme(this.theme);
    this.workspaceSession = options.workspaceSession;
    this.registerToggleKeybindings(options.keybindings);
    this.editor = new Editor(tui, createEditorTheme(this.theme), { paddingX: 1 });
    this.installAutocompleteProvider(options);
    this.editor.onSubmit = (text) => {
      void this.submitEditorText(text, { mode: "steer" });
    };
    this.session.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  setEditorText(text: string): void {
    if (this.editor.isShowingAutocomplete()) this.editor.handleInput(Key.escape);
    this.editor.setText(text);
    this.invalidate();
    this.tui.requestRender();
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  async submitInput(input: string): Promise<"started" | "queued" | "ignored" | "command"> {
    return await this.submitPreparedInput(input, { mode: "steer" });
  }

  private async submitEditorText(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    this.editor.addToHistory(input);
    this.editor.setText("");
    const result = await this.submitPreparedInput(input, options);
    this.invalidate();
    this.tui.requestRender();
    return result;
  }

  private async submitPreparedInput(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    const text = input.trim();
    if (!text) return await this.session.submit(input, options);
    if (text.startsWith("/") && !text.startsWith("//")) {
      await this.runSlashCommand(text);
      this.invalidate();
      this.tui.requestRender();
      return "command";
    }
    const bang = parseBangCommand(input);
    if (bang?.hidden) {
      const hiddenResult = await runSparkNativeBangCommand(bang.command, true, this.inputBasePath);
      this.session.addToolMessage({ toolName: "shell", text: hiddenResult, status: "success" });
      return "ignored";
    }
    try {
      const prepared = await prepareSparkNativeEditorInput(input, this.inputBasePath);
      return await this.session.submit(prepared, options);
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.inputPreparationFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
      return "ignored";
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.alt("enter"))) {
      void this.submitEditorText(this.editor.getExpandedText(), { mode: "followUp" });
      return;
    }
    if (this.handleCockpitPanelInput(data)) return;
    if (matchesKey(data, Key.escape)) {
      const restoredText = this.session.abort("escape").restoredText;
      if (restoredText) this.editor.setText(restoredText);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.alt("up"))) {
      const restoredText = this.session.restoreQueuedText();
      if (restoredText) {
        this.editor.setText(restoredText);
        this.session.addSystemMessage("Restored queued input to the editor.");
      } else {
        this.session.addSystemMessage(nativeTuiStrings.noQueuedInputToRestore);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.handleSparkKeybinding(data)) return;
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      this.onExit();
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.toggleTools();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toggleThinking();
      return;
    }
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  setWorkspaceSession(state: SparkNativeWorkspaceSessionState | undefined): void {
    this.workspaceSession = state;
    this.invalidate();
    this.tui.requestRender();
  }

  setStatus(key: string, text: string | undefined): void {
    if (!key) return;
    if (text === undefined || text.trim() === "") this.statuses.delete(key);
    else this.statuses.set(key, text);
    this.invalidate();
    this.tui.requestRender();
  }

  setWidget(
    key: string,
    content: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    if (!key) return;
    const placement = options?.placement ?? "aboveEditor";
    if (content === undefined || content === null || content === false) {
      this.widgets.delete(key);
    } else if (typeof content === "function") {
      const component = createNativeWidgetComponent(
        content as NativeWidgetFactory,
        this.tui,
        this.renderTheme,
        () => this.invalidate(),
      );
      if (!component) this.widgets.delete(key);
      else this.widgets.set(key, { key, component, placement });
    } else {
      const lines = normalizeNativeWidgetLines(content);
      if (lines.length === 0) this.widgets.delete(key);
      else this.widgets.set(key, { key, lines, placement });
    }
    this.invalidate();
    this.tui.requestRender();
  }

  cockpitSnapshot(): SparkNativeCockpitSnapshot {
    return {
      activePanel: this.activeCockpitPanel,
      sessionId: this.cockpit.sessionId,
      sessionStatus: this.cockpit.sessionStatus,
      workflows: this.cockpit.workflows.size,
      workflowRuns: [...this.cockpit.runs.values()].filter((run) => run.kind === "workflow").length,
      roleRuns: [...this.cockpit.runs.values()].filter((run) => run.kind === "role").length,
      tasks: this.cockpit.tasks.size,
      artifacts: this.cockpit.artifacts.size,
      reviews: this.reviewItems().length,
      graftItems: this.graftItems().length,
      interactions: this.cockpit.interactions.size,
    };
  }

  toggleCockpitPanel(panel: SparkNativeCockpitPanel = "overview"): boolean {
    this.activeCockpitPanel = this.activeCockpitPanel === panel ? undefined : panel;
    if (this.activeCockpitPanel === "runs" || this.activeCockpitPanel === "workflows") {
      this.ensureWorkflowRunSelection();
    }
    this.invalidate();
    this.tui.requestRender();
    return this.activeCockpitPanel !== undefined;
  }

  cycleCockpitPanel(): SparkNativeCockpitPanel {
    const current = this.activeCockpitPanel ?? "overview";
    const index = SPARK_COCKPIT_PANELS.indexOf(current);
    const next = SPARK_COCKPIT_PANELS[(index + 1) % SPARK_COCKPIT_PANELS.length] ?? "overview";
    this.activeCockpitPanel = next;
    if (next === "runs" || next === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    return next;
  }

  private handleCockpitPanelInput(data: string): boolean {
    if (this.activeCockpitPanel !== "runs" && this.activeCockpitPanel !== "workflows") {
      return false;
    }
    if (matchesKey(data, Key.escape)) {
      this.activeCockpitPanel = undefined;
      this.invalidate();
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveWorkflowRunSelection(-1);
      return true;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.moveWorkflowRunSelection(1);
      return true;
    }
    if (matchesKey(data, Key.enter) || data === "i") {
      this.runSelectedWorkflowCommand("inspect");
      return true;
    }
    if (data === "p") {
      this.runSelectedWorkflowCommand("pause");
      return true;
    }
    if (data === "u") {
      this.runSelectedWorkflowCommand("resume");
      return true;
    }
    if (data === "x") {
      this.runSelectedWorkflowCommand("stop");
      return true;
    }
    if (data === "r") {
      this.runSelectedWorkflowCommand("restart");
      return true;
    }
    if (data === "s") {
      this.runSelectedWorkflowCommand("save");
      return true;
    }
    if (data === "a") {
      this.runSelectedWorkflowCommand("ack");
      return true;
    }
    return false;
  }

  private moveWorkflowRunSelection(delta: number): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) return;
    const selectedIndex = Math.max(
      0,
      runs.findIndex((run) => run.id === this.cockpit.selectedWorkflowRunId),
    );
    const nextIndex = (selectedIndex + delta + runs.length) % runs.length;
    this.cockpit.selectedWorkflowRunId = runs[nextIndex]?.id;
    this.invalidate();
    this.tui.requestRender();
  }

  private runSelectedWorkflowCommand(
    action: "inspect" | "pause" | "resume" | "stop" | "restart" | "save" | "ack",
  ): void {
    const run = this.selectedWorkflowRun();
    if (!run) {
      this.session.addSystemMessage(nativeTuiStrings.noWorkflowRunSelected);
      return;
    }
    if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
      this.session.addSystemMessage(nativeTuiStrings.selectedWorkflowNotLive(run.id));
      return;
    }
    const commandName = `workflow-${action}`;
    if (!this.slashCommands[commandName]) {
      this.session.addSystemMessage(nativeTuiStrings.hostCommandNotRegistered(commandName));
      return;
    }
    void this.runSlashCommand(`/${commandName} ${run.id}`).finally(() => {
      this.invalidate();
      this.tui.requestRender();
    });
  }

  custom<T>(
    factory: (
      tui: SparkModelSelectorTuiLike,
      theme: SparkModelSelectorTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component,
    options?: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let handle: { hide(): void } | undefined;
      const done = (value: T) => {
        if (settled) return;
        settled = true;
        handle?.hide();
        resolve(value);
      };
      const component = factory(
        { requestRender: () => this.tui.requestRender() },
        this.renderTheme,
        this.keybindings,
        done,
      );
      const overlayOptions = isOverlayRequest(options) ? options.overlayOptions : undefined;
      if (
        (!isOverlayRequest(options) || options.overlay !== false) &&
        typeof this.tui.showOverlay === "function"
      ) {
        handle = this.tui.showOverlay(component, overlayOptions);
      } else {
        this.tui.addChild(component);
        this.tui.setFocus(component);
        handle = {
          hide: () => {
            this.tui.removeChild(component);
            this.tui.setFocus(this);
            this.tui.requestRender();
          },
        };
      }
    });
  }

  async handleInteractionRequest(
    request: SparkInteractionRequest,
  ): Promise<SparkInteractionResponse> {
    this.recordInteractionRequest(request);
    if (this.interactionHandler) {
      const response = await this.interactionHandler(request, { app: this, session: this.session });
      return parseSparkInteractionResponse(response);
    }
    this.session.addCustomMessage({
      customType: request.kind === "workflowPicker" ? "workflow-picker" : "interaction-request",
      content: `${request.kind}: ${request.title}`,
      display: true,
      details: { request },
    });
    this.invalidate();
    this.tui.requestRender();
    return createBlockedInteractionResponse(request, nativeTuiStrings.noInteractionHandler);
  }

  hydrateCockpit(input: {
    sessionId?: string;
    sessionTitle?: string;
    sessionStatus?: SparkSessionView["status"];
    tasks?: SparkTaskView[];
    artifacts?: SparkArtifactView[];
  }): void {
    if (input.sessionId) this.cockpit.sessionId = input.sessionId;
    if (input.sessionTitle) this.cockpit.sessionTitle = input.sessionTitle;
    if (input.sessionStatus) this.cockpit.sessionStatus = input.sessionStatus;
    for (const task of input.tasks ?? []) this.cockpit.tasks.set(task.ref, task);
    for (const artifact of input.artifacts ?? [])
      this.cockpit.artifacts.set(artifact.ref, artifact);
    this.invalidate();
    this.tui.requestRender();
  }

  applyViewModelEvent(event: SparkViewModelEvent): void {
    const parsed = parseSparkViewModelEvent(event);
    switch (parsed.type) {
      case "session.snapshot":
        this.recordSessionView(parsed.session);
        this.session.applySessionView(parsed.session);
        break;
      case "session.message":
        this.session.addMessageView(parsed.message);
        break;
      case "run.update":
        this.recordRunView(parsed.run);
        break;
      case "task.update": {
        this.cockpit.tasks.set(parsed.task.ref, parsed.task);
        this.session.addCustomMessage({
          customType: "task-view",
          content: `${parsed.task.ref} [${parsed.task.status}] ${parsed.task.title}`,
          display: true,
          details: { task: parsed.task },
        });
        const evidenceSummary = this.taskCompletionEvidenceSummary(parsed.task);
        if (evidenceSummary) this.session.addSystemMessage(evidenceSummary);
        break;
      }
      case "artifact.update":
        this.cockpit.artifacts.set(parsed.artifact.ref, parsed.artifact);
        break;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private recordSessionView(view: SparkSessionView): void {
    this.cockpit.sessionId = view.sessionId;
    this.cockpit.sessionTitle = view.title;
    this.cockpit.sessionStatus = view.status;
    this.cockpit.runs.clear();
    this.cockpit.tasks.clear();
    this.cockpit.artifacts.clear();
    for (const run of view.runs) this.recordRunView(run);
    if (view.runs.length === 0) this.recordActiveRunStatus();
    for (const task of view.tasks) this.cockpit.tasks.set(task.ref, task);
    for (const artifact of view.artifacts) this.cockpit.artifacts.set(artifact.ref, artifact);
  }

  private recordRunView(run: SparkRunView): void {
    this.cockpit.runs.set(run.id, run);
    this.recordCacheUsageStatus(run);
    this.recordActiveRunStatus();
    if (run.kind === "workflow") {
      const selector = stringFromRecord(run.metadata, "selector") ?? run.id;
      this.cockpit.workflows.set(selector, {
        selector,
        label: run.title ?? run.summary ?? run.id,
        description: run.summary,
        source: "run",
      });
      this.ensureWorkflowRunSelection();
    }
  }

  private recordCacheUsageStatus(run: SparkRunView): void {
    if (run.summary && /\bcache read=\d+ write=\d+/iu.test(run.summary)) {
      this.statuses.set("cache-usage", run.summary);
    }
    this.footerMetrics = mergeFooterMetrics(this.footerMetrics, footerMetricsFromRun(run));
  }

  private taskCompletionEvidenceSummary(task: SparkTaskView): string | undefined {
    if (!isDoneTaskStatus(task.status)) return undefined;
    const key = `${task.ref}:${task.status}:${task.artifactRefs.join(",")}`;
    if (this.completedTaskSummaryKeys.has(key)) return undefined;
    this.completedTaskSummaryKeys.add(key);
    const artifactCount = task.artifactRefs.length;
    const reviewStatus = this.taskReviewStatus(task);
    return [
      "✔ task done",
      `${artifactCount} artifact${artifactCount === 1 ? "" : "s"}`,
      reviewStatus ? `review ${reviewStatus}` : "review not recorded",
      cockpitTaskDeepLink(task.ref),
    ].join(" · ");
  }

  private taskReviewStatus(task: SparkTaskView): string | undefined {
    const metadataStatus =
      stringFromRecord(task.metadata, "reviewStatus") ??
      stringFromRecord(task.metadata, "reviewOutcome") ??
      stringFromRecord(task.metadata, "review") ??
      stringFromRecord(task.metadata, "verdict") ??
      stringFromRecord(task.metadata, "outcome");
    if (metadataStatus) return metadataStatus;
    for (const ref of task.artifactRefs) {
      const artifact = this.cockpit.artifacts.get(ref);
      if (!artifact || !isReviewArtifact(artifact)) continue;
      return (
        stringFromRecord(artifact.metadata, "outcome") ??
        stringFromRecord(artifact.metadata, "verdict") ??
        artifact.status ??
        "recorded"
      );
    }
    return undefined;
  }

  private recordActiveRunStatus(): void {
    const activeRuns = [...this.cockpit.runs.values()]
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort((left, right) => runTimeMs(left) - runTimeMs(right));
    const active = activeRuns.at(-1);
    if (!active) {
      this.statuses.delete("active-run");
      return;
    }
    const label = active.summary?.trim() || active.title?.trim() || active.id;
    this.statuses.set("active-run", `${active.kind} ${active.status}: ${label}`);
  }

  private recordInteractionRequest(request: SparkInteractionRequest): void {
    this.cockpit.interactions.set(request.requestId, request);
    if (request.kind === "workflowPicker") {
      for (const option of request.options) {
        this.cockpit.workflows.set(option.selector, {
          selector: option.selector,
          label: option.label,
          description: option.description,
          source: "interaction",
        });
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }

  toggleTools(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    this.invalidate();
    this.tui.requestRender();
    return this.toolsExpanded;
  }

  toggleThinking(): boolean {
    this.thinkingExpanded = !this.thinkingExpanded;
    this.invalidate();
    this.tui.requestRender();
    return this.thinkingExpanded;
  }

  areToolsExpanded(): boolean {
    return this.toolsExpanded;
  }

  isThinkingExpanded(): boolean {
    return this.thinkingExpanded;
  }

  private handleSparkKeybinding(data: string): boolean {
    const key = parseKey(data) ?? data;
    const keybindings = this.keybindings;
    if (!keybindings || !isSparkAppKey(key)) return false;
    void keybindings.executeKey(key, this.keybindingContext).then((didHandle) => {
      if (didHandle) {
        this.invalidate();
        this.tui.requestRender();
      }
    });
    return true;
  }

  private installAutocompleteProvider(options: SparkNativeTuiAppOptions): void {
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        this.autocompleteSlashCommands(),
        options.autocompleteBasePath ?? process.cwd(),
        options.autocompleteFdPath ?? null,
      ),
    );
  }

  private autocompleteSlashCommands(): SlashCommand[] {
    const registered = Object.entries(this.slashCommands)
      .sort(([leftName, left], [rightName, right]) => {
        const leftRank = isSparkNativeLocalControlCommand(left) ? 1 : 0;
        const rightRank = isSparkNativeLocalControlCommand(right) ? 1 : 0;
        return leftRank - rightRank || leftName.localeCompare(rightName);
      })
      .map(([name, command]) => ({
        name,
        description: command.description,
        argumentHint: command.argumentHint,
        getArgumentCompletions: command.getArgumentCompletions,
      }));
    return [...registered, ...this.builtInAutocompleteCommands()];
  }

  private builtInAutocompleteCommands(): SlashCommand[] {
    return nativeKernelSlashCommandEntries().map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    }));
  }

  private registerToggleKeybindings(keybindings: SparkKeybindings | undefined): void {
    if (!keybindings) return;
    keybindings.register({
      id: "app.toggleTools",
      defaultKey: "ctrl+o",
      description: nativeTuiStrings.keybindings.toggleTools,
      handler: () => void this.toggleTools(),
    });
    keybindings.register({
      id: "app.toggleThinking",
      defaultKey: "ctrl+t",
      description: nativeTuiStrings.keybindings.toggleThinking,
      handler: () => void this.toggleThinking(),
    });
    keybindings.register({
      id: "app.toggleCockpit",
      defaultKey: "ctrl+k",
      description: nativeTuiStrings.keybindings.toggleCockpit,
      handler: () => void this.toggleCockpitPanel(),
    });
    keybindings.register({
      id: "app.cycleCockpitPanel",
      defaultKey: "shift+ctrl+k",
      description: nativeTuiStrings.keybindings.cycleCockpitPanel,
      handler: () => void this.cycleCockpitPanel(),
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
    for (const widget of this.widgets.values()) widget.component?.invalidate?.();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    lines.push(
      truncateToWidth(
        this.renderTheme.bold(this.renderTheme.fg("accent", nativeTuiStrings.appTitle)),
        width,
      ),
    );
    lines.push(truncateToWidth(this.renderTheme.fg("muted", this.statusLine()), width));
    lines.push(...this.renderWorkspaceSessionState(width));
    lines.push(...this.renderWidgets("aboveEditor", width));
    lines.push(...this.renderActiveCockpitPanel(width));
    lines.push(this.separatorLine(width));

    for (const message of this.session.messages) {
      lines.push(...this.renderMessage(message, width));
    }

    lines.push(this.separatorLine(width));
    lines.push(...this.editor.render(width));
    lines.push(...this.renderWidgets("belowEditor", width));
    lines.push(truncateToWidth(this.renderTheme.fg("muted", this.footerLine()), width));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    return this.cachedLines;
  }

  private renderWorkspaceSessionState(width: number): string[] {
    const state = this.workspaceSession;
    if (!state) return [];
    const title =
      state.mode === "attached"
        ? "Spark session attached"
        : state.mode === "mismatch"
          ? "Spark session attach blocked"
          : "Select Spark session";
    const details = [
      title,
      `workspace: ${state.workspaceDir}`,
      `workspace hash: ${state.workspaceHash}`,
      ...(state.controlPlaneSessionId
        ? [`control-plane session: ${state.controlPlaneSessionId}`]
        : []),
      ...(state.attachTarget ? [`attach target: ${state.attachTarget}`] : []),
      ...(state.mode === "select" ? ["attach a daemon-managed session"] : []),
      ...(state.mismatchDiagnostic ? [`diagnostic: ${state.mismatchDiagnostic}`] : []),
    ];
    return [truncateToWidth(this.renderTheme.fg("muted", details.join(" • ")), width)];
  }

  private renderMessage(message: SparkNativeMessage, width: number): string[] {
    if (message.display === false) return [];
    if (message.role === "tool") return this.renderToolMessage(message, width);
    if (message.role === "thinking") return this.renderThinkingMessage(message, width);
    if (message.role === "custom") return this.renderCustomMessage(message, width);

    const prefix = this.messagePrefix(message);
    const body = message.text || " ";
    const suffix = message.streaming ? " ▋" : "";
    const lines =
      message.role === "assistant"
        ? this.renderPrefixedLines(
            prefix,
            this.renderMarkdownBlock(`${body}${suffix}`, width),
            width,
          )
        : this.renderPrefixedBlock(prefix, `${body}${suffix}`, width);
    return this.styleRoleLines(message.role, lines);
  }

  private renderToolMessage(message: SparkNativeMessage, width: number): string[] {
    const toolName = message.toolName ?? "tool";
    const status = message.toolStatus ?? "success";
    const header = `tool:${toolName} [${status}]`;
    const icon = toolStatusIcon(status);
    const preview = compactToolPreview(message.text);
    const styledHeader = this.renderToolHeader(header, status, icon);
    if (!this.toolsExpanded) {
      const suffix = this.renderTheme.fg("dim", " • folded (Ctrl+O expand)");
      const previewText = preview ? ` ${this.renderTheme.fg("muted", `— ${preview}`)}` : "";
      return [truncateToWidth(`${styledHeader}${previewText}${suffix}`, width)];
    }

    const id = message.toolCallId ? this.renderTheme.fg("dim", ` · ${message.toolCallId}`) : "";
    const body = this.renderToolBody(message.text || " ");
    const innerWidth = Math.max(1, width - 2);
    const lines = [
      truncateToWidth(`${this.renderTheme.fg("border", "┌─")} ${styledHeader}${id}`, width),
    ];
    for (const line of body.split("\n")) {
      for (const wrapped of wrapTextWithAnsi(line || " ", innerWidth)) {
        lines.push(truncateToWidth(`${this.renderTheme.fg("border", "│")} ${wrapped}`, width));
      }
    }
    lines.push(
      truncateToWidth(
        `${this.renderTheme.fg("border", "└─")} ${this.renderTheme.fg("dim", "Ctrl+O collapse")}`,
        width,
      ),
    );
    return lines;
  }

  private renderToolHeader(header: string, status: SparkNativeToolStatus, icon: string): string {
    const color = toolStatusColor(status);
    return `${this.renderTheme.fg(color, icon)} ${this.renderTheme.fg("tool", header)}`;
  }

  private renderThinkingMessage(message: SparkNativeMessage, width: number): string[] {
    if (!this.thinkingExpanded) {
      return this.styleRoleLines("thinking", [
        truncateToWidth("thinking • hidden (Ctrl+T to show)", width),
      ]);
    }
    return this.styleRoleLines(
      "thinking",
      this.renderPrefixedBlock("thinking> ", message.text || " ", width),
    );
  }

  private renderCustomMessage(message: SparkNativeMessage, width: number): string[] {
    const customType = message.customType ?? "custom";
    const renderer = this.messageRenderers.get(customType);
    if (renderer) {
      const component = renderer(
        this.toCustomMessage(message, customType),
        { expanded: true },
        this.renderTheme,
      );
      if (component) return component.render(width).map((line) => truncateToWidth(line, width));
    }
    return this.styleRoleLines(
      "custom",
      this.renderPrefixedBlock(`custom:${customType}> `, message.text || " ", width),
    );
  }

  private renderMarkdownBlock(body: string, width: number): string[] {
    const markdown = new Markdown(
      body,
      0,
      0,
      createSparkMarkdownTheme(this.theme),
      this.markdownDefaultTextStyle(),
      { preserveOrderedListMarkers: true },
    );
    return markdown.render(
      Math.max(1, width - this.messagePrefix({ role: "assistant", text: "" }).length),
    );
  }

  private markdownDefaultTextStyle(): DefaultTextStyle {
    return { color: (text) => this.renderTheme.fg("assistant", text) };
  }

  private renderToolBody(body: string): string {
    return body
      .split("\n")
      .map((line) => styleSparkDiffLine(this.theme, line))
      .join("\n");
  }

  private separatorLine(width: number): string {
    return this.renderTheme.fg("border", "".padEnd(Math.max(1, width), "─"));
  }

  private styleRoleLines(role: SparkNativeMessageRole, lines: string[]): string[] {
    return lines.map((line) => styleSparkRoleLine(this.theme, role, line));
  }

  private renderPrefixedLines(prefix: string, bodyLines: string[], width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of bodyLines.entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderPrefixedBlock(prefix: string, body: string, width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of body.split("\n").entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderWidgets(placement: "aboveEditor" | "belowEditor", width: number): string[] {
    return [...this.widgets.values()]
      .filter((widget) => widget.placement === placement)
      .sort((a, b) => a.key.localeCompare(b.key))
      .flatMap((widget) => {
        const lines = widget.component
          ? renderNativeWidgetComponent(widget.component, width)
          : (widget.lines ?? []);
        return lines.map((line) => truncateToWidth(line, width));
      });
  }

  private renderActiveCockpitPanel(width: number): string[] {
    if (!this.activeCockpitPanel) return [];
    return this.renderCockpitPanel(this.activeCockpitPanel, width).map((line) =>
      truncateToWidth(line, width),
    );
  }

  private renderCockpitPanel(panel: SparkNativeCockpitPanel, width?: number): string[] {
    switch (panel) {
      case "overview":
        return this.renderCockpitOverview();
      case "workflows":
        return this.renderWorkflowCockpit();
      case "runs":
        return this.renderRunCockpit();
      case "tasks":
        return this.renderTaskCockpit(width);
      case "artifacts":
        return this.renderArtifactCockpit();
      case "reviews":
        return this.renderReviewCockpit();
      case "graft":
        return this.renderGraftCockpit();
    }
  }

  private renderCockpitOverview(): string[] {
    const snapshot = this.cockpitSnapshot();
    return [
      "◆ Spark cockpit: overview",
      `├─ Workflow picker/progress: ${snapshot.workflows} option(s), ${snapshot.workflowRuns} workflow run(s)`,
      `├─ Role-run board: ${snapshot.roleRuns} role run(s), ${snapshot.interactions} interaction(s)`,
      `├─ Task/project board: ${snapshot.tasks} tracked task(s)`,
      `├─ Artifact/evidence panel: ${snapshot.artifacts} artifact(s), ${snapshot.reviews} review item(s)`,
      `└─ Graft provenance/patch status: ${snapshot.graftItems} item(s)`,
    ];
  }

  private renderWorkflowCockpit(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Spark cockpit: workflows",
      "│  Keys: ↑/↓ or j/k select · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Commands: /workflow-runs [runRef] · /workflow-inspect <runRef>",
      "│            /workflow-pause|resume|stop|restart|save|ack <runRef>",
    ];
    const interactions = [...this.cockpit.interactions.values()].filter(
      (request) => request.kind === "workflowPicker",
    );
    for (const request of interactions.slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(
        `├─ picker ${request.requestId}: ${request.title} (${request.options.length} option(s))`,
      );
    }
    for (const workflow of [...this.cockpit.workflows.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const source = workflow.source === "interaction" ? "picker" : "run";
      lines.push(
        `├─ ${source} ${workflow.selector}: ${workflow.label}${workflow.description ? ` — ${workflow.description}` : ""}`,
      );
    }
    for (const run of this.runsByKind("workflow").slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const marker = run.id === selected?.id ? "▸" : "├";
      lines.push(
        `${marker}─ workflow run ${run.id} [${workflowRunDisplayStatus(run)}] ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5)
      lines.push("└─ No workflow picker options or workflow runs have been published yet.");
    return lines;
  }

  private renderRunCockpit(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Spark cockpit: role/run board",
      "│  Keys: ↑/↓ or j/k select workflow run · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Workflow commands: /workflow-runs [runRef] · /workflow-inspect <runRef>",
      "│                     /workflow-pause|resume|stop|restart|save|ack <runRef>",
    ];
    const runs = [...this.cockpit.runs.values()].sort(compareRunsForCockpit);
    for (const run of runs.slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const progress = run.progress === undefined ? "" : ` ${(run.progress * 100).toFixed(0)}%`;
      const artifacts = run.artifactRefs.length > 0 ? ` artifacts=${run.artifactRefs.length}` : "";
      const marker = run.kind === "workflow" && run.id === selected?.id ? "▸" : "├";
      const status = run.kind === "workflow" ? workflowRunDisplayStatus(run) : run.status;
      lines.push(
        `${marker}─ ${run.kind} ${run.id} [${status}]${progress}${artifacts} ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.kind === "workflow" && run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5) lines.push("└─ No run view-model updates have been published yet.");
    return lines;
  }

  private renderTaskCockpit(width?: number): string[] {
    const lines = ["◆ Spark cockpit: task/project board"];
    if (this.cockpit.sessionTitle) {
      lines.push(...wrapTextWithAnsi(`│  Project: ${this.cockpit.sessionTitle}`, width ?? 100));
    }
    for (const task of [...this.cockpit.tasks.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const doneTodos = task.todos.filter((todo) => todo.status === "done").length;
      const todoSummary = task.todos.length > 0 ? ` todos=${doneTodos}/${task.todos.length}` : "";
      const artifacts = task.artifactRefs.length > 0 ? ` evidence=${task.artifactRefs.length}` : "";
      lines.push(`├─ ${task.ref} [${task.status}]${todoSummary}${artifacts} ${task.title}`);
    }
    if (lines.length === (this.cockpit.sessionTitle ? 2 : 1))
      lines.push("└─ No task/project view-model updates have been published yet.");
    return lines;
  }

  private renderArtifactCockpit(): string[] {
    const lines = ["◆ Spark cockpit: artifacts/evidence"];
    for (const artifact of [...this.cockpit.artifacts.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const producer = artifact.producer ? ` producer=${artifact.producer}` : "";
      const status = artifact.status ? ` status=${artifact.status}` : "";
      lines.push(
        `├─ ${artifact.ref} [${artifact.kind}/${artifact.format}]${producer}${status} ${artifact.title}`,
      );
      if (artifact.preview) lines.push(`│  ${artifact.preview}`);
    }
    if (lines.length === 1)
      lines.push("└─ No artifact/evidence view-model updates have been published yet.");
    return lines;
  }

  private renderReviewCockpit(): string[] {
    const lines = ["◆ Spark cockpit: reviewer verdicts"];
    for (const item of this.reviewItems().slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No reviewer verdict artifacts or run metadata have been published yet.");
    return lines;
  }

  private renderGraftCockpit(): string[] {
    const lines = ["◆ Spark cockpit: Graft provenance/patch status"];
    for (const item of this.graftItems().slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No Graft candidate, patch, or provenance metadata has been published yet.");
    return lines;
  }

  private selectableWorkflowRuns(): SparkRunView[] {
    return this.runsByKind("workflow").sort(compareRunsForCockpit);
  }

  private selectedWorkflowRun(): SparkRunView | undefined {
    this.ensureWorkflowRunSelection();
    const selectedId = this.cockpit.selectedWorkflowRunId;
    if (!selectedId) return undefined;
    return this.cockpit.runs.get(selectedId);
  }

  private ensureWorkflowRunSelection(): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) {
      this.cockpit.selectedWorkflowRunId = undefined;
      return;
    }
    if (
      !this.cockpit.selectedWorkflowRunId ||
      !runs.some((run) => run.id === this.cockpit.selectedWorkflowRunId)
    ) {
      this.cockpit.selectedWorkflowRunId = runs[0]?.id;
    }
  }

  private runsByKind(kind: SparkRunView["kind"]): SparkRunView[] {
    return [...this.cockpit.runs.values()].filter((run) => run.kind === kind);
  }

  private reviewItems(): string[] {
    const artifactItems = [...this.cockpit.artifacts.values()]
      .filter(isReviewArtifact)
      .map((artifact) => {
        const outcome =
          stringFromRecord(artifact.metadata, "outcome") ?? artifact.status ?? "recorded";
        return `${artifact.ref} [${outcome}] ${artifact.title}`;
      });
    const runItems = [...this.cockpit.runs.values()]
      .filter((run) =>
        Boolean(
          stringFromRecord(run.metadata, "reviewer") ??
          stringFromRecord(run.metadata, "verdict") ??
          stringFromRecord(run.metadata, "outcome"),
        ),
      )
      .map((run) => {
        const outcome =
          stringFromRecord(run.metadata, "outcome") ??
          stringFromRecord(run.metadata, "verdict") ??
          run.status;
        return `${run.kind}:${run.id} [${outcome}] ${run.title ?? run.summary ?? "review"}`;
      });
    return [...artifactItems, ...runItems];
  }

  private graftItems(): string[] {
    const records: string[] = [];
    for (const artifact of this.cockpit.artifacts.values()) {
      const summary = graftSummaryFromRecord(artifact.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${artifact.title} ${artifact.preview ?? ""}`)
      ) {
        records.push(`${artifact.ref} ${summary ?? artifact.title}`);
      }
    }
    for (const run of this.cockpit.runs.values()) {
      const summary = graftSummaryFromRecord(run.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${run.title ?? ""} ${run.summary ?? ""}`)
      ) {
        records.push(`${run.kind}:${run.id} ${summary ?? run.title ?? run.summary ?? "graft"}`);
      }
    }
    return records;
  }

  private toCustomMessage(message: SparkNativeMessage, customType: string): SparkHostCustomMessage {
    return {
      customType,
      content: message.text,
      display: message.display,
      details: message.details,
    };
  }

  private statusLine(): string {
    const statusSuffix = this.extensionStatusSuffix();
    const commandSuffix = this.commandAvailabilitySuffix();
    if (this.session.isProcessing) {
      const queued =
        this.session.queuedCount > 0 ? ` • ${this.session.queuedCount} follow-up queued` : "";
      return `native pi-tui host • busy${queued}${commandSuffix}${statusSuffix}`;
    }
    return `native pi-tui host • idle${commandSuffix}${statusSuffix}`;
  }

  private footerLine(): string {
    const metrics = formatFooterMetrics(this.footerMetrics);
    return metrics ? `${nativeTuiStrings.footer} • ${metrics}` : nativeTuiStrings.footer;
  }

  private async runSlashCommand(input: string): Promise<void> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      this.session.addSystemMessage(nativeTuiStrings.emptyCommand);
      return;
    }

    const builtIn = this.builtInSlashCommand(parsed.name, parsed.args);
    if (builtIn !== undefined) {
      if (builtIn) this.session.addSystemMessage(builtIn);
      return;
    }

    const command = this.slashCommands[parsed.name];
    if (!command) {
      this.session.addSystemMessage(nativeTuiStrings.unknownCommand(parsed.name));
      return;
    }

    try {
      const result = await command.handler(parsed.args, {
        app: this,
        session: this.session,
        exit: this.onExit,
      });
      if (result?.trim()) this.session.addSystemMessage(result.trim());
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.commandFailed(
          parsed.name,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private builtInSlashCommand(name: string, _args: string): string | undefined | false {
    switch (name) {
      case "help":
        return this.renderCommandHelp();
      case "clear":
        this.session.clearTranscript();
        return false;
      case "reload":
        return "Reload requested. Restart Spark TUI to reload extension state.";
      case "stop": {
        const result = this.session.abort(_args.trim() || "user stop");
        if (result.restoredText) this.setEditorText(result.restoredText);
        if (result.aborted) return false;
        return result.clearedQueued > 0
          ? `Restored ${result.clearedQueued} queued input(s) to the editor.`
          : nativeTuiStrings.noTurnRunning;
      }
      case "retry":
        void this.session.retryLast();
        return false;
      case "cockpit":
        return this.openCockpitPanelFromArgs(_args);
      case "workflows":
        return this.openCockpitPanel("workflows");
      case "runs":
      case "run":
        return this.openCockpitPanel("runs");
      case "tasks":
      case "task":
        return this.openCockpitPanel("tasks");
      case "artifacts":
      case "artifact":
      case "evidence":
        return this.openCockpitPanel("artifacts");
      case "reviews":
      case "review":
        return this.openCockpitPanel("reviews");
      case "graft":
        return this.openCockpitPanel("graft");
      case "exit":
      case "quit":
        this.onExit();
        return nativeTuiStrings.exiting;
      default:
        return undefined;
    }
  }

  openCockpitPanelFromArgs(args: string): string | false {
    const requested = args.trim().toLowerCase();
    if (requested === "off" || requested === "close" || requested === "hide") {
      this.activeCockpitPanel = undefined;
      this.invalidate();
      this.tui.requestRender();
      return nativeTuiStrings.cockpitPanelClosed;
    }
    if (requested && !isSparkNativeCockpitPanel(requested)) {
      return `Unknown cockpit panel '${requested}'. Choose: ${SPARK_COCKPIT_PANELS.join(", ")}, off.`;
    }
    return this.openCockpitPanel((requested as SparkNativeCockpitPanel | "") || "overview");
  }

  openCockpitPanel(panel: SparkNativeCockpitPanel): string | false {
    this.activeCockpitPanel = panel;
    if (panel === "runs" || panel === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    const snapshot = this.cockpitSnapshot();
    return nativeTuiStrings.cockpitPanelOpen(
      panel,
      [
        `workflows=${snapshot.workflows}, runs=${snapshot.workflowRuns + snapshot.roleRuns}, tasks=${snapshot.tasks}, artifacts=${snapshot.artifacts}, reviews=${snapshot.reviews}, graft=${snapshot.graftItems}`,
        "Use /cockpit off to hide it; Ctrl+K toggles overview and Shift+Ctrl+K cycles panels.",
      ].join(" "),
    );
  }

  private renderCommandHelp(): string {
    const system = nativeKernelSlashCommandEntries().map((command) => {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
      return `/${command.name}${hint} — ${command.description}`;
    });
    const extensions = Object.entries(this.slashCommands)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => {
        const target = command.metadata?.canonicalCliTarget
          ? ` → ${command.metadata.canonicalCliTarget}`
          : "";
        const source = command.metadata?.source ?? "extension";
        const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
        return `/${name}${hint} — ${command.description} [${source}]${target}`;
      });
    return [
      "Spark native TUI commands:",
      "System",
      ...system,
      "Ctrl+K — toggle Spark cockpit overview; Shift+Ctrl+K — cycle cockpit panels",
      "Everyday:",
      "- ordinary input — send a prompt to Spark",
      "- /plan — plan durable project work",
      "- /implement — execute the selected concrete work",
      "- /model — switch or inspect the active model",
      "- /resume — resume or preview a persisted session",
      "Advanced:",
      "- /goal — run reviewer-gated autonomous goal work",
      "- /loop — run an open-ended recurring loop",
      "- /workflow — run saved or scripted multi-agent workflows",
      "- /ultracode — run the advanced workflow-backed coding mode",
      "Panels & controls:",
      "/cockpit [overview|workflows|runs|tasks|artifacts|reviews|graft|off] — show Spark cockpit panels",
      "/workflows, /runs, /tasks, /artifacts, /reviews, /graft — open a focused cockpit panel",
      "Extensions",
      `${extensions.length} extension command${extensions.length === 1 ? "" : "s"} available.`,
      ...(extensions.length > 0 ? ["Other registered:"] : []),
      ...extensions,
    ].join("\n");
  }

  private commandAvailabilitySuffix(): string {
    const count = Object.values(this.slashCommands).filter(
      (command) => !isSparkNativeLocalControlCommand(command),
    ).length;
    if (count === 0) return "";
    return " • " + count.toString() + " registered command" + (count === 1 ? "" : "s");
  }

  private extensionStatusSuffix(): string {
    const statuses = [...this.statuses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => text.trim())
      .filter(Boolean);
    return statuses.length > 0 ? " • " + statuses.join(" • ") : "";
  }

  private messagePrefix(message: SparkNativeMessage): string {
    if (message.role === "user") return message.queued ? "you queued> " : "you> ";
    if (message.role === "assistant") return "spark> ";
    if (message.role === "custom") return `custom:${message.customType ?? "custom"}> `;
    if (message.role === "tool") return `tool:${message.toolName ?? "tool"}> `;
    if (message.role === "thinking") return "thinking> ";
    return "system> ";
  }
}

export function createSparkNativeUiTransport(
  app: SparkNativeTuiApp,
  session: SparkNativeSession,
): SparkHostUiTransport {
  return {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") =>
      session.addCustomMessage({
        customType: "notification",
        content: `${level ?? "info"}: ${message}`,
        display: true,
      }),
    setStatus: (key, text) => app.setStatus(key, text),
    setWidget: (key, callback, options) => app.setWidget(key, callback, options),
    setEditorText: (text) => app.setEditorText(text),
    customMessage: (message) =>
      session.addCustomMessage({
        customType: message.customType,
        content:
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        display: message.display,
        details: message.details,
      }),
    custom: (...args: unknown[]) =>
      app.custom(args[0] as Parameters<typeof app.custom>[0], args[1]),
    interaction: (request) => app.handleInteractionRequest(parseSparkInteractionRequest(request)),
    publishView: (event) => app.applyViewModelEvent(event),
  };
}

export interface RunNativeSparkTuiOptions {
  initialMessage?: string;
  responder?: SparkNativeResponder;
  slashCommands?: SparkNativeSlashCommandMap;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  theme?: SparkTheme;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  configureApp?: (app: SparkNativeTuiApp, session: SparkNativeSession) => void | Promise<void>;
}

export async function runNativeSparkTui(input?: string | RunNativeSparkTuiOptions): Promise<void> {
  const options = typeof input === "string" ? { initialMessage: input } : (input ?? {});
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const session = new SparkNativeSession(options.responder);

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = () => resolveDone?.();

  const app = new SparkNativeTuiApp(tui, session, stop, {
    slashCommands: options.slashCommands,
    autocompleteBasePath: options.autocompleteBasePath,
    autocompleteFdPath: options.autocompleteFdPath,
    interactionHandler: options.interactionHandler,
    keybindings: options.keybindings,
    keybindingContext: options.keybindingContext,
    messageRenderers: options.messageRenderers,
    theme: options.theme,
    workspaceSession: options.workspaceSession,
  });
  await options.configureApp?.(app, session);
  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle(nativeTuiStrings.appTitle);
  tui.start();
  tui.requestRender(true);

  if (options.initialMessage) {
    queueMicrotask(() => void session.submit(options.initialMessage!));
  }

  await done;
  tui.stop();
  await terminal.drainInput();
}
