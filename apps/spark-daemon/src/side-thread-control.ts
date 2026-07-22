import { createHash } from "node:crypto";

import {
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadHandoffResultSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSubmitRequestSchema,
  sparkSideThreadSubmitResultSchema,
  type SparkCommandKind,
  type SparkModelRef,
  type SparkProtocolJsonValue,
  type SparkSessionRegistryRecord,
  type SparkSideThreadErrorCode,
  type SparkSideThreadMode,
} from "@zendev-lab/spark-protocol";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";

import { validateSparkDaemonTask } from "./core/index.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import {
  executeSparkDaemonSessionControl,
  type SparkDaemonSessionControlOptions,
} from "./session-control.ts";
import {
  createSparkDaemonSideThreadTranscript,
  loadSparkDaemonSideThreadExchanges,
  pruneSparkDaemonSideThreadRetiredGenerations,
  projectSparkDaemonSideThreadSnapshot,
  removeUnreferencedSparkDaemonSideThreadTranscript,
  renderSparkDaemonSideThreadHandoffPrompt,
} from "./side-thread-transcript.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "./store/invocations.ts";

const MAX_HANDOFF_BYTES = 48 * 1024;
const sideThreadMutationTails = new Map<string, Promise<void>>();

type SideThreadCommandKind = Extract<
  SparkCommandKind,
  | "side-thread.ensure.request"
  | "side-thread.snapshot.request"
  | "side-thread.submit.request"
  | "side-thread.reset.request"
  | "side-thread.configure.request"
  | "side-thread.handoff.request"
>;

export interface SparkDaemonSideThreadControlRequest {
  kind: SideThreadCommandKind;
  payload: Record<string, unknown>;
  scope?: "any" | "daemon" | "workspace";
  workspaceId?: string;
  workspaceBindingId?: string;
}

export interface SparkDaemonSideThreadControlResult {
  result: Record<string, SparkProtocolJsonValue>;
  invocationId?: string;
}

