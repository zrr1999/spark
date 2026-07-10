import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSparkSessionRegistryRoot,
  SparkSessionRegistry,
  type CreateSparkSessionInput,
} from "@zendev-lab/spark-session";
import {
  createSerializedDaemonSessionRegistry,
  type DaemonSessionRegistry,
} from "./session-registry.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon session registry", () => {
  it("serializes channel resolution with concurrent create, bind, and archive mutations", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-session-owner-"));
    roots.push(sparkHome);
    const backing = new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(sparkHome),
    });
    let activeMutations = 0;
    let maximumActiveMutations = 0;
    const track = async <T>(operation: () => Promise<T>): Promise<T> => {
      activeMutations += 1;
      maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
      try {
        // Make an overlap observable if the daemon wrapper stops serializing.
        await delay(5);
        return await operation();
      } finally {
        activeMutations -= 1;
      }
    };
    const tracked: DaemonSessionRegistry = {
      create: (input) => track(() => backing.create(toBackingCreateInput(input))),
      list: (options) => backing.list(toBackingListOptions(options)),
      get: (sessionId) => backing.get(sessionId),
      bind: (input) => track(() => backing.bind(input)),
      unbind: (sessionId, externalKey) => track(() => backing.unbind(sessionId, externalKey)),
      archive: (sessionId) => track(() => backing.archive(sessionId)),
      setModel: (sessionId, model) => track(() => backing.setModel(sessionId, model)),
      recordTurnQueued: (sessionId, now) => track(() => backing.recordTurnQueued(sessionId, now)),
      recordTurnSettled: (sessionId, now) => track(() => backing.recordTurnSettled(sessionId, now)),
      recordRun: (input) => track(() => backing.recordRun(input)),
      resolveBinding: (input) => track(() => backing.resolveBinding(input)),
    };
    const registry = createSerializedDaemonSessionRegistry(tracked);

    await registry.create({ sessionId: "bind_target", workspaceId: "ws_ops" });
    await registry.create({ sessionId: "archive_target", workspaceId: "ws_ops" });

    const [channelSession] = await Promise.all([
      registry.resolveBinding({
        externalKey: "feishu:chat:oc_channel",
        onUnbound: "create",
        create: { workspaceId: "ws_channel", title: "Channel" },
      }),
      registry.create({ sessionId: "created_concurrently", workspaceId: "ws_created" }),
      registry.bind({
        sessionId: "bind_target",
        externalKey: "infoflow:user:u_bound",
      }),
      registry.archive("archive_target"),
    ]);

    expect(maximumActiveMutations).toBe(1);
    const persisted = await backing.list({ includeArchived: true });
    expect(persisted.map((session) => session.sessionId).sort()).toEqual(
      ["archive_target", "bind_target", channelSession.sessionId, "created_concurrently"].sort(),
    );
    expect(persisted.find((session) => session.sessionId === "bind_target")?.bindings).toEqual([
      expect.objectContaining({ externalKey: "infoflow:user:u_bound" }),
    ]);
    expect(persisted.find((session) => session.sessionId === "archive_target")?.status).toBe(
      "archived",
    );
    expect(channelSession.bindings).toEqual([
      expect.objectContaining({ externalKey: "feishu:chat:oc_channel" }),
    ]);
  });
});

function toBackingCreateInput(
  input: Parameters<DaemonSessionRegistry["create"]>[0],
): CreateSparkSessionInput {
  if (input.scope?.kind === "daemon") {
    const { scope: _scope, workspaceId: _workspaceId, ...rest } = input;
    return { ...rest, scope: { kind: "daemon", daemonId: "install-serialized-test" } };
  }
  if (input.scope?.kind === "workspace") {
    return { ...input, scope: input.scope, workspaceId: input.scope.workspaceId };
  }
  const workspaceId = "workspaceId" in input ? input.workspaceId : undefined;
  if (workspaceId) {
    return {
      workspaceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
  }
  throw new Error("test daemon session create requires a scope");
}

function toBackingListOptions(
  input: Parameters<DaemonSessionRegistry["list"]>[0],
): Parameters<SparkSessionRegistry["list"]>[0] {
  if (!input?.scope) return { includeArchived: input?.includeArchived };
  if (input.scope.kind === "workspace") {
    return { includeArchived: input.includeArchived, scope: input.scope };
  }
  return {
    includeArchived: input.includeArchived,
    scope: { kind: "daemon", daemonId: "install-serialized-test" },
  };
}
