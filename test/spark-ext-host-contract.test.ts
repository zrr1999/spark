import assert from "node:assert/strict";
import test from "node:test";

import type {
  CommandConfig,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUiNotifyLevel,
  ToolConfig,
  ToolInfo,
} from "@zendev-lab/pi-extension-api";

import { SparkHostRuntime } from "../packages/spark-cli/src/host/runtime.ts";
import type {
  OutboxEnvelope,
  RegisteredCommand,
  RegisteredTool,
} from "../packages/spark-cli/src/host/types.ts";

interface ContractObservation {
  registeredTools: string[];
  activeTools: string[];
  commandNames: string[];
  eventResults: unknown[];
  commandReturn: unknown;
  duplicateCommandReturn: unknown;
  toolUpdates: string[];
  toolResult: unknown;
  outbox: NormalizedOutboxEnvelope[];
  notifications: Array<{ message: string; level?: ExtensionUiNotifyLevel }>;
  statuses: Array<{ key: string; text: string | undefined }>;
}

interface NormalizedOutboxEnvelope {
  kind: "custom" | "user";
  customType?: string;
  content: OutboxEnvelope["content"];
  display?: boolean;
  details?: Record<string, unknown>;
  options: OutboxEnvelope["options"];
}

interface ContractDriver {
  api: ExtensionAPI;
  notifications: Array<{ message: string; level?: ExtensionUiNotifyLevel }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  emit(event: string, payload?: unknown): Promise<unknown[]>;
  listTools(): RegisteredTool[];
  getTool(name: string): RegisteredTool | undefined;
  getAllTools(): ToolInfo[];
  setActiveTools(names: string[]): void;
  listCommands(): Array<{ name: string; command: RegisteredCommand }>;
  getCommand(name: string): RegisteredCommand | undefined;
  makeCommandContext(): ExtensionCommandContext;
  makeToolContext(): ExtensionContext;
  drainOutbox(): OutboxEnvelope[];
}

class PiExtensionApiAdapter implements ExtensionAPI {
  readonly notifications: Array<{ message: string; level?: ExtensionUiNotifyLevel }> = [];
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly listeners = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  private readonly outbox: OutboxEnvelope[] = [];

  readonly cwd: string;
  readonly hasUI: boolean;

  constructor(cwd: string, hasUI = true) {
    this.cwd = cwd;
    this.hasUI = hasUI;
  }

  registerTool(config: ToolConfig): void {
    const existing = this.tools.get(config.name);
    this.tools.set(config.name, { config, active: existing?.active ?? true });
  }

  registerCommand(name: string, config: CommandConfig): void {
    const registeredName = this.nextCommandName(name);
    this.commands.set(registeredName, {
      description: config.description,
      handler: config.handler as RegisteredCommand["handler"],
    });
  }

  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  getAllTools(): ToolInfo[] {
    const tools: ToolInfo[] = [];
    for (const [name, tool] of this.tools) {
      if (tool.active) tools.push({ name });
    }
    return tools;
  }

  setActiveTools(names: string[]): void {
    const requested = new Set(names);
    for (const [name, tool] of this.tools) tool.active = requested.has(name);
  }

  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void {
    this.outbox.push({
      kind: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      options: { deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn },
      enqueuedAt: Date.now(),
    });
  }

