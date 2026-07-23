import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sparkSideThreadSnapshotSchema } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
  isSparkDaemonSideThreadOrpcError,
} from "@zendev-lab/spark-daemon-client/orpc";
import { describe, expect, it, vi } from "vitest";

import { createDaemonSessionRegistry } from "../session-registry.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { startLocalRpcServer } from "./transport.ts";

describe("Side Thread local-rpc oRPC integration", () => {
  it("round-trips one durable child and does not replay a rejected mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-side-thread-orpc-live-"));
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
    const sparkHome = join(root, ".spark");
    const db = openSparkDaemonDatabase(paths);
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "side-thread-orpc-test",
      daemonCwd: root,
    });
    const ensureSideThread = vi.spyOn(sessionRegistry, "ensureSideThread");
    const resetSideThread = vi.spyOn(sessionRegistry, "resetSideThread");
    const server = await startLocalRpcServer({
      paths,
      sparkHome,
      db,
      sessionRegistry,
    });

    try {
      const handle = await createSparkDaemonOrpcClient({ paths });
      try {
        await invokeSparkDaemonOrpcLiveMethod(handle.client, "session.create", {
          sessionId: "parent-session",
          scope: { kind: "daemon" },
        });

        const ensured = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.ensure", {
            parentSessionId: "parent-session",
            mode: "contextual",
          }),
        );
        expect(ensured).toMatchObject({
          parentSessionId: "parent-session",
          generation: 1,
          mode: "contextual",
          status: "idle",
          exchanges: [],
        });

        const repeated = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.ensure", {
            parentSessionId: "parent-session",
            mode: "tangent",
          }),
        );
        expect(repeated.sessionId).toBe(ensured.sessionId);
        expect(repeated.mode).toBe("contextual");
        expect(ensureSideThread).toHaveBeenCalledTimes(1);

        const snapshot = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.snapshot", {
            parentSessionId: "parent-session",
          }),
        );
        expect(snapshot).toEqual(repeated);
        expect(await sessionRegistry.list()).toEqual([
          expect.objectContaining({ sessionId: "parent-session" }),
        ]);

        const generationConflict = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "side-thread.reset",
          {
            parentSessionId: "parent-session",
            expectedGeneration: 99,
            mode: "tangent",
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isSparkDaemonSideThreadOrpcError(generationConflict)).toBe(true);
        if (isSparkDaemonSideThreadOrpcError(generationConflict)) {
          expect(generationConflict.code).toBe("side_thread_generation_conflict");
        }

        resetSideThread.mockRejectedValueOnce(
          Object.assign(new Error("injected registry write failure"), {
            code: "legacy_internal_detail",
          }),
        );
        const unknownLegacyFailure = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "side-thread.reset",
          {
            parentSessionId: "parent-session",
            expectedGeneration: 1,
            mode: "tangent",
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isSparkDaemonSideThreadOrpcError(unknownLegacyFailure)).toBe(false);
        expect(unknownLegacyFailure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(String(unknownLegacyFailure)).not.toContain("legacy_internal_detail");
        expect(String(unknownLegacyFailure)).not.toContain("injected registry write failure");

        expect(resetSideThread).toHaveBeenCalledTimes(1);
        const afterFailure = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.snapshot", {
            parentSessionId: "parent-session",
          }),
        );
        expect(afterFailure).toEqual(snapshot);
      } finally {
        handle.close();
      }
    } finally {
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
