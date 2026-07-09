import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RoleRef, RunRef } from "@zendev-lab/spark-extension-api";

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
    noSession?: boolean;
    sessionPersistence?: "anonymous" | "persistent";
  };
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: "fresh" | "forked";
  forkFromSession?: string;
  model?: string;
  noSession?: boolean;
  sessionPersistence?: "anonymous" | "persistent";
  onEvent?: (event: unknown) => void | Promise<void>;
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
  timeoutMs?: number;
  sparkHome?: string;
  onEvent?: (event: unknown) => void | Promise<void>;
}

export interface SparkHeadlessSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  stderr: string;
  jsonEvents: unknown[];
  eventsStreamed?: boolean;
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

  const recordEvent = (event: unknown) => {
    jsonEvents.push(event);
    void input.onEvent?.(event);
  };
  const unsubscribe = services.agentLoop.onEvent((event) => {
    recordEvent(serializeLoopEvent(event));
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    recordEvent({ type: "daemon_event", event });
  });
  const abort = (reason?: string) => services.agentLoop.abort(reason ?? abortReason(input.signal));
  const abortFromSignal = () => abort();
  if (input.signal?.aborted) abortFromSignal();
  else input.signal?.addEventListener("abort", abortFromSignal, { once: true });

  try {
    const session = new SparkAgentSession(services);
    const result = await runWithHeadlessTimeout(
      session.run({
        sessionId: input.sessionId,
        prompt: input.prompt,
        reset: input.reset,
      }),
      input.timeoutMs,
      abort,
    );
    return {
      sessionId: result.sessionId,
      sessionPath: result.sessionPath,
      newMessageCount: result.newMessageCount,
      assistantText: result.assistantText,
      stderr: renderDiagnostics(services.diagnostics),
      jsonEvents,
      ...(input.onEvent ? { eventsStreamed: true } : {}),
    };
  } finally {
    input.signal?.removeEventListener("abort", abortFromSignal);
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
  const noSession = input.noSession === true || input.record.noSession === true;
  if (launch === "forked" && !forkFromSession?.trim()) {
    throw new Error("Spark daemon-native forked role execution requires forkFromSession");
  }
  if (noSession && launch === "forked") {
    throw new Error(
      "Spark daemon-native anonymous role execution does not support forked sessions",
    );
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

  const recordEvent = (event: unknown) => {
    jsonEvents.push(event);
    void input.onEvent?.(event);
  };

  applyAllowedTools(services, input.role.allowedTools);
  if (input.model?.trim()) {
    try {
      selectHeadlessModel(services, input.model.trim());
    } catch (error) {
      recordEvent(providerResolutionFailedEvent(input.model.trim(), error));
      return {
        record: {
          ...input.record,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          launch,
          model: input.model.trim(),
          ...(noSession
            ? { noSession: true, sessionPersistence: "anonymous" as const }
            : { sessionPersistence: "persistent" as const }),
        },
        stdout: "",
        stderr: [renderDiagnostics(services.diagnostics), errorMessage(error)]
          .filter(Boolean)
          .join("\n"),
        jsonEvents,
      };
    }
  }
  const unsubscribe = services.agentLoop.onEvent((event) => {
    recordEvent(serializeLoopEvent(event));
  });
  const unsubscribeDaemon = services.runtime.onDaemonEvent((event) => {
    recordEvent({ type: "daemon_event", event });
  });
  const abort = (reason?: string) => services.agentLoop.abort(reason ?? abortReason(input.signal));
  const abortFromSignal = () => abort();
  if (input.signal?.aborted) abortFromSignal();
  else input.signal?.addEventListener("abort", abortFromSignal, { once: true });

  try {
    const session = new SparkAgentSession(services);
    const sessionRunInput = {
      sessionId: headlessSessionId(input),
      prompt: input.instruction.instruction,
      reset: true,
      ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
    };
    const result = await runWithHeadlessTimeout(
      noSession ? session.runAnonymous(sessionRunInput) : session.run(sessionRunInput),
      input.timeoutMs,
      abort,
    );
    const status = statusForAssistant(result.assistant, input.signal);
    return {
      record: {
        ...input.record,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        launch,
        model: input.model,
        ...(noSession ? {} : { sessionDir: services.sessionStore.sessionDir }),
        ...(launch === "forked" && forkFromSession ? { forkFromSession } : {}),
        ...(noSession
          ? { noSession: true, sessionPersistence: "anonymous" as const }
          : { sessionPersistence: "persistent" as const }),
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
        ...(noSession
          ? { noSession: true, sessionPersistence: "anonymous" as const }
          : { sessionPersistence: "persistent" as const }),
      },
      stdout: "",
      stderr: [renderDiagnostics(services.diagnostics), errorMessage(error)]
        .filter(Boolean)
        .join("\n"),
      jsonEvents,
    };
  } finally {
    input.signal?.removeEventListener("abort", abortFromSignal);
    unsubscribe();
    unsubscribeDaemon();
  }
}

export class SparkHeadlessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Spark headless session timed out after ${timeoutMs}ms`);
    this.name = "SparkHeadlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function runWithHeadlessTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  abort: (reason?: string) => void,
): Promise<T> {
  const normalizedTimeoutMs = normalizeHeadlessTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) return await promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new SparkHeadlessTimeoutError(normalizedTimeoutMs);
          abort(error.message);
          reject(error);
        }, normalizedTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeHeadlessTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs)) return undefined;
  const normalized = Math.floor(timeoutMs);
  return normalized > 0 ? normalized : undefined;
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
  if (!provider)
    throw new Error(
      `Spark native provider registry cannot resolve model selector '${model}'. Set a role model using an available native Spark provider/model, or compare with Pi/Codex model selectors using spark-role-run-diagnostics.`,
    );
  return { providerName: provider.name, modelId: model };
}

function providerResolutionFailedEvent(modelSelector: string, error: unknown): unknown {
  return {
    type: "provider_resolution_failed",
    modelSelector,
    message: errorMessage(error),
    nextAction:
      "Check the native Spark provider registry/model selector and align role model settings with an available provider/model.",
  };
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
