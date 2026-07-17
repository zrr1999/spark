import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { defaultSparkSessionRegistryRoot, SparkSessionRegistry } from "@zendev-lab/spark-session";
import { normalizeChannelExternalKey, parseSparkAssignment } from "@zendev-lab/spark-protocol";
import {
  ChannelRegistry,
  FakeChannelTransport,
  parseChannelsConfig,
} from "@zendev-lab/spark-channels";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

void test("assignment requires sessionId and preserves channel source", () => {
  const assignment = parseSparkAssignment({
    goal: "fix the flaky test",
    target: { sessionId: "sess_demo", workspaceId: "ws_1" },
    source: { kind: "channel", channel: "feishu", externalRef: "m1" },
  });
  assert.equal(assignment.target.sessionId, "sess_demo");
  assert.equal(assignment.source.kind, "channel");
  assert.equal(assignment.source.channel, "feishu");
  assert.throws(() => parseSparkAssignment({ goal: "x", target: {}, source: { kind: "cockpit" } }));
});

void test("session registry bind + channel inbound share one sessionId", async () => {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-assign-channels-"));
  roots.push(sparkHome);
  const registry = new SparkSessionRegistry({
    rootDir: defaultSparkSessionRegistryRoot(sparkHome),
  });
  const session = await registry.create({ workspaceId: "ws_a", title: "Shared" });
  const externalKey = normalizeChannelExternalKey("infoflow:user:alice");
  await registry.bind({ sessionId: session.sessionId, externalKey });

  const transport = new FakeChannelTransport();
  const delivered: string[] = [];
  let markDelivered: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  const channels = new ChannelRegistry({
    config: parseChannelsConfig({
      adapters: { infoflow: { type: "infoflow" } },
      routes: {},
      ingress: { enabled: true },
    }),
    createTransport: () => transport,
    onMessage: (message) => {
      void registry.resolveBinding({ externalKey: message.externalKey }).then((resolved) => {
        delivered.push(`${resolved.sessionId}:${message.text}`);
        markDelivered?.();
      });
    },
  });
  await channels.startAll();
  transport.emitInbound({ user_id: "alice", text: "from infoflow" });
  await delivery;
  await channels.stopAll();

  assert.deepEqual(delivered, [`${session.sessionId}:from infoflow`]);
});
