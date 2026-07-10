import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkDaemonLocalRpcUnavailableError } from "@zendev-lab/spark-system";
import { describe, expect, it, vi } from "vitest";
import {
  archiveManagedSessionForCockpit,
  createManagedSessionForCockpit,
  getManagedSessionForCockpit,
  listManagedSessionsForCockpit,
  type CockpitManagedSessionsClient,
} from "./managed-sessions";

const session: SparkSessionRegistryRecord = {
  sessionId: "sess_a",
  workspaceId: "ws_a",
  title: "Alpha",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

describe("managed sessions for cockpit", () => {
  it("delegates reads to the daemon-owned session RPC", async () => {
    const client = daemonClient();

    await expect(listManagedSessionsForCockpit({ workspaceId: "ws_a" }, client)).resolves.toEqual([
      session,
    ]);
    await expect(getManagedSessionForCockpit("sess_a", client)).resolves.toEqual(session);

    expect(client.list).toHaveBeenCalledWith({ workspaceId: "ws_a" });
    expect(client.get).toHaveBeenCalledWith("sess_a");
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
      createManagedSessionForCockpit({ workspaceId: "ws_a", title: "Alpha" }, client),
    ).resolves.toEqual(session);
    await expect(archiveManagedSessionForCockpit("sess_a", client)).resolves.toEqual(archived);

    expect(client.create).toHaveBeenCalledWith({ workspaceId: "ws_a", title: "Alpha" });
    expect(client.archive).toHaveBeenCalledWith("sess_a");
  });

  it("does not fabricate an offline fallback when the daemon rejects a mutation", async () => {
    const client = daemonClient();
    client.create.mockRejectedValueOnce(new Error("Spark daemon is offline"));

    await expect(
      createManagedSessionForCockpit({ workspaceId: "ws_a", title: "Alpha" }, client),
    ).rejects.toThrow("Spark daemon is offline");
  });
});

function daemonClient(options: { archiveResult?: SparkSessionRegistryRecord } = {}) {
  return {
    list: vi.fn(async () => [session]),
    get: vi.fn(async () => session),
    create: vi.fn(async () => session),
    archive: vi.fn(async () => options.archiveResult ?? session),
  } satisfies CockpitManagedSessionsClient;
}