export async function executeSparkDaemonSideThreadControl(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSideThreadControlRequest,
): Promise<SparkDaemonSideThreadControlResult> {
  switch (request.kind) {
    case "side-thread.ensure.request": {
      const parsed = sparkSideThreadEnsureRequestSchema.parse(request.payload);
      return await serializeSideThreadMutation(parsed.parentSessionId, async () => {
        const parent = await requireParent(options, request, parsed.parentSessionId);
        let child = await findSideThread(options.sessionRegistry, parent.sessionId);
        if (!child) {
          const mode = parsed.mode ?? "contextual";
          const sessionId = sideThreadSessionId(parent.sessionId);
          const sessionPath = await createSparkDaemonSideThreadTranscript(
            options,
            parent,
            sessionId,
            mode,
            1,
          );
          child = await requireRegistry(options).ensureSideThread({
            parentSessionId: parent.sessionId,
            mode,
            sessionId,
            sessionPath,
          });
        }
        return result(await projectSparkDaemonSideThreadSnapshot(options, parent, child, {}));
      });
    }
    case "side-thread.snapshot.request": {
      const parsed = sparkSideThreadSnapshotRequestSchema.parse(request.payload);
      const parent = await requireParent(options, request, parsed.parentSessionId);
      const child = await requireSideThread(options.sessionRegistry, parent.sessionId);
      return result(
        await projectSparkDaemonSideThreadSnapshot(options, parent, child, {
          beforeExchangeId: parsed.beforeExchangeId,
          limit: parsed.limit,
        }),
      );
    }
    case "side-thread.submit.request": {
      const parsed = sparkSideThreadSubmitRequestSchema.parse(request.payload);
      return await serializeSideThreadMutation(parsed.parentSessionId, async () => {
        const parent = await requireParent(options, request, parsed.parentSessionId);
        const child = await requireSideThread(options.sessionRegistry, parent.sessionId);
        assertGeneration(child, parsed.expectedGeneration);
        const store = new SparkInvocationStore(options.db);
        const idempotencyKey = sideThreadSubmitIdempotencyKey(
          parent.sessionId,
          parsed.expectedGeneration,
          parsed.idempotencyKey,
        );
        const replay = store.findByIdempotencyKey(idempotencyKey);
        if (replay) {
          assertSubmitReplay(replay, child.sessionId, parsed.prompt);
          return result(
            sparkSideThreadSubmitResultSchema.parse({
              invocationId: replay.invocationId,
              acceptedAt: replay.createdAt,
              snapshot: await projectSparkDaemonSideThreadSnapshot(options, parent, child, {}),
            }),
            replay.invocationId,
          );
        }
        assertSideThreadIdle(store, child.sessionId);
        const submitted = await executeSparkDaemonSessionControl(options, {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: child.sessionId,
          idempotencyKey,
          allowSideThread: true,
          payload: {
            sessionId: child.sessionId,
            prompt: parsed.prompt,
            idempotencyKey,
            messageMetadata: sideThreadMessageMetadata(parent, child),
          },
        });
        const acceptedAt = requiredString(submitted.result.acceptedAt, "acceptedAt");
        const snapshot = await projectSparkDaemonSideThreadSnapshot(options, parent, child, {});
        return result(
          sparkSideThreadSubmitResultSchema.parse({
            invocationId: submitted.invocationId,
            acceptedAt,
            snapshot,
          }),
          submitted.invocationId,
        );
      });
    }
    case "side-thread.reset.request": {
      const parsed = sparkSideThreadResetRequestSchema.parse(request.payload);
      return await serializeSideThreadMutation(parsed.parentSessionId, async () => {
        const parent = await requireParent(options, request, parsed.parentSessionId);
        const child = await requireSideThread(options.sessionRegistry, parent.sessionId);
        const reset = await resetSideThreadGeneration(
          options,
          parent,
          child,
          parsed.expectedGeneration,
          parsed.mode,
        );
        return result(await projectSparkDaemonSideThreadSnapshot(options, parent, reset, {}));
      });
    }
    case "side-thread.configure.request": {
      const parsed = sparkSideThreadConfigureRequestSchema.parse(request.payload);
      return await serializeSideThreadMutation(parsed.parentSessionId, async () => {
        const parent = await requireParent(options, request, parsed.parentSessionId);
        const child = await requireSideThread(options.sessionRegistry, parent.sessionId);
        assertGeneration(child, parsed.expectedGeneration);
        if (parsed.modelOverride)
          await assertAvailableModel(options.modelControl, parsed.modelOverride);
        const configured = await requireRegistry(options).configureSideThread({
          sessionId: child.sessionId,
          expectedGeneration: parsed.expectedGeneration,
          ...(parsed.modelOverride !== undefined ? { model: parsed.modelOverride } : {}),
          ...(parsed.thinkingOverride !== undefined
            ? { thinkingLevel: parsed.thinkingOverride }
            : {}),
        });
        return result(await projectSparkDaemonSideThreadSnapshot(options, parent, configured, {}));
      });
    }
    case "side-thread.handoff.request": {
      const parsed = sparkSideThreadHandoffRequestSchema.parse(request.payload);
      return await serializeSideThreadMutation(parsed.parentSessionId, async () => {
        const parent = await requireParent(options, request, parsed.parentSessionId);
        let child = await requireSideThread(options.sessionRegistry, parent.sessionId);
        const store = new SparkInvocationStore(options.db);
        // A handoff is pinned by generation + head + rendering inputs. Derive
        // its durable key from that tuple so a client that loses the response
        // can retry with a fresh transport key without admitting a second
        // parent turn.
        const idempotencyKey = sideThreadHandoffIdempotencyKey(parsed);
        const replay = store.findByIdempotencyKey(idempotencyKey);
        if (replay) {
          assertHandoffReplay(replay, child.sessionId, parsed);
          if (child.relation?.kind === "side_thread") {
            if (child.relation.generation === parsed.expectedGeneration) {
              child = await resetSideThreadGeneration(
                options,
                parent,
                child,
                parsed.expectedGeneration,
                child.relation.mode,
              );
            } else if (child.relation.generation < parsed.expectedGeneration) {
              throw sideThreadError(
                "side_thread_generation_conflict",
                `expected generation ${parsed.expectedGeneration}, found ${child.relation.generation}`,
              );
            }
          }
          return result(
            sparkSideThreadHandoffResultSchema.parse({
              parentInvocationId: replay.invocationId,
              acceptedAt: replay.createdAt,
              snapshot: await projectSparkDaemonSideThreadSnapshot(options, parent, child, {}),
            }),
            replay.invocationId,
          );
        }

        assertGeneration(child, parsed.expectedGeneration);
        assertSideThreadIdle(store, child.sessionId);
        const exchanges = await loadSparkDaemonSideThreadExchanges(options, child);
        const head = exchanges.at(-1)?.id;
        if (!head || head !== parsed.expectedHeadExchangeId) {
          throw sideThreadError(
            "side_thread_head_conflict",
            `expected side-thread head ${parsed.expectedHeadExchangeId}, found ${head ?? "none"}`,
          );
        }
        const prompt = renderSparkDaemonSideThreadHandoffPrompt(
          exchanges,
          parsed.kind,
          parsed.instructions,
        );
        if (Buffer.byteLength(prompt) > MAX_HANDOFF_BYTES) {
          throw sideThreadError(
            "side_thread_handoff_too_large",
            `side-thread handoff exceeds ${MAX_HANDOFF_BYTES} bytes`,
          );
        }
        const submitted = await executeSparkDaemonSessionControl(options, {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: parent.sessionId,
          idempotencyKey,
          payload: {
            sessionId: parent.sessionId,
            prompt,
            idempotencyKey,
            messageMetadata: handoffMessageMetadata(parent, child, parsed),
          },
        });
        const acceptedAt = requiredString(submitted.result.acceptedAt, "acceptedAt");
        child = await resetSideThreadGeneration(
          options,
          parent,
          child,
          parsed.expectedGeneration,
          child.relation!.mode,
        );
        return result(
          sparkSideThreadHandoffResultSchema.parse({
            parentInvocationId: submitted.invocationId,
            acceptedAt,
            snapshot: await projectSparkDaemonSideThreadSnapshot(options, parent, child, {}),
          }),
          submitted.invocationId,
        );
      });
    }
  }
}

