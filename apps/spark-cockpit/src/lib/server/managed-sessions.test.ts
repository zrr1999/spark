import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkDaemonLocalRpcUnavailableError } from "@zendev-lab/spark-system";
import { describe, expect, it, vi } from "vitest";
import {
  archiveManagedSessionForCockpit,
  createManagedSessionForCockpit,
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
  listManagedSessionsForCockpit,
  type CockpitManagedSessionsClient,
} from "./managed-sessions";

const session: SparkSessionRegistryRecord = {
  sessionId: "sess_a",
  scope: { kind: "workspace", workspaceId: "ws_a" },
  workspaceId: "ws_a",
  title: "Alpha",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const snapshot = {
  version: 1 as const,
  sessionId: "sess_a",
  title: "Alpha",
  status: "idle" as const,
  messages: [
    {
      version: 1 as const,
      id: "msg_user",
      role: "user" as const,
      text: "Message from Infoflow",
      status: "done" as const,
      metadata: {},
    },
  ],
  tools: [],
  runs: [],
  tasks: [],
  artifacts: [],
  metadata: {},
};

describe("managed sessions for cockpit", () => {
  it("delegates reads to the daemon-owned session RPC", async () => {
    const client = daemonClient();

    const workspaceScope = {
      scope: { kind: "workspace" as const, workspaceId: "ws_a" },
      workspaceId: "ws_a",
    };
    await expect(listManagedSessionsForCockpit(workspaceScope, client)).resolves.toEqual([session]);
    await expect(getManagedSessionForCockpit("sess_a", client)).resolves.toEqual(session);
    await expect(getManagedSessionSnapshotForCockpit("sess_a", client)).resolves.toEqual(snapshot);

    expect(client.list).toHaveBeenCalledWith(workspaceScope);
    expect(client.get).toHaveBeenCalledWith("sess_a");
    expect(client.snapshot).toHaveBeenCalledWith("sess_a");
  });

  it("returns an empty read model when the daemon is unavailable or stale", async () => {
    const client = daemonClient();
    client.list.mockRejectedValueOnce(
      new SparkDaemonLocalRpcUnavailableError("restart or upgrade the daemon"),
    );

    await expect(listManagedSessionsForCockpit({}, client)).resolves.toEqual([]);
  });

  it("returns mutations only after the daemon acknowledges them", async () => {
    const archived = {
      ...session,
      status: "archived" as const,
      updatedAt: "2026-07-10T00:01:00.000Z",
    };
    const client = daemonClient({ archiveResult: archived });

    await expect(
      createManagedSessionForCockpit(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
          workspaceId: "ws_a",
          title: "Alpha",
        },
        client,
      ),
    ).resolves.toEqual(session);
    await expect(archiveManagedSessionForCockpit("sess_a", client)).resolves.toEqual(archived);

    expect(client.create).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "ws_a" },
      workspaceId: "ws_a",
      title: "Alpha",
    });
    expect(client.archive).toHaveBeenCalledWith("sess_a");
  });

  it("does not fabricate an offline fallback when the daemon rejects a mutation", async () => {
    const client = daemonClient();
    client.create.mockRejectedValueOnce(new Error("Spark daemon is offline"));

    await expect(
      createManagedSessionForCockpit(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
          workspaceId: "ws_a",
          title: "Alpha",
        },
        client,
      ),
    ).rejects.toThrow("Spark daemon is offline");
  });
});

function daemonClient(options: { archiveResult?: SparkSessionRegistryRecord } = {}) {
  return {
    list: vi.fn(async () => [session]),
    get: vi.fn(async () => session),
    snapshot: vi.fn(async () => snapshot),
    create: vi.fn(async () => session),
    archive: vi.fn(async () => options.archiveResult ?? session),
  } satisfies CockpitManagedSessionsClient;
}
