import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { SparkModelRef } from "@zendev-lab/spark-protocol";
import { executeSparkDaemonModelChannelPublicControl } from "./model-channel-control.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";

const model: SparkModelRef = {
  providerName: "fixture",
  modelId: "fixture-model",
};

test("runtime model control rejects sessions outside the explicit route scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-model-session-route-"));
  try {
    const registry = createDaemonSessionRegistry(root, {
      daemonId: "daemon-a",
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "workspace-a" || workspaceId === "workspace-b" ? root : undefined,
    });
    const sessionA = await registry.create({
      sessionId: "session-a",
      title: "Workspace A",
      scope: { kind: "workspace", workspaceId: "workspace-a" },
      workspaceId: "workspace-a",
    });
    const daemonSession = await registry.create({
      sessionId: "session-daemon",
      title: "Daemon",
      scope: { kind: "daemon" },
    });

    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "session.model.set.request",
          scope: "workspace",
          workspaceId: "workspace-b",
          payload: { sessionId: sessionA.sessionId, model },
        },
      ),
      /does not belong to the routed runtime owner/u,
    );
    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "model.catalog.request",
          scope: "daemon",
          payload: { sessionId: sessionA.sessionId },
        },
      ),
      /does not belong to the routed runtime owner/u,
    );
    await assert.rejects(
      executeSparkDaemonModelChannelPublicControl(
        { sessionRegistry: registry },
        {
          kind: "session.thinking.set.request",
          scope: "workspace",
          workspaceId: "workspace-a",
          payload: { sessionId: daemonSession.sessionId, thinkingLevel: "high" },
        },
      ),
      /does not belong to the routed runtime owner/u,
    );

    assert.equal((await registry.get(sessionA.sessionId))?.model, undefined);
    assert.equal((await registry.get(daemonSession.sessionId))?.thinkingLevel, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
