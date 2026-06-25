import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

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
import type { ExtensionCommandContext } from "@zendev-lab/pi-extension-api";

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
      "description" | "argumentHint" | "getArgumentCompletions" | "handler"
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

const MAX_TRANSCRIPT_MESSAGES = 80;
const MAX_NATIVE_WIDGET_LINES = 12;

interface SparkNativeWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
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

function isSparkNativeCockpitPanel(value: string): value is SparkNativeCockpitPanel {
  return (SPARK_COCKPIT_PANELS as readonly string[]).includes(value);
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

  onChange?: () => void;

  constructor(responder: SparkNativeResponder = defaultSparkNativeResponder) {
    this.responder = responder;
    this.messages.push({
      role: "system",
      text:
        "Spark native TUI is running through the Spark pi-tui adapter boundary. " +
        "Enter queues steering updates while Spark is busy; Alt+Enter queues follow-up turns.",
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
    const index = native.viewId
      ? this.messages.findIndex((existing) => existing.viewId === native.viewId)
      : -1;
    if (index >= 0) {
      this.messages[index] = native;
      this.emitChange();
      return;
    }
    this.pushMessage(native);
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
    this.messages.splice(0, this.messages.length, ...view.messages.map(messageViewToNativeMessage));
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
      text:
        `Stopped current Spark turn (${reason}).` +
        (clearedQueued > 0 ? ` Restored ${clearedQueued} queued input(s) to the editor.` : ""),
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
    this.messages.push(message);
    this.trimTranscript();
    this.emitChange();
  }

  private async process(input: string): Promise<void> {
    this.processing = true;
    const turnId = ++this.activeTurnId;
    const abortController = new AbortController();
    this.currentAbort = abortController;
    this.pushMessage({ role: "user", text: displayNativeSubmittedInput(input) });

    try {
      const response = await this.responder(input, {
        messages: this.messages,
        signal: abortController.signal,
      });
      if (this.activeTurnId !== turnId) return;
      this.pushMessage({ role: "assistant", text: response });
    } catch (error) {
      if (this.activeTurnId !== turnId) return;
      this.pushMessage({
        role: "system",
        text: `Spark turn failed: ${error instanceof Error ? error.message : String(error)}. Use /retry to resubmit or /status to inspect the daemon.`,
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
  return `Steering update for the previous Spark turn. Use this to adjust or correct the in-progress response before continuing.\n\n${body}`;
}

export function defaultSparkNativeResponder(input: string): string {
  if (input === "/help") {
    return [
      "Spark native TUI commands:",
      "- /help: show this help",
      "- /clear: restart the visible transcript by reopening the TUI",
      "- ordinary input is accepted as Spark intent and queued safely while busy",
    ].join("\n");
  }

  if (input.startsWith("/")) {
    return `Command '${input}' was captured by the Spark native TUI. Command dispatch will be wired to Spark-owned runtime services here, without the Pi agent SDK runtime.`;
  }

  return `Captured Spark intent: ${input}\n\nNative Spark agent/runtime wiring will live here on top of pi-tui and Spark packages, not Pi's SDK TUI wrapper.`;
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
    details: message.metadata,
  };
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

function toIterable<T>(value: Iterable<T> | undefined): Iterable<T> {
  return value ?? [];
}

function normalizeNativeWidgetLines(
  key: string,
  content: unknown,
  tui: TUI,
  theme: SparkHostRenderTheme,
): string[] {
  if (content === undefined || content === null || content === false) return [];
  const rawLines = nativeWidgetContentToLines(key, content, tui, theme);
  return rawLines
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, MAX_NATIVE_WIDGET_LINES);
}

function nativeWidgetContentToLines(
  _key: string,
  content: unknown,
  tui: TUI,
  theme: SparkHostRenderTheme,
): string[] {
  if (Array.isArray(content)) return content.flatMap((line) => String(line).split("\n"));
  if (typeof content === "string") return content.split("\n");
  if (typeof content === "function")
    return renderNativeWidgetFactory(content as NativeWidgetFactory, tui, theme);
  return [JSON.stringify(content) ?? Object.prototype.toString.call(content)];
}

type NativeWidgetFactory = (
  tui: { terminal: { columns: number }; requestRender(): void },
  theme: SparkHostRenderTheme,
) => Component | { render(width?: number): string[]; invalidate?(): void } | undefined;

function renderNativeWidgetFactory(
  content: NativeWidgetFactory,
  tui: TUI,
  theme: SparkHostRenderTheme,
): string[] {
  try {
    const component = content(createNativeWidgetTui(tui), theme);
    if (!component || typeof component.render !== "function") return [];
    const width = Math.max(1, widgetTuiColumns(tui));
    return component.render(width).flatMap((line) => String(line).split("\n"));
  } catch (error) {
    return [`widget render failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function createNativeWidgetTui(tui: TUI): { terminal: { columns: number }; requestRender(): void } {
  return {
    terminal: {
      get columns() {
        return widgetTuiColumns(tui);
      },
    },
    requestRender: () => tui.requestRender(),
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

export interface SparkNativeTuiAppOptions {
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  slashCommands?: SparkNativeSlashCommandMap;
  theme?: SparkTheme;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
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
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, SparkNativeWidget>();
  private readonly cockpit = createSparkNativeCockpitState();
  private activeCockpitPanel: SparkNativeCockpitPanel | undefined;
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
    this.slashCommands = options.slashCommands ?? {};
    this.interactionHandler = options.interactionHandler;
    this.inputBasePath = options.autocompleteBasePath ?? process.cwd();
    this.theme = options.theme ?? DEFAULT_NATIVE_THEME;
    this.renderTheme = createSparkHostRenderTheme(this.theme);
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
        `Input preparation failed: ${error instanceof Error ? error.message : String(error)}`,
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
        this.session.addSystemMessage("No queued input to restore.");
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
    const lines = normalizeNativeWidgetLines(key, content, this.tui, this.renderTheme);
    if (lines.length === 0) this.widgets.delete(key);
    else {
      this.widgets.set(key, {
        key,
        lines,
        placement: options?.placement ?? "aboveEditor",
      });
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
      this.session.addSystemMessage("No workflow run is selected in the Spark cockpit.");
      return;
    }
    if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
      this.session.addSystemMessage(
        `Selected workflow ${run.id} is not a live dynamic workflow runRef. Use /workflow-runs to list dynamic runs.`,
      );
      return;
    }
    const commandName = `workflow-${action}`;
    if (!this.slashCommands[commandName]) {
      this.session.addSystemMessage(`/${commandName} is not registered in this Spark host.`);
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
    return createBlockedInteractionResponse(
      request,
      "Spark native TUI received an interaction request but no handler is installed.",
    );
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
        this.session.addCustomMessage({
          customType: "run-view",
          content: `${parsed.run.kind}:${parsed.run.id} [${parsed.run.status}]${parsed.run.summary ? ` ${parsed.run.summary}` : ""}`,
          display: true,
          details: { run: parsed.run },
        });
        break;
      case "task.update":
        this.cockpit.tasks.set(parsed.task.ref, parsed.task);
        this.session.addCustomMessage({
          customType: "task-view",
          content: `${parsed.task.ref} [${parsed.task.status}] ${parsed.task.title}`,
          display: true,
          details: { task: parsed.task },
        });
        break;
      case "artifact.update":
        this.cockpit.artifacts.set(parsed.artifact.ref, parsed.artifact);
        this.session.addCustomMessage({
          customType: "artifact-view",
          content: `${parsed.artifact.ref} ${parsed.artifact.title}`,
          display: true,
          details: { artifact: parsed.artifact },
        });
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
    for (const task of view.tasks) this.cockpit.tasks.set(task.ref, task);
    for (const artifact of view.artifacts) this.cockpit.artifacts.set(artifact.ref, artifact);
  }

  private recordRunView(run: SparkRunView): void {
    this.cockpit.runs.set(run.id, run);
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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => ({
        name,
        description: command.description,
        argumentHint: command.argumentHint,
        getArgumentCompletions: command.getArgumentCompletions,
      }));
    return [...registered, ...this.builtInAutocompleteCommands()];
  }

  private builtInAutocompleteCommands(): SlashCommand[] {
    return [
      { name: "help", description: "show native TUI commands" },
      { name: "clear", description: "clear the visible transcript" },
      {
        name: "stop",
        description: "stop the current Spark turn and clear queued follow-ups",
        argumentHint: "[reason]",
      },
      { name: "retry", description: "resubmit the previous user prompt" },
      {
        name: "cockpit",
        description: "show Spark cockpit panels",
        argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
        getArgumentCompletions: (prefix) =>
          ["overview", "workflows", "runs", "tasks", "artifacts", "reviews", "graft", "off"]
            .filter((value) => value.startsWith(prefix.toLowerCase()))
            .map((value) => ({ value, label: value })),
      },
      { name: "workflows", description: "open the workflow cockpit panel" },
      { name: "runs", description: "open the run cockpit panel" },
      { name: "tasks", description: "open the task cockpit panel" },
      { name: "artifacts", description: "open the artifact/evidence cockpit panel" },
      { name: "evidence", description: "open the artifact/evidence cockpit panel" },
      { name: "reviews", description: "open the reviewer verdict cockpit panel" },
      { name: "graft", description: "open the Graft provenance cockpit panel" },
      { name: "exit", description: "exit the native TUI" },
      { name: "quit", description: "exit the native TUI" },
    ];
  }

  private registerToggleKeybindings(keybindings: SparkKeybindings | undefined): void {
    if (!keybindings) return;
    keybindings.register({
      id: "app.toggleTools",
      defaultKey: "ctrl+o",
      description: "Toggle tool output expansion",
      handler: () => void this.toggleTools(),
    });
    keybindings.register({
      id: "app.toggleThinking",
      defaultKey: "ctrl+t",
      description: "Toggle thinking block expansion",
      handler: () => void this.toggleThinking(),
    });
    keybindings.register({
      id: "app.toggleCockpit",
      defaultKey: "ctrl+k",
      description: "Toggle the Spark workflow/task/artifact cockpit panel",
      handler: () => void this.toggleCockpitPanel(),
    });
    keybindings.register({
      id: "app.cycleCockpitPanel",
      defaultKey: "shift+ctrl+k",
      description: "Cycle Spark cockpit workflow/run/task/artifact panels",
      handler: () => void this.cycleCockpitPanel(),
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    lines.push(truncateToWidth("Spark", width));
    lines.push(truncateToWidth(this.statusLine(), width));
    lines.push(...this.renderWidgets("aboveEditor", width));
    lines.push(...this.renderActiveCockpitPanel(width));
    lines.push("".padEnd(Math.min(width, 80), "─"));

    for (const message of this.session.messages) {
      lines.push(...this.renderMessage(message, width));
    }

    lines.push("".padEnd(Math.min(width, 80), "─"));
    lines.push(...this.editor.render(width));
    lines.push(...this.renderWidgets("belowEditor", width));
    lines.push(truncateToWidth("Enter submit • /help commands • Ctrl+C/Ctrl+D exit", width));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width));
    return this.cachedLines;
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
    if (!this.toolsExpanded) {
      return this.styleRoleLines("tool", [
        truncateToWidth(`${header} • folded (Ctrl+O to expand)`, width),
      ]);
    }
    const id = message.toolCallId ? ` (${message.toolCallId})` : "";
    const body = this.renderToolBody(message.text || " ");
    return this.styleRoleLines("tool", this.renderPrefixedBlock(`${header}${id}> `, body, width));
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
      .flatMap((widget) => widget.lines.map((line) => truncateToWidth(line, width)));
  }

  private renderActiveCockpitPanel(width: number): string[] {
    if (!this.activeCockpitPanel) return [];
    return this.renderCockpitPanel(this.activeCockpitPanel).map((line) =>
      truncateToWidth(line, width),
    );
  }

  private renderCockpitPanel(panel: SparkNativeCockpitPanel): string[] {
    switch (panel) {
      case "overview":
        return this.renderCockpitOverview();
      case "workflows":
        return this.renderWorkflowCockpit();
      case "runs":
        return this.renderRunCockpit();
      case "tasks":
        return this.renderTaskCockpit();
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

  private renderTaskCockpit(): string[] {
    const lines = ["◆ Spark cockpit: task/project board"];
    for (const task of [...this.cockpit.tasks.values()].slice(0, MAX_COCKPIT_PANEL_ROWS)) {
      const doneTodos = task.todos.filter((todo) => todo.status === "done").length;
      const todoSummary = task.todos.length > 0 ? ` todos=${doneTodos}/${task.todos.length}` : "";
      const artifacts = task.artifactRefs.length > 0 ? ` evidence=${task.artifactRefs.length}` : "";
      lines.push(`├─ ${task.ref} [${task.status}]${todoSummary}${artifacts} ${task.title}`);
    }
    if (lines.length === 1)
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

  private async runSlashCommand(input: string): Promise<void> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      this.session.addSystemMessage("Empty command. Type /help for available commands.");
      return;
    }

    const builtIn = this.builtInSlashCommand(parsed.name, parsed.args);
    if (builtIn !== undefined) {
      if (builtIn) this.session.addSystemMessage(builtIn);
      return;
    }

    const command = this.slashCommands[parsed.name];
    if (!command) {
      this.session.addSystemMessage(
        `Unknown command: /${parsed.name}. Type /help for available commands.`,
      );
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
        `Command /${parsed.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private builtInSlashCommand(name: string, args: string): string | undefined | false {
    switch (name) {
      case "help":
        return this.renderCommandHelp();
      case "clear":
        this.session.clearTranscript();
        return false;
      case "stop": {
        const result = this.session.abort(args.trim() || "user stop");
        if (result.restoredText) this.editor.setText(result.restoredText);
        if (result.aborted) return false;
        return result.clearedQueued > 0
          ? `Restored ${result.clearedQueued} queued input(s) to the editor.`
          : "No Spark turn is currently running.";
      }
      case "retry":
        void this.session.retryLast();
        return false;
      case "cockpit":
        return this.openCockpitPanelFromArgs(args);
      case "workflows":
        return this.openCockpitPanel("workflows");
      case "runs":
        return this.openCockpitPanel("runs");
      case "tasks":
        return this.openCockpitPanel("tasks");
      case "artifacts":
      case "evidence":
        return this.openCockpitPanel("artifacts");
      case "reviews":
        return this.openCockpitPanel("reviews");
      case "graft":
        return this.openCockpitPanel("graft");
      case "exit":
      case "quit":
        this.onExit();
        return "Exiting Spark native TUI.";
      default:
        return undefined;
    }
  }

  private openCockpitPanelFromArgs(args: string): string | false {
    const requested = args.trim().toLowerCase();
    if (requested === "off" || requested === "close" || requested === "hide") {
      this.activeCockpitPanel = undefined;
      this.invalidate();
      this.tui.requestRender();
      return "Spark cockpit panel closed.";
    }
    if (requested && !isSparkNativeCockpitPanel(requested)) {
      return `Unknown cockpit panel '${requested}'. Choose: ${SPARK_COCKPIT_PANELS.join(", ")}, off.`;
    }
    return this.openCockpitPanel((requested as SparkNativeCockpitPanel | "") || "overview");
  }

  private openCockpitPanel(panel: SparkNativeCockpitPanel): string | false {
    this.activeCockpitPanel = panel;
    if (panel === "runs" || panel === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    const snapshot = this.cockpitSnapshot();
    return [
      `Spark cockpit ${panel} panel open.`,
      `workflows=${snapshot.workflows}, runs=${snapshot.workflowRuns + snapshot.roleRuns}, tasks=${snapshot.tasks}, artifacts=${snapshot.artifacts}, reviews=${snapshot.reviews}, graft=${snapshot.graftItems}`,
      "Use /cockpit off to hide it; Ctrl+K toggles overview and Shift+Ctrl+K cycles panels.",
    ].join(" ");
  }

  private renderCommandHelp(): string {
    const builtIns = [
      "/help — show native TUI commands",
      "/clear — clear the visible transcript",
      "/stop [reason] — stop the current Spark turn and restore queued inputs to the editor",
      "/retry — resubmit the previous user prompt",
      "/cockpit [overview|workflows|runs|tasks|artifacts|reviews|graft|off] — show Spark cockpit panels",
      "/workflows, /runs, /tasks, /artifacts, /reviews, /graft — open a focused cockpit panel",
      "Ctrl+K — toggle Spark cockpit overview; Shift+Ctrl+K — cycle cockpit panels",
      "/exit or /quit — exit the native TUI",
    ];
    const extra = Object.entries(this.slashCommands)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => `/${name} — ${command.description}`);
    const registeredSummary = `${extra.length} registered host/daemon command${extra.length === 1 ? "" : "s"} available.`;
    return ["Spark native TUI commands:", registeredSummary, ...builtIns, ...extra].join("\n");
  }

  private commandAvailabilitySuffix(): string {
    const count = Object.keys(this.slashCommands).length;
    if (count === 0) return "";
    return ` • ${count} registered command${count === 1 ? "" : "s"}`;
  }

  private extensionStatusSuffix(): string {
    const statuses = [...this.statuses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => text.trim())
      .filter(Boolean);
    return statuses.length > 0 ? ` • ${statuses.join(" • ")}` : "";
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
  });
  await options.configureApp?.(app, session);
  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle("Spark");
  tui.start();
  tui.requestRender(true);

  if (options.initialMessage) {
    queueMicrotask(() => void session.submit(options.initialMessage!));
  }

  await done;
  tui.stop();
  await terminal.drainInput();
}
