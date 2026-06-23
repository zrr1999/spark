import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RoleRef, RunRef } from "@zendev-lab/pi-extension-api";

import {
  assistantMessageToText,
  createSparkCliHostServices,
  type SparkCliHostDiagnostic,
  type SparkCliHostServicesOptions,
} from "./host/bootstrap.ts";
import type { SparkAgentLoopEvent } from "./host/agent-loop.ts";
import { SparkAgentSession } from "./host/agent-session.ts";
import type { SparkActiveSelection } from "./host/provider-registry.ts";

export type SparkHeadlessRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export interface SparkHeadlessRoleInstructionInput {
  role: {
    ref: RoleRef;
    id: string;
    systemPrompt: string;
    allowedTools?: string[];
  };
  instruction: {
    roleRef: RoleRef;
    instruction: string;
    inputs?: string[];
  };
  record: {
    ref: RunRef;
    roleRef: RoleRef;
    runName?: string;
    instruction: string;
    status: SparkHeadlessRoleRunStatus;
    startedAt?: string;
    finishedAt?: string;
    launch?: "fresh" | "forked";
    model?: string;
    sessionDir?: string;
    forkFromSession?: string;
  };
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: "fresh" | "forked";
  forkFromSession?: string;
  model?: string;
}

export interface SparkHeadlessRoleInstructionResult {
  record: SparkHeadlessRoleInstructionInput["record"];
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface SparkHeadlessSessionRunInput {
  cwd: string;
  sessionId: string;
  prompt: string;
  reset?: boolean;
  signal?: AbortSignal;
  sparkHome?: string;
}

export interface SparkHeadlessSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  stderr: string;
  jsonEvents: unknown[];
}

export interface SparkHeadlessRoleExecutorOptions {
  sparkHome?: string;
  createServices?: typeof createSparkCliHostServices;
}

export function createSparkHeadlessRoleExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessRoleInstructionInput) => Promise<SparkHeadlessRoleInstructionResult> {
  return async (input) => runSparkHeadlessRoleInstruction(input, options);
}

export function createSparkHeadlessSessionExecutor(
  options: SparkHeadlessRoleExecutorOptions = {},
): (input: SparkHeadlessSessionRunInput) => Promise<SparkHeadlessSessionRunResult> {
  return async (input) => runSparkHeadlessSession(input, options);
}

