import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const productionPaths = [
  "apps/spark-cockpit/src/lib/server/conversation-control.ts",
  "apps/spark-cockpit/src/lib/server/managed-sessions.ts",
  "apps/spark-cockpit/src/lib/server/cockpit-runtime-session-client.ts",
] as const;
const modelChannelProductionPaths = [
  "apps/spark-cockpit/src/lib/server/model-control.ts",
  "apps/spark-cockpit/src/lib/server/channel-status.ts",
  "apps/spark-cockpit/src/lib/server/cockpit-runtime-model-channel-client.ts",
  "apps/spark-cockpit/src/routes/(console)/settings/models/+page.server.ts",
  "apps/spark-cockpit/src/routes/(console)/[workspaceId]/settings/channels/+page.server.ts",
] as const;

void test("Cockpit session and conversation production paths have no local daemon RPC fallback", async () => {
  const matches: Array<{ path: string; pattern: string }> = [];
  for (const path of productionPaths) {
    const source = await readFile(join(root, path), "utf8");
    for (const pattern of [
      "requestSparkDaemonLocalRpc",
      "daemon-local-rpc",
      "daemon.sock",
      "SparkDaemonLocalRpc",
    ]) {
      if (source.includes(pattern)) matches.push({ path, pattern });
    }
  }
  assert.deepEqual(matches, []);
});

void test("Cockpit model and channel production paths have no local daemon or config-file fallback", async () => {
  const matches: Array<{ path: string; pattern: string }> = [];
  for (const path of modelChannelProductionPaths) {
    const source = await readFile(join(root, path), "utf8");
    for (const pattern of [
      "requestSparkDaemonLocalRpc",
      "daemon-local-rpc",
      "daemon.sock",
      "SparkDaemonLocalRpc",
      "loadDaemonChannelsConfig",
      "channelConfigPath",
      "readFile(",
      "readFileSync(",
    ]) {
      if (source.includes(pattern)) matches.push({ path, pattern });
    }
  }
  assert.deepEqual(matches, []);
});
