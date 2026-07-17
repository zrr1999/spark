import { join } from "node:path";

import { resolveSparkPaths } from "@zendev-lab/spark-system";

import { startLocalRpcServer } from "../../apps/spark-daemon/src/local-rpc.ts";
import { createDaemonSessionRegistry } from "../../apps/spark-daemon/src/session-registry.ts";
import { SparkInvocationStore } from "../../apps/spark-daemon/src/store/invocations.ts";
import { openSparkDaemonDatabase } from "../../apps/spark-daemon/src/store/schema.ts";

const root = process.argv[2];
if (!root) throw new Error("acceptance child requires a temporary root path");

const sparkHome = join(root, ".spark");
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
const db = openSparkDaemonDatabase(paths);
const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
  daemonId: "cockpit-acceptance-daemon",
  daemonCwd: root,
});
const sessionId = "sess_cockpit_acceptance";

await sessionRegistry.create({
  sessionId,
  workspaceId: "ws_cockpit_acceptance",
  scope: { kind: "workspace", workspaceId: "ws_cockpit_acceptance" },
  cwd: root,
  title: "Cockpit acceptance",
});
const server = await startLocalRpcServer({ paths, sparkHome, db, sessionRegistry });

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

process.send?.({ kind: "ready", runtimeDir: paths.runtimeDir, sessionId });

async function handleMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object") return;
  const action = (message as { action?: unknown }).action;
  if (action === "inspect") {
    process.send?.({ kind: "inspection", invocation: new SparkInvocationStore(db).list(10)[0] });
    return;
  }
  if (action === "stop") {
    await server.close();
    db.close();
    process.send?.({ kind: "stopped" });
    process.disconnect?.();
  }
}
