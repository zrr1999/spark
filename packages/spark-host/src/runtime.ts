/**
 * SparkHostRuntime — the native spark-tui implementation of the
 * `spark-core` SparkHostAPI surface.
 *
 * This file owns the *contract surface* exposed to extensions plus the minimum
 * internal plumbing needed to make the existing 5 retained extensions
 * (`spark`, `spark-cue`, `spark-graft`, `spark-roles`, `spark-ask`) load and run without
 * crashing. Wiring it into a real agent turn loop, model selector, session
 * store, and TUI rendering is split into follow-up tasks
 * (`agent-turn-loop`, `model-selector-ui`, `session-format-and-store`,
 * `tool-and-thinking-rendering`); this skeleton intentionally keeps those
 * surfaces minimal:
 *
 *   - `registerTool` / `getAllTools` / `getActiveTools` / `setActiveTools` keep
 *     an in-memory tool registry. Active state defaults to `true` for newly
 *     registered tools; registered and active queries remain distinct.
 *   - `registerCommand` keeps an in-memory command registry. The agent turn
 *     loop will read it later; here we only persist the registration.
 *   - `on(event, handler)` keeps a per-event listener list. `emit(event)` is
 *     a host-only entry point that the agent loop will drive once it lands.
 *   - `sendMessage` / `sendUserMessage` push envelopes into an in-memory
 *     outbox. Consumers (the future turn loop) drain via `drainOutbox()`.
 *   - `setUiTransport()` plugs in the TUI bridge. Until it is plugged in,
 *     every UI method is a no-op so extensions that call `ctx.ui.notify()`
 *     defensively keep working.
 *
 * The host runtime is intentionally process-private state; no file I/O lives
 * here. Tests construct one runtime per test, register a few tools, drive
 * `emit("session_start", ...)`, and assert observable state.
 */

import type {
  CommandConfig,
  SparkHostAPI,
  SparkHostContext,
  SparkHostRuntimeMessage,
  ExtensionUi,
  LeafCapabilityRunner,
  ExtensionRoleRunner,
  ToolConfig,
  ToolInfo,
} from "@zendev-lab/spark-core";
import { resolveToolPolicy } from "@zendev-lab/spark-core";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  parseSparkInteractionRequest,
  parseSparkInteractionResponse,
  type SparkDaemonEvent,
  type SparkHostBuiltinEventName,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

import {
  SparkKeybindings,
  type SparkKeybindingContext,
  type SparkKeybindingsOptions,
} from "./keybindings.js";

import type {
  EventListener,
  EventListenerMap,
  EventName,
  BuiltinEventPayloadMap,
  OutboxEnvelope,
  RegisteredCommand,
  RegisteredCommandMap,
  RegisteredEventListener,
  RegisteredTool,
  RegisteredToolMap,
  SparkHostMessageRenderer,
  SparkHostModelRegistryLike,
  SparkHostSessionManagerStub,
  SparkDaemonEventListener,
  SparkHostUiTransport,
  ToolRegistrationListener,
} from "./types.js";

