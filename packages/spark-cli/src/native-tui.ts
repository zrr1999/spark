import {
  Editor,
  Key,
  matchesKey,
  parseKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type OverlayOptions,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

import { submitToSparkAgent, type SparkCliHostServices } from "./host/bootstrap.ts";
import type { SparkKeybindingContext, SparkKeybindings } from "./host/keybindings.ts";
import type {
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostRenderTheme,
} from "./host/types.ts";
import {
  createSparkModelPickerFromCustomUi,
  type SparkModelSelectorTheme,
  type SparkModelSelectorTuiLike,
} from "./tui/model-selector.ts";

export type SparkNativeMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "custom"
  | "tool"
  | "thinking";

export type SparkNativeToolStatus = "pending" | "success" | "error";

export interface SparkNativeMessage {
  role: SparkNativeMessageRole;
  text: string;
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
}

export type SparkNativeResponder = (
  input: string,
  context: SparkNativeResponderContext,
) => string | Promise<string>;

const MAX_TRANSCRIPT_MESSAGES = 80;

export class SparkNativeSession {
  readonly messages: SparkNativeMessage[] = [];
  private readonly queuedFollowUps: string[] = [];
  private readonly responder: SparkNativeResponder;
  private processing = false;

  onChange?: () => void;

  constructor(responder: SparkNativeResponder = defaultSparkNativeResponder) {
    this.responder = responder;
    this.messages.push({
      role: "system",
      text:
        "Spark native TUI is running on @earendil-works/pi-tui directly. " +
        "Messages are queued as follow-ups while Spark is busy.",
    });
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get queuedCount(): number {
    return this.queuedFollowUps.length;
  }

  async submit(input: string): Promise<"started" | "queued" | "ignored"> {
    const text = input.trim();
    if (!text) return "ignored";

    if (this.processing) {
      this.queuedFollowUps.push(text);
      this.pushMessage({ role: "user", text, queued: true });
      return "queued";
    }

    void this.process(text);
    return "started";
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
    this.pushMessage({ role: "user", text: input });

    try {
      const response = await this.responder(input, { messages: this.messages });
      this.pushMessage({ role: "assistant", text: response });
    } catch (error) {
      this.pushMessage({
        role: "assistant",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.processing = false;
      this.trimTranscript();
      this.emitChange();
    }

    const next = this.queuedFollowUps.shift();
    if (next !== undefined) {
      void this.process(next);
    }
  }

  private trimTranscript(): void {
    if (this.messages.length <= MAX_TRANSCRIPT_MESSAGES) return;
    this.messages.splice(1, this.messages.length - MAX_TRANSCRIPT_MESSAGES);
  }

  private emitChange(): void {
    this.onChange?.();
  }
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

const plain = (text: string): string => text;
const SPARK_APP_KEYS = new Set(["ctrl+l", "ctrl+p", "shift+ctrl+p", "ctrl+o", "ctrl+t"]);
const plainRenderTheme: SparkHostRenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
const editorSelectListTheme: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: plain,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

function createEditorTheme() {
  return {
    borderColor: plain,
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

export interface SparkNativeTuiAppOptions {
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
}

export class SparkNativeTuiApp implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly session: SparkNativeSession;
  private readonly onExit: () => void;
  private readonly messageRenderers: ReadonlyMap<string, SparkHostMessageRenderer>;
  private readonly keybindings?: SparkKeybindings;
  private readonly keybindingContext: SparkKeybindingContext;
  private cachedWidth?: number;
  private cachedLines?: string[];
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
    this.registerToggleKeybindings(options.keybindings);
    this.editor = new Editor(tui, createEditorTheme(), { paddingX: 1 });
    this.editor.onSubmit = (text) => {
      const expandedText = this.editor.getExpandedText?.() ?? text;
      this.editor.addToHistory(expandedText);
      this.editor.setText("");
      void this.session.submit(expandedText);
      this.invalidate();
      this.tui.requestRender();
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

  handleInput(data: string): void {
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
        plainRenderTheme,
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
    lines.push("".padEnd(Math.min(width, 80), "─"));

    for (const message of this.session.messages) {
      lines.push(...this.renderMessage(message, width));
    }

    lines.push("".padEnd(Math.min(width, 80), "─"));
    lines.push(...this.editor.render(width));
    lines.push(truncateToWidth("Enter submit • Ctrl+C/Ctrl+D exit", width));

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
    return this.renderPrefixedBlock(prefix, `${body}${suffix}`, width);
  }

  private renderToolMessage(message: SparkNativeMessage, width: number): string[] {
    const toolName = message.toolName ?? "tool";
    const status = message.toolStatus ?? "success";
    const header = `tool:${toolName} [${status}]`;
    if (!this.toolsExpanded) {
      return [truncateToWidth(`${header} • folded (Ctrl+O to expand)`, width)];
    }
    const id = message.toolCallId ? ` (${message.toolCallId})` : "";
    return this.renderPrefixedBlock(`${header}${id}> `, message.text || " ", width);
  }

  private renderThinkingMessage(message: SparkNativeMessage, width: number): string[] {
    if (!this.thinkingExpanded) {
      return [truncateToWidth("thinking • hidden (Ctrl+T to show)", width)];
    }
    return this.renderPrefixedBlock("thinking> ", message.text || " ", width);
  }

  private renderCustomMessage(message: SparkNativeMessage, width: number): string[] {
    const customType = message.customType ?? "custom";
    const renderer = this.messageRenderers.get(customType);
    if (renderer) {
      const component = renderer(
        this.toCustomMessage(message, customType),
        { expanded: true },
        plainRenderTheme,
      );
      if (component) return component.render(width).map((line) => truncateToWidth(line, width));
    }
    return this.renderPrefixedBlock(`custom:${customType}> `, message.text || " ", width);
  }

  private renderPrefixedBlock(prefix: string, body: string, width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of body.split("\n").entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
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
    if (this.session.isProcessing) {
      const queued =
        this.session.queuedCount > 0 ? ` • ${this.session.queuedCount} follow-up queued` : "";
      return `native pi-tui host • busy${queued}`;
    }
    return "native pi-tui host • idle";
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

export interface RunNativeSparkTuiOptions {
  initialMessage?: string;
  services?: SparkCliHostServices;
}

export async function runNativeSparkTui(input?: string | RunNativeSparkTuiOptions): Promise<void> {
  const options = typeof input === "string" ? { initialMessage: input } : (input ?? {});
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const session = new SparkNativeSession(
    options.services ? (message) => submitToSparkAgent(options.services!, message) : undefined,
  );

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = () => resolveDone?.();

  for (const diagnostic of options.services?.diagnostics ?? []) {
    session.addCustomMessage({
      customType: "diagnostic",
      content: `${diagnostic.type}: ${diagnostic.message}`,
      display: true,
    });
  }

  const app = new SparkNativeTuiApp(tui, session, stop, {
    keybindings: options.services?.keybindings,
    messageRenderers: options.services
      ? new Map(
          options.services.runtime
            .listMessageRenderers()
            .map(({ customType, renderer }) => [customType, renderer]),
        )
      : undefined,
  });
  if (options.services) {
    const ui = {
      notify: (message: string, level?: "info" | "warning" | "error" | "success") =>
        session.addCustomMessage({
          customType: "notification",
          content: `${level ?? "info"}: ${message}`,
          display: true,
        }),
      custom: (...args: unknown[]) =>
        app.custom(args[0] as Parameters<typeof app.custom>[0], args[1]),
    };
    options.services.runtime.setUiTransport(ui);
    options.services.modelSelector.setPicker(createSparkModelPickerFromCustomUi(app));
  }
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
