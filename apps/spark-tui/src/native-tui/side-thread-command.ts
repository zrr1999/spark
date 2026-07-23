/** Native `/btw` control surface for daemon-owned read-only side threads. */

import {
  createId,
  type SparkModelRef,
  type SparkSideThreadMode,
  type SparkSideThreadSnapshot,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { SparkNativeSlashCommandMap } from "./types.ts";

export interface SparkNativeSideThreadClient {
  ensure(input: {
    parentSessionId: string;
    mode?: SparkSideThreadMode;
  }): Promise<SparkSideThreadSnapshot>;
  snapshot(input: { parentSessionId: string }): Promise<SparkSideThreadSnapshot>;
  submit(input: {
    parentSessionId: string;
    expectedGeneration: number;
    prompt: string;
    idempotencyKey: string;
  }): Promise<{ snapshot: SparkSideThreadSnapshot }>;
  reset(input: {
    parentSessionId: string;
    expectedGeneration: number;
    mode: SparkSideThreadMode;
  }): Promise<SparkSideThreadSnapshot>;
  configure(input: {
    parentSessionId: string;
    expectedGeneration: number;
    modelOverride?: SparkModelRef | null;
    thinkingOverride?: SparkThinkingLevel | null;
  }): Promise<SparkSideThreadSnapshot>;
  handoff(input: {
    parentSessionId: string;
    expectedGeneration: number;
    expectedHeadExchangeId: string;
    kind: "full" | "summary";
    instructions?: string;
    idempotencyKey: string;
  }): Promise<{ snapshot: SparkSideThreadSnapshot }>;
}

export function createSparkNativeSideThreadSlashCommands(options: {
  parentSessionId: () => string;
  client: SparkNativeSideThreadClient;
}): SparkNativeSlashCommandMap {
  const pendingOperations: SideThreadPendingOperations = {};
  const read = async () =>
    await options.client.ensure({
      parentSessionId: requireParentSessionId(options.parentSessionId),
    });
  const commandHandlers = createSideThreadCommandHandlers({
    client: options.client,
    read,
    pendingOperations,
  });
  return {
    btw: {
      description: "open and control the daemon-owned read-only side thread",
      argumentHint: "[show|ask|reset|handoff|model|thinking]",
      metadata: {
        source: "extension",
        extensionId: "spark-native-side-thread",
        plane: "daemon",
        resource: "side-thread",
        verbs: ["open", "show", "submit", "reset", "configure", "handoff"],
        canonicalCliTarget: "spark tui /btw <subcommand>",
      },
      getArgumentCompletions: (prefix) =>
        ["show", "ask", "reset", "handoff", "model", "thinking"]
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs) => {
        const { command, rest } = splitCommand(rawArgs);
        if (isSideThreadReadCommand(command)) return formatSideThread(await read());
        const action = Object.hasOwn(commandHandlers, command)
          ? commandHandlers[command]
          : undefined;
        return action ? await action(rest) : sideThreadUsage(`unknown subcommand: ${command}`);
      },
    },
  };
}

type SideThreadPendingOperation = { fingerprint: string; idempotencyKey: string };
type SideThreadPendingOperations = {
  submit?: SideThreadPendingOperation;
  handoff?: SideThreadPendingOperation;
};
type SideThreadCommandHandler = (rest: string) => Promise<string>;

function createSideThreadCommandHandlers({
  client,
  read,
  pendingOperations,
}: {
  client: SparkNativeSideThreadClient;
  read: () => Promise<SparkSideThreadSnapshot>;
  pendingOperations: SideThreadPendingOperations;
}): Record<string, SideThreadCommandHandler> {
  return {
    ask: async (rest) => await submitSideThreadQuestion(client, read, pendingOperations, rest),
    send: async (rest) => await submitSideThreadQuestion(client, read, pendingOperations, rest),
    reset: async (rest) => await resetSideThread(client, read, rest),
    handoff: async (rest) => await handoffSideThread(client, read, pendingOperations, rest),
    model: async (rest) => await configureSideThreadModel(client, read, rest),
    thinking: async (rest) => await configureSideThreadThinking(client, read, rest),
  };
}

async function submitSideThreadQuestion(
  client: SparkNativeSideThreadClient,
  read: () => Promise<SparkSideThreadSnapshot>,
  pendingOperations: SideThreadPendingOperations,
  prompt: string,
): Promise<string> {
  if (!prompt) return sideThreadUsage("ask requires a question");
  const snapshot = await read();
  const fingerprint = JSON.stringify([snapshot.parentSessionId, snapshot.generation, prompt]);
  const idempotencyKey = reusableOperationKey(pendingOperations.submit, fingerprint);
  pendingOperations.submit = { fingerprint, idempotencyKey };
  const result = await client.submit({
    parentSessionId: snapshot.parentSessionId,
    expectedGeneration: snapshot.generation,
    prompt,
    idempotencyKey,
  });
  pendingOperations.submit = undefined;
  return `Side thread question accepted (read-only).\n${formatSideThread(result.snapshot)}`;
}

async function resetSideThread(
  client: SparkNativeSideThreadClient,
  read: () => Promise<SparkSideThreadSnapshot>,
  value: string,
): Promise<string> {
  const mode = parseMode(value || "contextual");
  if (!mode) return sideThreadUsage("reset mode must be contextual or tangent");
  const snapshot = await read();
  return formatSideThread(
    await client.reset({
      parentSessionId: snapshot.parentSessionId,
      expectedGeneration: snapshot.generation,
      mode,
    }),
  );
}