export interface SparkHostRuntimeOptions {
  cwd: string;
  sparkStateRoot?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  channelBinding?: {
    adapter: "feishu" | "infoflow" | "qqbot";
    externalKey: string;
    workspaceId?: string;
    recipient?: string;
    /** Runtime/config adapter id. Kept for legacy routing diagnostics. */
    adapterId?: string;
    /** Stable provider-account identity used for multi-account routing. */
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  sessionQuestionChain?: readonly string[];
  /** When present, this host instance must never activate tools outside this allowlist. */
  allowedTools?: readonly string[];
  hasUI?: boolean;
  ui?: SparkHostUiTransport;
  sessionManager?: SparkHostSessionManagerStub;
  modelRegistry?: SparkHostModelRegistryLike;
  keybindings?: SparkKeybindings | SparkKeybindingsOptions;
  /** Optional single-shot spark-ai leaf runner exposed to tools via ctx.runLeaf. */
  leafRunner?: LeafCapabilityRunner;
  /** Optional daemon-native role runner exposed to tools via ctx.runRole. */
  roleRunner?: ExtensionRoleRunner;
}

const NOT_IMPLEMENTED = (name: string): Error =>
  new Error(
    `SparkHostRuntime.${name} is not implemented yet; this surface lives in a follow-up task. ` +
      "If you hit this in extension code, file a follow-up against the active CLI rework project.",
  );

export class SparkHostRuntime implements SparkHostAPI {
  readonly cwd: string;
  readonly sparkStateRoot: string | undefined;
  readonly sessionSurface: "local" | "channel" | undefined;
  readonly sessionSource: "tui" | "web" | "channel" | "daemon" | "session" | undefined;
  readonly channelBinding:
    | {
        adapter: "feishu" | "infoflow" | "qqbot";
        externalKey: string;
        workspaceId?: string;
        recipient?: string;
        adapterId?: string;
        adapterAccountIdentity?: string;
      }
    | undefined;
  readonly invocationId: string | undefined;
  readonly sessionQuestionChain: readonly string[] | undefined;
  readonly hasUI: boolean;
  private readonly tools: RegisteredToolMap = new Map();
  private readonly allowedTools: ReadonlySet<string> | undefined;
  private readonly commands: RegisteredCommandMap = new Map();
  private readonly listeners: EventListenerMap = new Map();
  private readonly outbox: OutboxEnvelope[] = [];
  private triggerTurnHandler: (() => void | Promise<void>) | undefined;
  private readonly messageRenderers = new Map<string, SparkHostMessageRenderer>();
  private readonly toolRegistrationListeners = new Set<ToolRegistrationListener>();
  private readonly daemonEventListeners = new Set<SparkDaemonEventListener>();
  private uiTransport: SparkHostUiTransport;
  private sessionManager: SparkHostSessionManagerStub;
  private modelRegistry: SparkHostModelRegistryLike | undefined;
  private leafRunner: LeafCapabilityRunner | undefined;
  private roleRunner: ExtensionRoleRunner | undefined;
  private sessionId: string | undefined;
  private idle = true;
  private readonly keybindings: SparkKeybindings;

  constructor(options: SparkHostRuntimeOptions) {
    this.cwd = options.cwd;
    this.sparkStateRoot = options.sparkStateRoot;
    this.sessionSurface = options.sessionSurface;
    this.sessionSource = options.sessionSource;
    this.channelBinding = options.channelBinding;
    this.invocationId = options.invocationId?.trim() || undefined;
    this.sessionQuestionChain = options.sessionQuestionChain
      ?.map((entry) => entry.trim())
      .filter(Boolean);
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
    this.hasUI = options.hasUI ?? false;
    this.uiTransport = options.ui ?? {};
    this.sessionManager = options.sessionManager ?? {};
    this.modelRegistry = options.modelRegistry;
    this.leafRunner = options.leafRunner;
    this.roleRunner = options.roleRunner;
    this.keybindings =
      options.keybindings instanceof SparkKeybindings
        ? options.keybindings
        : new SparkKeybindings(options.keybindings);
  }

  // ── SparkHostAPI surface ────────────────────────────────────────────────

  registerTool = (config: ToolConfig): void => {
    if (!config.name) throw new Error("SparkHostRuntime.registerTool requires a tool name");
    const existing = this.tools.get(config.name);
    const entry: RegisteredTool = {
      config,
      policy: resolveToolPolicy(config),
      active: this.isToolAllowed(config.name) && (existing?.active ?? true),
    };
    this.tools.set(config.name, entry);
    for (const listener of Array.from(this.toolRegistrationListeners)) {
      try {
        listener({ name: config.name });
      } catch {
        // Tool-registration listeners are best-effort host instrumentation.
      }
    }
  };

