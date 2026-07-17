import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDatabase } from "@zendev-lab/spark-db";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  sparkSessionSnapshotPageSchema,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("daemon session control admission", () => {
  it("converges concurrent lease claimants on one semantic turn despite dynamic model drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-admission-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "admission-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-race", scope: { kind: "daemon" } });

    const firstModel = deferred<{ providerName: string; modelId: string }>();
    let modelReadCount = 0;
    const effectiveModel = vi.fn(async () => {
      modelReadCount += 1;
      return modelReadCount === 1
        ? await firstModel.promise
        : { providerName: "provider-b", modelId: "model-b" };
    });
    const modelControl = {
      effectiveModel,
      prepareModel: vi.fn(async () => undefined),
      effectiveThinkingLevel: vi.fn(async () => undefined),
    } as unknown as SparkDaemonModelControl;
    const request = {
      kind: "turn.submit.request" as const,
      scope: "daemon" as const,
      sessionId: "session-race",
      idempotencyKey: "idem_10000000000000000000000000000000",
      payload: { sessionId: "session-race", prompt: "admit exactly once" },
    };
    const options = {
      paths,
      db,
      sessionRegistry,
      modelControl,
      actor: "spark-daemon-runtime-ws" as const,
    };

    try {
      const slowClaimant = executeSparkDaemonSessionControl(options, request);
      await vi.waitFor(() => expect(effectiveModel).toHaveBeenCalledTimes(1));
      const winningClaimant = await executeSparkDaemonSessionControl(options, request);
      firstModel.resolve({ providerName: "provider-a", modelId: "model-a" });
      const reclaimedClaimant = await slowClaimant;

      expect(reclaimedClaimant).toEqual(winningClaimant);
      expect(
        new SparkInvocationStore(db).findByIdempotencyKey(request.idempotencyKey),
      ).toMatchObject({
        invocationId: winningClaimant.invocationId,
        task: { model: "provider-b/model-b" },
      });
      expect(await sessionRegistry.get(request.sessionId)).toMatchObject({ status: "running" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks a byte-capped transcript with a strictly advancing exclusive cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-pages-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "pagination-test",
      daemonCwd: root,
    });
    const sessionId = "session-byte-capped-pages";
    const transcriptPath = join(root, "session.jsonl");
    const expectedIds = Array.from({ length: 18 }, (_, index) => `msg_${index}`);
    const entries = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-07-17T00:00:00.000Z",
        cwd: root,
      },
      ...expectedIds.map((id, index) => ({
        type: "message",
        id,
        parentId: index === 0 ? null : expectedIds[index - 1],
        timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, index + 1)).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${id}:${"large-message".repeat(500)}`,
        },
      })),
    ];
    writeFileSync(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    try {
      await sessionRegistry.create({ sessionId, scope: { kind: "daemon" } });
      await sessionRegistry.recordRun({ sessionId, sessionPath: transcriptPath });
      const requestPage = async (beforeMessageId?: string): Promise<SparkSessionSnapshotPage> => {
        const response = await executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
          {
            kind: "session.snapshot.request",
            scope: "any",
            sessionId,
            payload: {
              sessionId,
              messageLimit: 32,
              ...(beforeMessageId ? { beforeMessageId } : {}),
            },
          },
        );
        return sparkSessionSnapshotPageSchema.parse(response.result);
      };

      const chronologicalPages: string[][] = [];
      let cursor: string | undefined;
      let laterMessages = 0;
      let firstPageSize = 0;
      while (true) {
        const page = await requestPage(cursor);
        if (firstPageSize === 0) firstPageSize = page.history.loadedMessages;
        expect(page.history.totalMessages).toBe(expectedIds.length);
        expect(page.history.laterMessages).toBe(laterMessages);
        expect(page.snapshot.messages.length).toBeGreaterThan(0);
        chronologicalPages.unshift(page.snapshot.messages.map(({ id }) => id));
        laterMessages += page.history.loadedMessages;
        if (!page.history.hasEarlierMessages) break;
        expect(page.history.nextBeforeMessageId).toBe(page.snapshot.messages[0]?.id);
        expect(page.history.nextBeforeMessageId).not.toBe(cursor);
        cursor = page.history.nextBeforeMessageId;
      }

      expect(firstPageSize).toBeLessThan(expectedIds.length);
      expect(chronologicalPages.flat()).toEqual(expectedIds);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