export async function runSparkHeadlessSession(
  input: SparkHeadlessSessionRunInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessSessionRunResult> {
  const jsonEvents: unknown[] = [];
  const createServices = options.createServices ?? createSparkCliHostServices;
  const services = await createServices({
    cwd: input.cwd,
    sparkHome: options.sparkHome ?? input.sparkHome,
    hasUI: false,
  } satisfies SparkCliHostServicesOptions);

  const unsubscribe = services.agentLoop.onEvent((event) => {
    jsonEvents.push(serializeLoopEvent(event));
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    jsonEvents.push({ type: "daemon_event", event });
  });
  const abort = () => services.agentLoop.abort(abortReason(input.signal));
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  try {
    const session = new SparkAgentSession(services);
    const result = await session.run({
      sessionId: input.sessionId,
      prompt: input.prompt,
      reset: input.reset,
    });
    return {
      sessionId: result.sessionId,
      sessionPath: result.sessionPath,
      newMessageCount: result.newMessageCount,
      assistantText: result.assistantText,
      stderr: renderDiagnostics(services.diagnostics),
      jsonEvents,
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    unsubscribeDaemon();
  }
}

export async function runSparkHeadlessRoleInstruction(
  input: SparkHeadlessRoleInstructionInput,
  options: SparkHeadlessRoleExecutorOptions = {},
): Promise<SparkHeadlessRoleInstructionResult> {
  const launch = input.launch ?? input.record.launch ?? "fresh";
  const forkFromSession = input.forkFromSession ?? input.record.forkFromSession;
  if (launch === "forked" && !forkFromSession?.trim()) {
    throw new Error("Spark daemon-native forked role execution requires forkFromSession");
  }
  const startedAt = input.record.startedAt ?? new Date().toISOString();
  const jsonEvents: unknown[] = [];
  const createServices = options.createServices ?? createSparkCliHostServices;
  const services = await createServices({
    cwd: input.cwd,
    sparkHome: options.sparkHome,
    hasUI: false,
    systemPrompt: input.role.systemPrompt,
  } satisfies SparkCliHostServicesOptions);

  applyAllowedTools(services, input.role.allowedTools);
  if (input.model?.trim()) selectHeadlessModel(services, input.model.trim());

  const unsubscribe = services.agentLoop.onEvent((event) => {
    jsonEvents.push(serializeLoopEvent(event));
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    jsonEvents.push({ type: "daemon_event", event });
  });
  const abort = () => services.agentLoop.abort(abortReason(input.signal));
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  try {
    const session = new SparkAgentSession(services);
    const result = await session.run({
      sessionId: headlessSessionId(input),
      prompt: input.instruction.instruction,
      reset: true,
      ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
    });
    const status = statusForAssistant(result.assistant, input.signal);
    return {
      record: {
        ...input.record,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        launch,
        model: input.model,
        sessionDir: services.sessionStore.sessionDir,
        ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
      },
      stdout: result.assistantText,
      stderr: renderDiagnostics(services.diagnostics),
      jsonEvents,
    };
  } catch (error) {
    const aborted = Boolean(input.signal?.aborted);
    return {
      record: {
        ...input.record,
        status: aborted ? "cancelled" : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        launch,
        model: input.model,
        ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
      },
      stdout: "",
      stderr: [renderDiagnostics(services.diagnostics), errorMessage(error)]
        .filter(Boolean)
        .join("\n"),
      jsonEvents,
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    unsubscribeDaemon();
  }
}

function applyAllowedTools(
  services: Awaited<ReturnType<typeof createSparkCliHostServices>>,
  allowedTools: string[] | undefined,
): void {
  if (!allowedTools) return;
  services.runtime.setActiveTools(allowedTools);
}

function selectHeadlessModel(
  services: Awaited<ReturnType<typeof createSparkCliHostServices>>,
  model: string,
): void {
  const selection = resolveHeadlessModelSelection(services, model);
  services.providerRegistry.setActive(selection);
}

function resolveHeadlessModelSelection(
  services: Awaited<ReturnType<typeof createSparkCliHostServices>>,
  model: string,
): SparkActiveSelection {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const selection = { providerName: model.slice(0, slash), modelId: model.slice(slash + 1) };
    services.providerRegistry.buildModel(selection.providerName, selection.modelId);
    return selection;
  }

  const active = services.providerRegistry.getActive();
  if (
    active &&
    services.providerRegistry
      .listModelsFor(active.providerName)
      .some((candidate) => candidate.id === model)
  ) {
    return { providerName: active.providerName, modelId: model };
  }

  const provider = services.providerRegistry
    .listProviders()
    .find((candidate) => candidate.models.some((candidateModel) => candidateModel.id === model));
  if (!provider) throw new Error(`Unknown Spark headless model: ${model}`);
  return { providerName: provider.name, modelId: model };
}

function statusForAssistant(
  assistant: AssistantMessage | undefined,
  signal: AbortSignal | undefined,
): SparkHeadlessRoleRunStatus {
  if (signal?.aborted || assistant?.stopReason === "aborted") return "cancelled";
  if (!assistant || assistant.stopReason === "error") return "failed";
  return "succeeded";
}

function headlessSessionId(input: SparkHeadlessRoleInstructionInput): string {
  const base = input.runName?.trim() || input.record.runName?.trim() || input.record.ref;
  return `spark-daemon-${base.replace(/[^A-Za-z0-9_.:-]+/gu, "-")}`;
}

function serializeLoopEvent(event: SparkAgentLoopEvent): unknown {
  switch (event.type) {
    case "user_message":
      return { type: event.type, message: event.message };
    case "stream_event":
      return { type: event.type, event: event.event };
    case "tool_result":
      return { type: event.type, message: event.message };
    case "turn_complete":
      return { type: event.type, message: event.assistant, reason: event.reason };
    case "view_event":
      return { type: event.type, event: event.event };
    case "abort":
      return { type: event.type, reason: event.reason };
    case "error":
      return { type: event.type, message: event.message };
  }
}

function renderDiagnostics(diagnostics: SparkCliHostDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`).join("\n");
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "abort";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assistantTextFromHeadlessResult(
  result: SparkHeadlessRoleInstructionResult,
): string {
  if (result.stdout.trim()) return result.stdout.trim();
  for (const event of [...result.jsonEvents].reverse()) {
    if (!event || typeof event !== "object") continue;
    const text = assistantMessageToText(
      (event as { message?: { content?: unknown } }).message ?? {},
    );
    if (text.trim()) return text.trim();
  }
  return "";
}