async function requireParent(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSideThreadControlRequest,
  parentSessionId: string,
): Promise<SparkSessionRegistryRecord> {
  if (request.scope && request.scope !== "any") {
    try {
      await executeSparkDaemonSessionControl(options, {
        kind: "session.get.request",
        scope: request.scope,
        workspaceId: request.workspaceId,
        workspaceBindingId: request.workspaceBindingId,
        sessionId: parentSessionId,
        payload: { sessionId: parentSessionId },
      });
    } catch (error) {
      if (error instanceof SparkSessionRegistryError && error.code === "session_not_found") {
        throw sideThreadError(
          "side_thread_parent_not_found",
          `unknown side-thread parent: ${parentSessionId}`,
        );
      }
      if (error instanceof SparkSessionRegistryError && error.code === "session_scope_mismatch") {
        throw sideThreadError(
          "side_thread_scope_mismatch",
          `side-thread parent ${parentSessionId} is outside the command scope`,
        );
      }
      throw error;
    }
  }
  const parent = await requireRegistry(options).get(parentSessionId);
  if (!parent) {
    throw sideThreadError(
      "side_thread_parent_not_found",
      `unknown side-thread parent: ${parentSessionId}`,
    );
  }
  if (parent.relation?.kind === "side_thread") {
    throw sideThreadError(
      "side_thread_nesting_forbidden",
      `side threads cannot be nested under ${parentSessionId}`,
    );
  }
  if (parent.status === "archived") {
    throw sideThreadError(
      "side_thread_parent_archived",
      `side-thread parent is archived: ${parentSessionId}`,
    );
  }
  return parent;
}

async function findSideThread(
  registry: DaemonSessionRegistry | undefined,
  parentSessionId: string,
): Promise<SparkSessionRegistryRecord | undefined> {
  const sessions = await requireRegistryValue(registry).list({
    includeArchived: true,
    includeSideThreads: true,
  });
  return sessions.find(
    (session) =>
      session.relation?.kind === "side_thread" &&
      session.relation.parentSessionId === parentSessionId,
  );
}

async function requireSideThread(
  registry: DaemonSessionRegistry | undefined,
  parentSessionId: string,
): Promise<SparkSessionRegistryRecord> {
  const child = await findSideThread(registry, parentSessionId);
  if (!child || child.status === "archived") {
    throw sideThreadError(
      "side_thread_not_found",
      `no active side thread exists for parent ${parentSessionId}`,
    );
  }
  return child;
}