async function handoffSideThread(
  client: SparkNativeSideThreadClient,
  read: () => Promise<SparkSideThreadSnapshot>,
  pendingOperations: SideThreadPendingOperations,
  value: string,
): Promise<string> {
  const { command: kind, rest: instructions } = splitCommand(value);
  if (kind !== "full" && kind !== "summary") {
    return sideThreadUsage("handoff kind must be full or summary");
  }
  const snapshot = await read();
  if (!snapshot.headExchangeId) return "Side thread has no completed exchange to hand off yet.";
  const fingerprint = JSON.stringify([
    snapshot.parentSessionId,
    snapshot.generation,
    snapshot.headExchangeId,
    kind,
    instructions,
  ]);
  const idempotencyKey = reusableOperationKey(pendingOperations.handoff, fingerprint);
  pendingOperations.handoff = { fingerprint, idempotencyKey };
  const result = await client.handoff({
    parentSessionId: snapshot.parentSessionId,
    expectedGeneration: snapshot.generation,
    expectedHeadExchangeId: snapshot.headExchangeId,
    kind,
    ...(instructions ? { instructions } : {}),
    idempotencyKey,
  });
  pendingOperations.handoff = undefined;
  return `Side-thread ${kind} handoff accepted by the parent.\n${formatSideThread(result.snapshot)}`;
}

async function configureSideThreadModel(
  client: SparkNativeSideThreadClient,
  read: () => Promise<SparkSideThreadSnapshot>,
  value: string,
): Promise<string> {
  const modelOverride = parseModelOverride(value);
  if (modelOverride === undefined) {
    return sideThreadUsage("model must be inherit or <provider>/<model-id>");
  }
  const snapshot = await read();
  return formatSideThread(
    await client.configure({
      parentSessionId: snapshot.parentSessionId,
      expectedGeneration: snapshot.generation,
      modelOverride,
    }),
  );
}

async function configureSideThreadThinking(
  client: SparkNativeSideThreadClient,
  read: () => Promise<SparkSideThreadSnapshot>,
  value: string,
): Promise<string> {
  const thinkingOverride = parseThinkingOverride(value);
  if (thinkingOverride === undefined) {
    return sideThreadUsage("thinking must be inherit, off, minimal, low, medium, high, or xhigh");
  }
  const snapshot = await read();
  return formatSideThread(
    await client.configure({
      parentSessionId: snapshot.parentSessionId,
      expectedGeneration: snapshot.generation,
      thinkingOverride,
    }),
  );
}

function isSideThreadReadCommand(command: string): boolean {
  return !command || command === "show" || command === "open";
}

function reusableOperationKey(
  pending: { fingerprint: string; idempotencyKey: string } | undefined,
  fingerprint: string,
): string {
  return pending?.fingerprint === fingerprint ? pending.idempotencyKey : createId("idem");
}

function requireParentSessionId(resolve: () => string): string {
  const parentSessionId = resolve().trim();
  if (!parentSessionId)
    throw new Error("Side thread is unavailable until the parent daemon session is ready.");
  return parentSessionId;
}

function splitCommand(input: string): { command: string; rest: string } {
  const trimmed = input.trim();
  let separator = 0;
  while (separator < trimmed.length && trimmed[separator]?.trim()) separator += 1;
  return {
    command: trimmed.slice(0, separator).toLowerCase(),
    rest: trimmed.slice(separator).trim(),
  };
}

function parseMode(value: string): SparkSideThreadMode | undefined {
  return value === "contextual" || value === "tangent" ? value : undefined;
}

function parseModelOverride(value: string): SparkModelRef | null | undefined {
  if (value === "inherit") return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerName: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function parseThinkingOverride(value: string): SparkThinkingLevel | null | undefined {
  if (value === "inherit") return null;
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? (value as SparkThinkingLevel)
    : undefined;
}

export function formatSideThread(snapshot: SparkSideThreadSnapshot): string {
  const model = snapshot.effectiveModel
    ? `${snapshot.effectiveModel.providerName}/${snapshot.effectiveModel.modelId}`
    : "inherit";
  const thinking = snapshot.effectiveThinkingLevel ?? "inherit";
  const header = [
    `Side thread · ${snapshot.status} · generation ${snapshot.generation} · ${snapshot.mode}`,
    `readonly: enforced · model: ${model} · thinking: ${thinking}`,
  ];
  const exchanges = snapshot.exchanges.slice(-5);
  if (exchanges.length === 0) {
    header.push("No completed exchanges. Use /btw ask <question>.");
  } else {
    header.push(
      ...exchanges.flatMap((exchange, index) => [
        `${index + 1}. you: ${oneLine(exchange.user)}`,
        `   side: ${oneLine(exchange.assistant)}`,
      ]),
    );
  }
  if (snapshot.pendingTurns.length > 0) header.push(`pending: ${snapshot.pendingTurns.length}`);
  if (snapshot.hasMore) header.push("Older exchanges are available in daemon history.");
  if (snapshot.projectionTruncated) {
    header.push("Display shortened to fit the control transport; the native transcript is intact.");
  }
  if (snapshot.fallbackReason) header.push(`note: ${snapshot.fallbackReason}`);
  return header.join("\n");
}

function oneLine(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function sideThreadUsage(error: string): string {
  return `${error}. Usage: /btw [show] | /btw ask <question> | /btw reset <contextual|tangent> | /btw handoff <full|summary> [instructions] | /btw model <inherit|provider/model> | /btw thinking <inherit|off|minimal|low|medium|high|xhigh>`;
}
