import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { SparkSessionStore } from "@zendev-lab/spark-host/session-store";
import {
  runtimeCommandResultPayloadSchema,
  sparkSideThreadHandoffResultSchema,
  sparkSideThreadSnapshotSchema,
  sparkSideThreadSubmitResultSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import { executeSparkDaemonSideThreadControl } from "./side-thread-control.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon Side Thread control", () => {
  it("seeds only stable parent context while projecting an empty child transcript", async () => {
    const fixture = await createFixture();
    try {
      const ensured = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            kind: "side-thread.ensure.request",
            payload: { parentSessionId: fixture.parentSessionId, mode: "contextual" },
          })
        ).result,
      );

      expect(ensured).toMatchObject({
        parentSessionId: fixture.parentSessionId,
        generation: 1,
        mode: "contextual",
        status: "idle",
        exchanges: [],
      });
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const childRecord = await fixture.store.load(child!.sessionPath!);
      expect(
        childRecord.entries
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message.content),
      ).toEqual(["stable parent question", "stable parent answer"]);
      expect(childRecord.entries.at(-1)).toMatchObject({
        type: "custom",
        customType: "spark.side-thread.seed-boundary",
      });
      expect(childRecord.header).toMatchObject({
        visibility: "internal",
        purpose: "side_thread",
      });

      expect(await fixture.sessionRegistry.list()).toHaveLength(1);
      expect(await fixture.sessionRegistry.list({ includeSideThreads: true })).toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: ensured.sessionId })]),
      );
      const ordinaryList = await executeSparkDaemonSessionControl(fixture.options, {
        kind: "session.list.request",
        scope: "any",
        payload: { includeSideThreads: true },
      });
      expect(ordinaryList.result.sessions).toEqual([
        expect.objectContaining({ sessionId: fixture.parentSessionId }),
      ]);
      await expect(
        executeSparkDaemonSessionControl(fixture.options, {
          kind: "session.get.request",
          scope: "any",
          sessionId: ensured.sessionId,
          payload: { sessionId: ensured.sessionId },
        }),
      ).rejects.toMatchObject({ code: "side_thread_not_found" });
      await expect(
        executeSparkDaemonSessionControl(fixture.options, {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId: ensured.sessionId,
          payload: { sessionId: ensured.sessionId },
        }),
      ).rejects.toMatchObject({ code: "side_thread_not_found" });

      childRecord.entries = childRecord.entries.filter(
        (entry) =>
          entry.type !== "custom" || entry.customType !== "spark.side-thread.seed-boundary",
      );
      await fixture.store.save(childRecord);
      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          kind: "side-thread.snapshot.request",
          payload: { parentSessionId: fixture.parentSessionId },
        }),
      ).rejects.toMatchObject({ code: "side_thread_transcript_invalid" });

      const reset = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            kind: "side-thread.reset.request",
            payload: {
              parentSessionId: fixture.parentSessionId,
              expectedGeneration: 1,
              mode: "tangent",
            },
          })
        ).result,
      );
      expect(reset).toMatchObject({ generation: 2, mode: "tangent", exchanges: [] });
      const resetChild = await fixture.sessionRegistry.get(reset.sessionId);
      expect(resetChild!.sessionPath).not.toBe(child!.sessionPath);
      const resetRecord = await fixture.store.load(resetChild!.sessionPath!);
      expect(resetRecord.entries.filter((entry) => entry.type === "message")).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("admits child turns only through the generation-aware idempotent control surface", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const request = {
        kind: "side-thread.submit.request" as const,
        payload: {
          parentSessionId: fixture.parentSessionId,
          expectedGeneration: ensured.generation,
          prompt: "inspect the scheduler without mutating it",
          idempotencyKey: "side-submit-1",
        },
      };
      const submitted = sparkSideThreadSubmitResultSchema.parse(
        (await executeSparkDaemonSideThreadControl(fixture.options, request)).result,
      );
      const replayed = sparkSideThreadSubmitResultSchema.parse(
        (await executeSparkDaemonSideThreadControl(fixture.options, request)).result,
      );
      expect(replayed.invocationId).toBe(submitted.invocationId);
      expect(submitted.snapshot).toMatchObject({ status: "queued", generation: 1 });
      const invocation = new SparkInvocationStore(fixture.db).require(submitted.invocationId);
      expect(invocation.task).toMatchObject({
        type: "session.run",
        sessionId: ensured.sessionId,
        prompt: "inspect the scheduler without mutating it",
        messageMetadata: {
          origin: {
            kind: "side_thread",
            parentSessionId: fixture.parentSessionId,
            generation: 1,
          },
        },
      });

      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          ...request,
          payload: { ...request.payload, prompt: "a conflicting replay" },
        }),
      ).rejects.toMatchObject({ code: "side_thread_idempotency_conflict" });
      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          ...request,
          payload: { ...request.payload, idempotencyKey: "side-submit-2" },
        }),
      ).rejects.toMatchObject({ code: "side_thread_busy" });
      await expect(
        executeSparkDaemonSessionControl(fixture.options, {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: ensured.sessionId,
          payload: { sessionId: ensured.sessionId, prompt: "bypass the Side Thread API" },
        }),
      ).rejects.toMatchObject({ code: "side_thread_direct_submit_forbidden" });
      for (const controlRequest of [
        {
          kind: "turn.status.request" as const,
          payload: { invocationId: submitted.invocationId },
          expectedCode: "side_thread_not_found",
        },
        {
          kind: "turn.stream.subscribe" as const,
          payload: { invocationId: submitted.invocationId },
          expectedCode: "side_thread_not_found",
        },
        {
          kind: "turn.cancel.request" as const,
          payload: { invocationId: submitted.invocationId },
          expectedCode: "side_thread_mutation_forbidden",
        },
      ]) {
        await expect(
          executeSparkDaemonSessionControl(fixture.options, {
            kind: controlRequest.kind,
            scope: "any",
            payload: controlRequest.payload,
          }),
        ).rejects.toMatchObject({ code: controlRequest.expectedCode });
      }
      expect(new SparkInvocationStore(fixture.db).require(submitted.invocationId).status).toBe(
        "queued",
      );

      const reset = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            kind: "side-thread.reset.request",
            payload: {
              parentSessionId: fixture.parentSessionId,
              expectedGeneration: 1,
              mode: "contextual",
            },
          })
        ).result,
      );
      expect(reset).toMatchObject({ generation: 2, status: "idle" });
      expect(new SparkInvocationStore(fixture.db).require(submitted.invocationId).status).toBe(
        "cancelled",
      );
      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          kind: "side-thread.reset.request",
          payload: {
            parentSessionId: fixture.parentSessionId,
            expectedGeneration: 1,
            mode: "contextual",
          },
        }),
      ).rejects.toMatchObject({ code: "side_thread_generation_conflict" });
    } finally {
      fixture.close();
    }
  });

  it("hands off only child exchanges to the parent before advancing the generation", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const childRecord = await fixture.store.load(child!.sessionPath!);
      fixture.store.appendMessage(childRecord, {
        role: "user",
        content: "what invariant protects delivery retries?",
      });
      const headExchangeId = fixture.store.appendMessage(childRecord, {
        role: "assistant",
        content: "retry only work proven not_sent",
        stopReason: "stop",
      });
      await fixture.store.save(childRecord);

      const before = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            kind: "side-thread.snapshot.request",
            payload: { parentSessionId: fixture.parentSessionId },
          })
        ).result,
      );
      expect(before.exchanges).toEqual([
        expect.objectContaining({
          id: headExchangeId,
          user: "what invariant protects delivery retries?",
          assistant: "retry only work proven not_sent",
        }),
      ]);
      expect(JSON.stringify(before)).not.toContain("stable parent question");

      const request = {
        kind: "side-thread.handoff.request" as const,
        payload: {
          parentSessionId: fixture.parentSessionId,
          expectedGeneration: 1,
          expectedHeadExchangeId: headExchangeId,
          kind: "full" as const,
          instructions: "Use this as a review hint.",
          idempotencyKey: "handoff-1",
        },
      };
      const handedOff = sparkSideThreadHandoffResultSchema.parse(
        (await executeSparkDaemonSideThreadControl(fixture.options, request)).result,
      );
      expect(handedOff.snapshot).toMatchObject({ generation: 2, exchanges: [] });
      const parentInvocation = new SparkInvocationStore(fixture.db).require(
        handedOff.parentInvocationId,
      );
      expect(parentInvocation.task).toMatchObject({
        sessionId: fixture.parentSessionId,
        messageMetadata: {
          sideThreadHandoff: {
            sideThreadSessionId: ensured.sessionId,
            generation: 1,
            headExchangeId,
            kind: "full",
          },
        },
      });
      expect(JSON.stringify(parentInvocation.task)).toContain("retry only work proven not_sent");
      expect(JSON.stringify(parentInvocation.task)).not.toContain("stable parent question");

      const replay = sparkSideThreadHandoffResultSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            ...request,
            payload: { ...request.payload, idempotencyKey: "handoff-retry-after-lost-response" },
          })
        ).result,
      );
      expect(replay.parentInvocationId).toBe(handedOff.parentInvocationId);
      expect(replay.snapshot.generation).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("bounds oversized exchanges and pending prompts below the runtime result limit", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const record = await fixture.store.load(child!.sessionPath!);
      fixture.store.appendMessage(record, {
        role: "user",
        content: "question-".repeat(2_000),
      });
      fixture.store.appendMessage(record, {
        role: "assistant",
        content: "结论".repeat(30_000),
        stopReason: "stop",
      });
      await fixture.store.save(record);

      const submitted = sparkSideThreadSubmitResultSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(fixture.options, {
            kind: "side-thread.submit.request",
            payload: {
              parentSessionId: fixture.parentSessionId,
              expectedGeneration: 1,
              prompt: "pending-".repeat(20_000),
              idempotencyKey: "oversized-snapshot",
            },
          })
        ).result,
      );

      expect(submitted.snapshot).toMatchObject({ projectionTruncated: true });
      expect(submitted.snapshot.exchanges[0]).toMatchObject({
        userTruncated: true,
        assistantTruncated: true,
      });
      expect(submitted.snapshot.pendingTurns[0]).toMatchObject({ promptTruncated: true });
      const runtimePayload = runtimeCommandResultPayloadSchema.parse({
        status: "succeeded",
        result: submitted.snapshot,
        completedAt: "2026-07-22T00:00:00.000Z",
      });
      expect(Buffer.byteLength(JSON.stringify(runtimePayload))).toBeLessThan(64 * 1024);
    } finally {
      fixture.close();
    }
  });

  it("uses a rebuildable transcript index and safely recovers stale or corrupt sidecars", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const record = await fixture.store.load(child!.sessionPath!);
      fixture.store.appendMessage(record, { role: "user", content: "first indexed question" });
      fixture.store.appendMessage(record, {
        role: "assistant",
        content: "first indexed answer",
        stopReason: "stop",
      });
      await fixture.store.save(record);

      const first = await sideThreadSnapshot(fixture);
      const indexPath = `${child!.sessionPath}.side-thread-index.json`;
      expect(first.exchanges).toHaveLength(1);
      expect(existsSync(indexPath)).toBe(true);

      const load = vi.spyOn(SparkSessionStore.prototype, "load");
      load.mockClear();
      await expect(sideThreadSnapshot(fixture)).resolves.toMatchObject({
        exchanges: [expect.objectContaining({ assistant: "first indexed answer" })],
      });
      expect(load).not.toHaveBeenCalled();

      writeFileSync(indexPath, "{not-json", "utf8");
      await expect(sideThreadSnapshot(fixture)).resolves.toMatchObject({
        exchanges: [expect.objectContaining({ assistant: "first indexed answer" })],
      });
      expect(load).toHaveBeenCalled();

      const updated = await fixture.store.load(child!.sessionPath!);
      fixture.store.appendMessage(updated, { role: "user", content: "second indexed question" });
      fixture.store.appendMessage(updated, {
        role: "assistant",
        content: "second indexed answer",
        stopReason: "stop",
      });
      await fixture.store.save(updated);
      await expect(sideThreadSnapshot(fixture)).resolves.toMatchObject({
        exchanges: [
          expect.objectContaining({ assistant: "first indexed answer" }),
          expect.objectContaining({ assistant: "second indexed answer" }),
        ],
      });
      load.mockRestore();
    } finally {
      fixture.close();
    }
  });

  it("rebuilds a legacy generation-less transcript after a daemon upgrade", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const record = await fixture.store.load(child!.sessionPath!);
      const boundary = record.entries.find(
        (entry) =>
          entry.type === "custom" && entry.customType === "spark.side-thread.seed-boundary",
      );
      expect(boundary).toBeDefined();
      if (boundary?.type !== "custom" || !boundary.data || typeof boundary.data !== "object") {
        throw new Error("expected a Side Thread seed boundary");
      }
      delete (boundary.data as Record<string, unknown>).generation;
      fixture.store.appendMessage(record, { role: "user", content: "legacy question" });
      fixture.store.appendMessage(record, {
        role: "assistant",
        content: "legacy answer",
        stopReason: "stop",
      });
      await fixture.store.save(record);

      await expect(sideThreadSnapshot(fixture)).resolves.toMatchObject({
        generation: 1,
        exchanges: [expect.objectContaining({ assistant: "legacy answer" })],
      });
      expect(
        JSON.parse(readFileSync(`${child!.sessionPath}.side-thread-index.json`, "utf8")),
      ).toMatchObject({ identity: { generation: 1 } });

      const mismatched = await fixture.store.load(child!.sessionPath!);
      const mismatchedBoundary = mismatched.entries.find(
        (entry) =>
          entry.type === "custom" && entry.customType === "spark.side-thread.seed-boundary",
      );
      if (
        mismatchedBoundary?.type !== "custom" ||
        !mismatchedBoundary.data ||
        typeof mismatchedBoundary.data !== "object"
      ) {
        throw new Error("expected a Side Thread seed boundary");
      }
      (mismatchedBoundary.data as Record<string, unknown>).generation = 2;
      await fixture.store.save(mismatched);
      await expect(sideThreadSnapshot(fixture)).rejects.toMatchObject({
        code: "side_thread_transcript_invalid",
      });
    } finally {
      fixture.close();
    }
  });

  it("retains the current generation plus two verified retired transcript generations", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const paths = [(await fixture.sessionRegistry.get(ensured.sessionId))!.sessionPath!];
      for (let generation = 1; generation <= 4; generation += 1) {
        const reset = await resetSideThread(fixture, generation);
        paths.push((await fixture.sessionRegistry.get(reset.sessionId))!.sessionPath!);
      }
      expect(paths.map(existsSync)).toEqual([false, false, true, true, true]);
      expect(paths.slice(0, 2).map((path) => existsSync(`${path}.side-thread-index.json`))).toEqual(
        [false, false],
      );
    } finally {
      fixture.close();
    }
  });

  it("removes an unreferenced new transcript when registry reset persistence fails", async () => {
    const fixture = await createFixture();
    try {
      const ensured = await ensure(fixture);
      const child = await fixture.sessionRegistry.get(ensured.sessionId);
      const oldPath = child!.sessionPath!;
      vi.spyOn(fixture.sessionRegistry, "resetSideThread").mockRejectedValueOnce(
        new Error("injected registry persistence failure"),
      );

      await expect(resetSideThread(fixture, 1)).rejects.toThrow(
        "injected registry persistence failure",
      );
      const transcriptNames = readdirSync(dirname(oldPath))
        .filter((name) => name.endsWith(`_${ensured.sessionId}.jsonl`))
        .sort();
      expect(transcriptNames).toEqual([basename(oldPath)]);
      expect(existsSync(oldPath)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("validates model overrides and inherits parent settings after clearing them", async () => {
    const fixture = await createFixture();
    const effectiveModel = vi.fn(async (sessionId?: string) =>
      sessionId === fixture.parentSessionId
        ? { providerName: "provider-a", modelId: "parent-model" }
        : { providerName: "provider-a", modelId: "child-model" },
    );
    const prepareModel = vi.fn(async () => undefined);
    const modelControl = {
      snapshot: vi.fn(async () => ({
        providers: [
          {
            providerName: "provider-a",
            models: [
              {
                model: { providerName: "provider-a", modelId: "child-model" },
                available: true,
              },
            ],
          },
        ],
      })),
      effectiveModel,
      effectiveThinkingLevel: vi.fn(async () => "medium" as const),
      prepareModel,
    } as unknown as SparkDaemonModelControl;
    const options = { ...fixture.options, modelControl };
    try {
      const ensured = await ensure({ ...fixture, options });
      const configured = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(options, {
            kind: "side-thread.configure.request",
            payload: {
              parentSessionId: fixture.parentSessionId,
              expectedGeneration: 1,
              modelOverride: { providerName: "provider-a", modelId: "child-model" },
              thinkingOverride: "high",
            },
          })
        ).result,
      );
      expect(configured).toMatchObject({
        sessionId: ensured.sessionId,
        modelOverride: { providerName: "provider-a", modelId: "child-model" },
        thinkingOverride: "high",
      });
      expect(prepareModel).toHaveBeenCalledWith({
        providerName: "provider-a",
        modelId: "child-model",
      });

      const inherited = sparkSideThreadSnapshotSchema.parse(
        (
          await executeSparkDaemonSideThreadControl(options, {
            kind: "side-thread.configure.request",
            payload: {
              parentSessionId: fixture.parentSessionId,
              expectedGeneration: 1,
              modelOverride: null,
              thinkingOverride: null,
            },
          })
        ).result,
      );
      expect(inherited.modelOverride).toBeUndefined();
      expect(inherited.thinkingOverride).toBeUndefined();
      expect(effectiveModel).toHaveBeenLastCalledWith(fixture.parentSessionId);
    } finally {
      fixture.close();
    }
  });

  it("normalizes parent ownership failures to the Side Thread error contract", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          kind: "side-thread.ensure.request",
          scope: "workspace",
          workspaceId: "foreign-workspace",
          payload: { parentSessionId: fixture.parentSessionId },
        }),
      ).rejects.toMatchObject({ code: "side_thread_scope_mismatch" });
      await expect(
        executeSparkDaemonSideThreadControl(fixture.options, {
          kind: "side-thread.ensure.request",
          scope: "daemon",
          payload: { parentSessionId: "missing-parent" },
        }),
      ).rejects.toMatchObject({ code: "side_thread_parent_not_found" });
    } finally {
      fixture.close();
    }
  });
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "spark-side-thread-control-"));
  roots.push(root);
  const db = openMemoryDatabase();
  migrateSparkDaemonDatabase(db);
  const paths = {
    ...resolveSparkPaths({ app: "daemon", env: { HOME: root } }),
    piAgentDir: join(root, "agent"),
  };
  const sessionsRoot = join(paths.piAgentDir, "sessions");
  const store = new SparkSessionStore({ cwd: root, sessionsRoot });
  const parentSessionId = "parent-session";
  const parentRecord = store.createSession({ id: parentSessionId });
  store.appendMessage(parentRecord, { role: "user", content: "stable parent question" });
  store.appendMessage(parentRecord, {
    role: "assistant",
    content: "stable parent answer",
    stopReason: "stop",
  });
  store.appendMessage(parentRecord, { role: "user", content: "unfinished parent question" });
  store.appendMessage(parentRecord, {
    role: "assistant",
    content: "failed parent answer",
    stopReason: "error",
  });
  await store.save(parentRecord);
  const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
    daemonId: "side-thread-test",
    daemonCwd: root,
  });
  await sessionRegistry.create({ sessionId: parentSessionId, scope: { kind: "daemon" } });
  await sessionRegistry.recordRun({ sessionId: parentSessionId, sessionPath: parentRecord.path });
  const options = {
    paths,
    db,
    sessionRegistry,
    actor: "spark-daemon-local-rpc" as const,
  };
  return {
    root,
    db,
    paths,
    store,
    parentSessionId,
    sessionRegistry,
    options,
    close: () => db.close(),
  };
}

async function ensure(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return sparkSideThreadSnapshotSchema.parse(
    (
      await executeSparkDaemonSideThreadControl(fixture.options, {
        kind: "side-thread.ensure.request",
        payload: { parentSessionId: fixture.parentSessionId, mode: "contextual" },
      })
    ).result,
  );
}

async function sideThreadSnapshot(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return sparkSideThreadSnapshotSchema.parse(
    (
      await executeSparkDaemonSideThreadControl(fixture.options, {
        kind: "side-thread.snapshot.request",
        payload: { parentSessionId: fixture.parentSessionId },
      })
    ).result,
  );
}

async function resetSideThread(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  expectedGeneration: number,
) {
  return sparkSideThreadSnapshotSchema.parse(
    (
      await executeSparkDaemonSideThreadControl(fixture.options, {
        kind: "side-thread.reset.request",
        payload: {
          parentSessionId: fixture.parentSessionId,
          expectedGeneration,
          mode: "tangent",
        },
      })
    ).result,
  );
}