async function resetSideThreadGeneration(
  options: SparkDaemonSessionControlOptions,
  parent: SparkSessionRegistryRecord,
  child: SparkSessionRegistryRecord,
  expectedGeneration: number,
  mode: SparkSideThreadMode,
): Promise<SparkSessionRegistryRecord> {
  assertGeneration(child, expectedGeneration);
  const store = new SparkInvocationStore(options.db);
  const pending = store.listPendingForSession(child.sessionId);
  let runningCancellationRequested = false;
  let queuedCancelled = false;
  for (const invocation of pending) {
    const outcome = store.requestCancellation(
      invocation.invocationId,
      "Side Thread reset requested.",
    );
    if (outcome === "requested") runningCancellationRequested = true;
    if (outcome === "cancelled") queuedCancelled = true;
  }
  if (runningCancellationRequested) {
    throw sideThreadError(
      "side_thread_busy",
      "the running side-thread turn is cancelling; retry reset after it settles",
    );
  }
  if (queuedCancelled) await requireRegistry(options).recordTurnSettled(child.sessionId);
  const sessionPath = await createSparkDaemonSideThreadTranscript(
    options,
    parent,
    child.sessionId,
    mode,
    expectedGeneration + 1,
  );
  let reset: SparkSessionRegistryRecord;
  try {
    reset = await requireRegistry(options).resetSideThread({
      sessionId: child.sessionId,
      expectedGeneration,
      sessionPath,
      mode,
    });
  } catch (error) {
    await cleanupFailedSideThreadReset(
      options,
      parent,
      child.sessionId,
      sessionPath,
      expectedGeneration + 1,
    );
    throw error;
  }
  await pruneSparkDaemonSideThreadRetiredGenerations(options, parent, reset);
  return reset;
}

async function cleanupFailedSideThreadReset(
  options: SparkDaemonSessionControlOptions,
  parent: SparkSessionRegistryRecord,
  sessionId: string,
  sessionPath: string,
  generation: number,
): Promise<void> {
  try {
    const current = await requireRegistry(options).get(sessionId);
    if (current?.sessionPath === sessionPath) return;
    await removeUnreferencedSparkDaemonSideThreadTranscript(
      options,
      parent,
      sessionId,
      sessionPath,
      generation,
    );
  } catch {
    // Preserve the caller's reset error; a later maintenance pass can recover an orphan safely.
  }
}

function assertSideThreadIdle(store: SparkInvocationStore, sessionId: string): void {
  const pending = store.listPendingForSession(sessionId);
  if (pending.length === 0) return;
  throw sideThreadError(
    "side_thread_busy",
    `side thread ${sessionId} already has pending invocation ${pending[0]!.invocationId}`,
  );
}

function assertGeneration(child: SparkSessionRegistryRecord, expectedGeneration: number): void {
  const relation = requireSideThreadRelation(child);
  if (relation.generation === expectedGeneration) return;
  throw sideThreadError(
    "side_thread_generation_conflict",
    `expected generation ${expectedGeneration}, found ${relation.generation}`,
  );
}

function requireSideThreadRelation(child: SparkSessionRegistryRecord) {
  if (child.relation?.kind !== "side_thread") {
    throw sideThreadError("side_thread_not_found", `not a side thread: ${child.sessionId}`);
  }
  return child.relation;
}

async function assertAvailableModel(
  modelControl: SparkDaemonModelControl | undefined,
  model: SparkModelRef,
): Promise<void> {
  if (!modelControl) {
    throw sideThreadError("side_thread_model_unavailable", "model control is unavailable");
  }
  const snapshot = await modelControl.snapshot();
  const entry = snapshot.providers
    .flatMap((provider) => provider.models)
    .find(
      (candidate) =>
        candidate.model.providerName === model.providerName &&
        candidate.model.modelId === model.modelId,
    );
  if (!entry?.available) {
    throw sideThreadError(
      "side_thread_model_unavailable",
      entry?.unavailableReason ?? `model is unavailable: ${model.providerName}/${model.modelId}`,
    );
  }
  await modelControl.prepareModel(entry.model);
}