  registerCommand = (name: string, config: CommandConfig): void => {
    if (!name) throw new Error("SparkHostRuntime.registerCommand requires a command name");
    if (this.commands.has(name)) {
      // Pi extends this contract by appending numeric suffixes when multiple
      // extensions register the same command. We follow the same convention.
      let counter = 1;
      let suffixed = `${name}:${counter}`;
      while (this.commands.has(suffixed)) {
        counter += 1;
        suffixed = `${name}:${counter}`;
      }
      this.commands.set(suffixed, this.toRegisteredCommand(config));
      return;
    }
    this.commands.set(name, this.toRegisteredCommand(config));
  };

  on = <E extends string>(
    event: E,
    handler: E extends SparkHostBuiltinEventName
      ? (event: BuiltinEventPayloadMap[E], ctx: SparkHostContext) => unknown
      : EventListener,
  ): void => {
    const key = event as EventName;
    const list = this.listeners.get(key) ?? [];
    list.push(handler as RegisteredEventListener);
    this.listeners.set(key, list);
  };

  sendMessage = (
    message: SparkHostRuntimeMessage,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void => {
    const envelope: OutboxEnvelope = {
      kind: "custom",
      sessionId: this.sessionId,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      authority: message.authority,
      trust: message.trust,
      options: { deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn },
      enqueuedAt: Date.now(),
    };
    this.outbox.push(envelope);
    this.uiTransport.customMessage?.({
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      authority: message.authority,
      trust: message.trust,
    });
    if (options?.triggerTurn) queueMicrotask(() => void this.triggerTurnHandler?.());
  };

  sendUserMessage = (
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void => {
    this.outbox.push({
      kind: "user",
      sessionId: this.sessionId,
      content,
      options: {
        deliverAs: options?.deliverAs,
        streamingBehavior: options?.streamingBehavior,
      },
      enqueuedAt: Date.now(),
    });
  };

  getActiveTools = (): string[] => {
    const names: string[] = [];
    for (const [name, tool] of Array.from(this.tools)) {
      if (tool.active) names.push(name);
    }
    return names;
  };

  getAllTools = (): ToolInfo[] => {
    const infos: ToolInfo[] = [];
    for (const [name, tool] of Array.from(this.tools)) {
      infos.push({ name, policy: tool.policy });
    }
    return infos;
  };

  setActiveTools = (names: string[]): void => {
    const requested = new Set(names);
    for (const [name, tool] of Array.from(this.tools)) {
      tool.active = this.isToolAllowed(name) && requested.has(name);
    }
  };

  // ── Host-only surface ───────────────────────────────────────────────────

  /**
   * Plug a real UI transport (typically the spark-cli pi-tui shell) into the
   * runtime after construction. Until this is called, all UI calls are
   * no-ops; extensions using optional chaining (`ctx.ui?.notify?.(...)`)
   * remain safe.
   */
  setUiTransport(ui: SparkHostUiTransport): void {
    this.uiTransport = ui;
  }

  setSessionManager(sessionManager: SparkHostSessionManagerStub): void {
    this.sessionManager = sessionManager;
  }

  setModelRegistry(modelRegistry: SparkHostModelRegistryLike | undefined): void {
    this.modelRegistry = modelRegistry;
  }

  /** Install the single-shot leaf runner exposed to tools via ctx.runLeaf. */
  setLeafRunner(leafRunner: LeafCapabilityRunner | undefined): void {
    this.leafRunner = leafRunner;
  }

  /** Install the daemon-native role runner exposed to tools via ctx.runRole. */
  setRoleRunner(roleRunner: ExtensionRoleRunner | undefined): void {
    this.roleRunner = roleRunner;
  }

  private isToolAllowed(name: string): boolean {
    return this.allowedTools?.has(name) ?? true;
  }

  /** Snapshot of currently registered tools (active or not). */
  listTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  listCommands(): Array<{ name: string; command: RegisteredCommand }> {
    return Array.from(this.commands.entries()).map(([name, command]) => ({ name, command }));
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * Emit an event into the registered listener list. Returns the array of
   * listener results in registration order, awaiting any thenables. The agent
   * turn loop will drive this for `session_start`, `turn_start`, etc.
   */
  async emit<E extends string>(
    event: E,
    payload?: E extends SparkHostBuiltinEventName ? BuiltinEventPayloadMap[E] : unknown,
  ): Promise<unknown[]> {
    const listeners = this.listeners.get(event as EventName);
    if (!listeners?.length) return [];
    const ctx = this.makeContext();
    const results: unknown[] = [];
    for (const listener of listeners) {
      try {
        const value = listener(payload, ctx);
        results.push(value instanceof Promise ? await value : value);
      } catch (error) {
        results.push({ error });
      }
    }
    return results;
  }

  /**
   * Drain queued outbox envelopes. The future turn loop will consume these
   * to inject custom or user messages into the next assistant turn.
   */
  drainOutbox(): OutboxEnvelope[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  /** Snapshot the outbox without consuming it (handy for tests). */
  peekOutbox(): readonly OutboxEnvelope[] {
    return this.outbox;
  }

  async requestInteraction(request: SparkInteractionRequest): Promise<SparkInteractionResponse> {
    const parsedRequest = parseSparkInteractionRequest(request);
    this.publishDaemonEvent({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.interaction.request",
      source: this.hasUI ? "tui" : "runtime",
      emittedAt: new Date().toISOString(),
      request: parsedRequest,
      metadata: {},
    });

    const response = this.uiTransport.interaction
      ? parseSparkInteractionResponse(await this.uiTransport.interaction(parsedRequest))
      : createBlockedInteractionResponse(
          parsedRequest,
          "Spark UI transport has no interaction handler.",
        );
    this.publishDaemonEvent({
      version: SPARK_PROTOCOL_VERSION,
      type: "daemon.interaction.response",
      source: this.hasUI ? "tui" : "runtime",
      emittedAt: new Date().toISOString(),
      response,
      metadata: {},
    });
    return response;
  }

  publishView(event: SparkViewModelEvent): void {
    this.uiTransport.publishView?.(event);
  }

  publishDaemonEvent(event: SparkDaemonEvent): void {
    for (const listener of Array.from(this.daemonEventListeners)) {
      try {
        listener(event);
      } catch {
        // Daemon-event observers are best-effort projection hooks.
      }
    }
  }

  /** Register the agent-loop wakeup used by extension-triggered next turns. */
  setTriggerTurnHandler(handler: (() => void | Promise<void>) | undefined): void {
    this.triggerTurnHandler = handler;
  }

  /** Keep extension event/tool contexts bound to the active Spark session. */
  setSessionId(sessionId: string | undefined): void {
    const normalized = sessionId?.trim();
    this.sessionId = normalized || undefined;
  }

  /**
   * Build a fresh SparkHostContext with the current UI transport and
   * sessionManager view bound. Each call returns a new object so the host can
   * later swap transports without retroactively mutating prior contexts.
   */
  makeContext(extra: Partial<SparkHostContext> = {}): SparkHostContext & {
    sessionManager?: SparkHostSessionManagerStub;
    modelRegistry?: SparkHostModelRegistryLike;
  } {
    return {
      cwd: this.cwd,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.sparkStateRoot ? { sparkStateRoot: this.sparkStateRoot } : {}),
      ...(this.sessionSurface ? { sessionSurface: this.sessionSurface } : {}),
      ...(this.sessionSource ? { sessionSource: this.sessionSource } : {}),
      ...(this.channelBinding ? { channelBinding: this.channelBinding } : {}),
      ...(this.invocationId ? { invocationId: this.invocationId } : {}),
      ...(this.sessionQuestionChain
        ? { sessionQuestionChain: [...this.sessionQuestionChain] }
        : {}),
      hasUI: this.hasUI,
      ui: this.uiTransport as ExtensionUi,
      isIdle: () => this.isIdle(),
      sessionManager: this.sessionManager,
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry } : {}),
      ...(this.leafRunner ? { runLeaf: this.leafRunner } : {}),
      ...(this.roleRunner ? { runRole: this.roleRunner } : {}),
      ...extra,
    };
  }

  /** Are no tool calls / streamed turns currently in flight? */
  isIdle(): boolean {
    return this.idle;
  }

  /** Internal: agent turn loop will toggle this around active turns. */
  setIdle(value: boolean): void {
    this.idle = value;
  }

  // ── KeybindingsManager (host-only surface) ─────────────────────────────

  getKeybindings(): SparkKeybindings {
    return this.keybindings;
  }

  async executeKey(key: string, extra: Partial<SparkHostContext> = {}): Promise<boolean> {
    return this.keybindings.executeKey(
      key,
      this.makeContext(extra) as unknown as SparkKeybindingContext,
    );
  }

  // ── Tool registration listeners (used by ExtensionLoader/tests) ────────

  onToolRegistration(listener: ToolRegistrationListener): () => void {
    this.toolRegistrationListeners.add(listener);
    return () => {
      this.toolRegistrationListeners.delete(listener);
    };
  }

  onDaemonEvent(listener: SparkDaemonEventListener): () => void {
    this.daemonEventListeners.add(listener);
    return () => {
      this.daemonEventListeners.delete(listener);
    };
  }

  // ── Custom message rendering (host-only surface) ───────────────────────

  registerMessageRenderer(customType: string, renderer: SparkHostMessageRenderer): void {
    if (!customType) {
      throw new Error("SparkHostRuntime.registerMessageRenderer requires a customType");
    }
    if (typeof renderer !== "function") {
      throw new Error("SparkHostRuntime.registerMessageRenderer requires a renderer function");
    }
    this.messageRenderers.set(customType, renderer);
  }

  getMessageRenderer(customType: string): SparkHostMessageRenderer | undefined {
    return this.messageRenderers.get(customType);
  }

  listMessageRenderers(): Array<{ customType: string; renderer: SparkHostMessageRenderer }> {
    return Array.from(this.messageRenderers.entries()).map(([customType, renderer]) => ({
      customType,
      renderer,
    }));
  }

  // ── Not yet implemented (placeholders pinned to follow-up tasks) ───────

  registerShortcut(
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: SparkHostContext) => unknown;
      isActive?: (ctx: SparkHostContext) => boolean;
    },
  ): void {
    if (!shortcut) throw new Error("SparkHostRuntime.registerShortcut requires a shortcut key");
    if (typeof options?.handler !== "function") {
      throw new Error("SparkHostRuntime.registerShortcut requires a handler function");
    }
    const id = `extension.shortcut.${shortcut}`;
    this.keybindings.register({
      id,
      defaultKey: shortcut,
      description: options.description ?? `Extension shortcut for ${shortcut}`,
      handler: async (ctx: SparkKeybindingContext) => {
        await options.handler(ctx as SparkHostContext);
      },
      isActive: options.isActive
        ? (ctx: SparkKeybindingContext) => options.isActive!(ctx as SparkHostContext)
        : undefined,
    });
  }

  registerFlag(_name: string, _options: unknown): void {
    throw NOT_IMPLEMENTED("registerFlag");
  }

  setModel(_model: string): void {
    throw NOT_IMPLEMENTED("setModel");
  }

  setThinkingLevel(_level: string): void {
    throw NOT_IMPLEMENTED("setThinkingLevel");
  }

  exec(_command: string, _args: string[], _options?: unknown): unknown {
    throw NOT_IMPLEMENTED("exec");
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private toRegisteredCommand(config: CommandConfig): RegisteredCommand {
    if (typeof config.handler !== "function") {
      throw new Error("SparkHostRuntime.registerCommand requires a handler function");
    }
    return {
      description: config.description,
      argumentHint: config.argumentHint,
      metadata: config.metadata,
      getArgumentCompletions: config.getArgumentCompletions,
      handler: config.handler as RegisteredCommand["handler"],
    };
  }
}

export function createSparkHostRuntime(options: SparkHostRuntimeOptions): SparkHostRuntime {
  return new SparkHostRuntime(options);
}