  sendUserMessage(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void {
    this.outbox.push({
      kind: "user",
      content,
      options: {
        deliverAs: options?.deliverAs,
        streamingBehavior: options?.streamingBehavior,
      },
      enqueuedAt: Date.now(),
    });
  }

  async emit(event: string, payload?: unknown): Promise<unknown[]> {
    const listeners = this.listeners.get(event);
    if (!listeners?.length) return [];
    const results: unknown[] = [];
    for (const listener of listeners) {
      try {
        const value = listener(payload, this.makeContext());
        results.push(value instanceof Promise ? await value : value);
      } catch (error) {
        results.push({ error });
      }
    }
    return results;
  }

  listTools(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  listCommands(): Array<{ name: string; command: RegisteredCommand }> {
    return [...this.commands.entries()].map(([name, command]) => ({ name, command }));
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.commands.get(name);
  }

  makeCommandContext(): ExtensionCommandContext {
    return {
      ...this.makeContext(),
      sendUserMessage: async (content) => this.sendUserMessage(content, { deliverAs: "steer" }),
    };
  }

  makeToolContext(): ExtensionContext {
    return this.makeContext();
  }

  drainOutbox(): OutboxEnvelope[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  private makeContext(): ExtensionContext {
    return {
      cwd: this.cwd,
      hasUI: this.hasUI,
      ui: {
        notify: (message, level) => this.notifications.push({ message, level }),
        setStatus: (key, text) => this.statuses.push({ key, text }),
      },
    };
  }

  private nextCommandName(name: string): string {
    if (!this.commands.has(name)) return name;
    let counter = 1;
    let suffixed = `${name}:${counter}`;
    while (this.commands.has(suffixed)) {
      counter += 1;
      suffixed = `${name}:${counter}`;
    }
    return suffixed;
  }
}

function makeSparkDriver(): ContractDriver {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-ext-contract", hasUI: true });
  const notifications: ContractDriver["notifications"] = [];
  const statuses: ContractDriver["statuses"] = [];
  host.setUiTransport({
    notify: (message, level) => notifications.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
  });
  return {
    api: host,
    notifications,
    statuses,
    emit: (event, payload) => host.emit(event, payload),
    listTools: () => host.listTools(),
    getTool: (name) => host.getTool(name),
    getAllTools: () => host.getAllTools(),
    setActiveTools: (names) => host.setActiveTools(names),
    listCommands: () => host.listCommands(),
    getCommand: (name) => host.getCommand(name),
    makeCommandContext: () => ({
      ...host.makeContext(),
      sendUserMessage: async (content) => host.sendUserMessage(content, { deliverAs: "steer" }),
    }),
    makeToolContext: () => host.makeContext(),
    drainOutbox: () => host.drainOutbox(),
  };
}

function makePiAdapterDriver(): ContractDriver {
  const adapter = new PiExtensionApiAdapter("/tmp/spark-ext-contract", true);
  return {
    api: adapter,
    notifications: adapter.notifications,
    statuses: adapter.statuses,
    emit: (event, payload) => adapter.emit(event, payload),
    listTools: () => adapter.listTools(),
    getTool: (name) => adapter.getTool(name),
    getAllTools: () => adapter.getAllTools(),
    setActiveTools: (names) => adapter.setActiveTools(names),
    listCommands: () => adapter.listCommands(),
    getCommand: (name) => adapter.getCommand(name),
    makeCommandContext: () => adapter.makeCommandContext(),
    makeToolContext: () => adapter.makeToolContext(),
    drainOutbox: () => adapter.drainOutbox(),
  };
}

function contractFixtureExtension(pi: ExtensionAPI): void {
  pi.registerTool?.({
    name: "contract_echo",
    description: "Echo test tool",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    async execute(toolCallId, params, _signal, onUpdate, ctx) {
      const text = typeof params.text === "string" ? params.text : "";
      onUpdate({ content: [{ type: "text", text: `update:${text}` }] });
      ctx.ui?.notify?.(`tool:${ctx.cwd}:${text}`, "success");
      pi.sendMessage?.(
        {
          customType: "contract-tool",
          content: text,
          display: true,
          details: { toolCallId },
        },
        { deliverAs: "nextTurn" },
      );
      return {
        content: [{ type: "text", text: `echo:${text}` }],
        details: { cwd: ctx.cwd, toolCallId },
      };
    },
  });

  pi.registerTool?.({
    name: "contract_other",
    description: "Second test tool",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "other" }] };
    },
  });

  pi.registerCommand?.("contract", {
    description: "Primary contract command",
    handler: async (args, ctx) => {
      ctx.ui?.notify?.(`command:${args}:${ctx.cwd}`, "info");
      await ctx.sendUserMessage?.(`ctx-user:${args}`);
      pi.sendUserMessage?.(`pi-user:${args}`, { deliverAs: "followUp" });
      pi.sendMessage?.(
        {
          customType: "contract-command",
          content: args,
          display: false,
          details: { cwd: ctx.cwd },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand?.("contract", {
    description: "Duplicate contract command",
    handler: () => undefined,
  });

  pi.on?.("session_start", (event, ctx) => {
    const label =
      event && typeof event === "object" && "label" in event
        ? String((event as { label: unknown }).label)
        : "none";
    ctx.ui?.setStatus?.("contract", `session:${label}`);
    pi.sendMessage?.(
      {
        customType: "contract-event",
        content: `session_start:${label}`,
        display: true,
        details: { cwd: ctx.cwd },
      },
      { deliverAs: "nextTurn" },
    );
    return "session-started";
  });

  pi.on?.("turn_start", async (_event, ctx) => {
    ctx.ui?.notify?.(`turn:${ctx.cwd}`, "info");
    pi.sendMessage?.(
      { customType: "contract-event", content: "turn_start", display: true },
      { deliverAs: "nextTurn" },
    );
    return "turn-started";
  });
}

async function exercise(driver: ContractDriver): Promise<ContractObservation> {
  contractFixtureExtension(driver.api);

  const registeredTools = driver
    .listTools()
    .map((tool) => tool.config.name)
    .sort();

  driver.setActiveTools(["contract_echo"]);
  const activeTools = driver
    .getAllTools()
    .map((tool) => tool.name)
    .sort();

  const commandNames = driver
    .listCommands()
    .map((entry) => entry.name)
    .sort();

  const eventResults = [
    ...(await driver.emit("session_start", { label: "boot" })),
    ...(await driver.emit("turn_start", {})),
  ];

  const commandReturn = await driver
    .getCommand("contract")!
    .handler("alpha", driver.makeCommandContext());
  const duplicateCommandReturn = await driver
    .getCommand("contract:1")!
    .handler("ignored", driver.makeCommandContext());

  const toolUpdates: string[] = [];
  const toolResult = await driver
    .getTool("contract_echo")!
    .config.execute(
      "tool-call-1",
      { text: "hello" },
      new AbortController().signal,
      (update) => toolUpdates.push(update.content.map((part) => part.text).join("")),
      driver.makeToolContext(),
    );

  return {
    registeredTools,
    activeTools,
    commandNames,
    eventResults,
    commandReturn,
    duplicateCommandReturn,
    toolUpdates,
    toolResult,
    outbox: driver.drainOutbox().map(normalizeOutbox),
    notifications: driver.notifications,
    statuses: driver.statuses,
  };
}

function normalizeOutbox(envelope: OutboxEnvelope): NormalizedOutboxEnvelope {
  return {
    kind: envelope.kind,
    customType: envelope.customType,
    content: envelope.content,
    display: envelope.display,
    details: envelope.details,
    options: envelope.options,
  };
}

void test("ExtensionAPI contract fixture behaves the same on SparkHostRuntime and PiExtensionApiAdapter", async () => {
  const spark = await exercise(makeSparkDriver());
  const piAdapter = await exercise(makePiAdapterDriver());

  assert.deepEqual(spark, piAdapter);
  assert.deepEqual(spark.registeredTools, ["contract_echo", "contract_other"]);
  assert.deepEqual(spark.activeTools, ["contract_echo"]);
  assert.deepEqual(spark.commandNames, ["contract", "contract:1"]);
  assert.deepEqual(spark.eventResults, ["session-started", "turn-started"]);
  assert.deepEqual(spark.toolUpdates, ["update:hello"]);
});