function sideThreadMessageMetadata(
  parent: SparkSessionRegistryRecord,
  child: SparkSessionRegistryRecord,
) {
  const relation = requireSideThreadRelation(child);
  return {
    origin: {
      kind: "side_thread",
      host: "daemon",
      surface: "local",
      parentSessionId: parent.sessionId,
      generation: relation.generation,
    },
  };
}

function handoffMessageMetadata(
  parent: SparkSessionRegistryRecord,
  child: SparkSessionRegistryRecord,
  request: ReturnType<typeof sparkSideThreadHandoffRequestSchema.parse>,
) {
  return {
    origin: {
      kind: "side_thread_handoff",
      host: "daemon",
      surface: "local",
      sideThreadSessionId: child.sessionId,
    },
    sideThreadHandoff: {
      parentSessionId: parent.sessionId,
      sideThreadSessionId: child.sessionId,
      generation: request.expectedGeneration,
      headExchangeId: request.expectedHeadExchangeId,
      kind: request.kind,
      instructionsHash: hashValue(request.instructions ?? ""),
    },
  };
}

function assertSubmitReplay(
  invocation: SparkInvocationRecord,
  sessionId: string,
  prompt: string,
): void {
  const task = validateSparkDaemonTask(invocation.task);
  if (task.sessionId !== sessionId || task.prompt !== prompt) {
    throw sideThreadError(
      "side_thread_idempotency_conflict",
      `side-thread idempotency conflict: ${invocation.invocationId}`,
    );
  }
}

function assertHandoffReplay(
  invocation: SparkInvocationRecord,
  childSessionId: string,
  request: ReturnType<typeof sparkSideThreadHandoffRequestSchema.parse>,
): void {
  const task = validateSparkDaemonTask(invocation.task);
  const handoff = recordValue(task.messageMetadata?.sideThreadHandoff);
  if (
    task.sessionId !== request.parentSessionId ||
    handoff?.sideThreadSessionId !== childSessionId ||
    handoff.generation !== request.expectedGeneration ||
    handoff.headExchangeId !== request.expectedHeadExchangeId ||
    handoff.kind !== request.kind ||
    handoff.instructionsHash !== hashValue(request.instructions ?? "")
  ) {
    throw sideThreadError(
      "side_thread_idempotency_conflict",
      `side-thread handoff idempotency conflict: ${invocation.invocationId}`,
    );
  }
}

function sideThreadSessionId(parentSessionId: string): string {
  return `side_${hashValue(parentSessionId).slice(0, 24)}`;
}

function sideThreadSubmitIdempotencyKey(
  parentSessionId: string,
  generation: number,
  key: string,
): string {
  return `side-thread:submit:${hashValue(parentSessionId)}:${generation}:${hashValue(key)}`;
}

function sideThreadHandoffIdempotencyKey(
  request: ReturnType<typeof sparkSideThreadHandoffRequestSchema.parse>,
): string {
  return `side-thread:handoff:${hashValue(
    JSON.stringify({
      parentSessionId: request.parentSessionId,
      generation: request.expectedGeneration,
      headExchangeId: request.expectedHeadExchangeId,
      kind: request.kind,
      instructions: request.instructions ?? "",
    }),
  )}`;
}

function requireRegistry(options: SparkDaemonSessionControlOptions): DaemonSessionRegistry {
  return requireRegistryValue(options.sessionRegistry);
}

function requireRegistryValue(registry: DaemonSessionRegistry | undefined): DaemonSessionRegistry {
  if (!registry) throw new Error("Spark daemon session registry is not available.");
  return registry;
}

async function serializeSideThreadMutation<T>(
  parentSessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sideThreadMutationTails.get(parentSessionId) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  sideThreadMutationTails.set(parentSessionId, tail);
  try {
    return await result;
  } finally {
    if (sideThreadMutationTails.get(parentSessionId) === tail) {
      sideThreadMutationTails.delete(parentSessionId);
    }
  }
}

function result(
  value: Record<string, unknown>,
  invocationId?: string,
): SparkDaemonSideThreadControlResult {
  return {
    result: structuredClone(value) as Record<string, SparkProtocolJsonValue>,
    ...(invocationId ? { invocationId } : {}),
  };
}

function sideThreadError(code: SparkSideThreadErrorCode, message: string) {
  return new SparkSessionRegistryError(code, message);
}

function requiredString(value: unknown, field: string): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error(`Side Thread admission result is missing ${field}.`);
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
