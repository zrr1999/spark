import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { createSparkDaemonOrpcClient } from "@zendev-lab/spark-system/daemon-local-rpc-orpc";
import { openSparkDaemonDatabase } from "../store/schema.js";
import { ensureLocalWorkspace } from "../store/workspaces.js";
import { startLocalRpcOrpcServer } from "./orpc-server.ts";

describe("local-rpc oRPC half-migration", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips live methods over daemon-orpc.sock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-orpc-live-"));
    dirs.push(dir);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: {
        SPARK_HOME: dir,
        XDG_RUNTIME_DIR: join(dir, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    ensureLocalWorkspace(db, { localPath: join(dir, "workspace") });

    const server = await startLocalRpcOrpcServer({
      paths,
      db,
      handlerOptions: {
        getLifecycle: () => ({ state: "running" as const }),
      },
    });
    closers.push(() => server.close());

    const handle = await createSparkDaemonOrpcClient({ paths });
    closers.push(async () => {
      handle.close();
    });

    await expect(handle.client.daemon.status({})).resolves.toMatchObject({
      lifecycle: { state: "running" },
    });
    await expect(handle.client.workspace.list({})).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ localPath: join(dir, "workspace") })],
    });
    await expect(handle.client.uplink.status({})).resolves.toMatchObject({
      origins: expect.any(Array),
    });
    await expect(handle.client.invocation.list({})).resolves.toMatchObject({
      invocations: expect.any(Array),
    });
  });
});
