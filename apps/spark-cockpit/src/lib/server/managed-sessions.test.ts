import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { RuntimeControlCommandError } from "@zendev-lab/spark-coordination/runtime-control";
import { describe, expect, it, vi } from "vitest";
import {
  archiveManagedSessionForCockpit,
  bindManagedSessionForCockpit,
  createManagedSessionForCockpit,
  getManagedSessionForCockpit,
  getManagedSessionSnapshotForCockpit,
  listManagedSessionsForCockpit,
  type CockpitManagedSessionsClient,
} from "./managed-sessions";
import { CockpitRuntimeSessionUnavailableError } from "./cockpit-runtime-session-client";

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

const daemonSession: SparkSessionRegistryRecord = {
  ...session,
  sessionId: "sess_daemon",
  scope: { kind: "daemon", daemonId: "daemon-a" },
  workspaceId: undefined,
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
    await expect(listManagedSessionsForCockpit(workspaceScope, client)).resolves.toEqual({
      available: true,
      sessions: [session],
    });
    await expect(getManagedSessionForCockpit("sess_a", client)).resolves.toEqual(session);
    await expect(getManagedSessionSnapshotForCockpit("sess_a", client)).resolves.toEqual(snapshot);

    expect(client.list).toHaveBeenCalledWith(workspaceScope);
    expect(client.get).toHaveBeenCalledWith("sess_a");
    expect(client.snapshot).toHaveBeenCalledWith("sess_a");
  });

  it("keeps daemon-scoped sessions outside every Cockpit read surface", async () => {
    const client = daemonClient();
    client.list.mockResolvedValueOnce([session, daemonSession]);
    client.get.mockResolvedValue(daemonSession);

    await expect(listManagedSessionsForCockpit({}, client)).resolves.toEqual({
      available: true,
      sessions: [session],
    });
    await expect(
      listManagedSessionsForCockpit({ scope: { kind: "daemon" } }, client),
    ).resolves.toEqual({ available: true, sessions: [] });
    await expect(getManagedSessionForCockpit(daemonSession.sessionId, client)).resolves.toBeNull();
    await expect(
      getManagedSessionSnapshotForCockpit(daemonSession.sessionId, client),
    ).resolves.toBeNull();

    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it("returns an empty read model when the daemon is unavailable or stale", async () => {
    const client = daemonClient();
    client.list.mockRejectedValueOnce(
      new CockpitRuntimeSessionUnavailableError("restart or upgrade the daemon"),
    );

    await expect(listManagedSessionsForCockpit({}, client)).resolves.toEqual({
      available: false,
      sessions: [],
      error: "restart or upgrade the daemon",
    });
  });

  it("returns null for get when the daemon is unavailable or the session is missing", async () => {
    const client = daemonClient();
    client.get
      .mockRejectedValueOnce(new CockpitRuntimeSessionUnavailableError("daemon offline"))
      .mockRejectedValueOnce(
        new RuntimeControlCommandError("unknown session: sess_missing", "session_not_found"),
      );

    await expect(getManagedSessionForCockpit("sess_a", client)).resolves.toBeNull();
    await expect(getManagedSessionForCockpit("sess_missing", client)).resolves.toBeNull();
  });

  it("returns null for snapshot when the daemon read fails", async () => {
    const client = daemonClient();
    client.snapshot
      .mockRejectedValueOnce(new CockpitRuntimeSessionUnavailableError("daemon offline"))
      .mockRejectedValueOnce(new Error("invalid session view"));

    await expect(getManagedSessionSnapshotForCockpit("sess_a", client)).resolves.toBeNull();
    await expect(getManagedSessionSnapshotForCockpit("sess_a", client)).resolves.toBeNull();
  });

  it("returns mutations only after the daemon acknowledges them", async () => {
    const archived = {
      ...session,
      status: "archived" as const,
      updatedAt: "2026-07-10T00:01:00.000Z",
    };
    const bound = {
      ...session,
      bindings: [
        {
          kind: "channel" as const,
          adapter: "infoflow" as const,
          externalKey: "infoflow:user:u1",
          boundAt: "2026-07-10T00:00:30.000Z",
        },
      ],
      updatedAt: "2026-07-10T00:00:30.000Z",
    };
    const client = daemonClient({ archiveResult: archived, bindResult: bound });

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
    await expect(
      bindManagedSessionForCockpit(
        { sessionId: "sess_a", externalKey: "infoflow:user:u1" },
        client,
      ),
    ).resolves.toEqual(bound);
    await expect(archiveManagedSessionForCockpit("sess_a", client)).resolves.toEqual(archived);

    expect(client.create).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "ws_a" },
      workspaceId: "ws_a",
      title: "Alpha",
    });
    expect(client.bind).toHaveBeenCalledWith({
      sessionId: "sess_a",
      externalKey: "infoflow:user:u1",
    });
    expect(client.archive).toHaveBeenCalledWith("sess_a");
  });

  it("does not create native-TUI-only daemon sessions", async () => {
    const client = daemonClient();

    await expect(
      createManagedSessionForCockpit(
        {
          runtimeId: "runtime-a",
          scope: { kind: "daemon" },
          title: "TUI only",
        },
        client,
      ),
    ).rejects.toThrow("workspace-scoped sessions only");
    expect(client.create).not.toHaveBeenCalled();
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

function daemonClient(
  options: {
    archiveResult?: SparkSessionRegistryRecord;
    bindResult?: SparkSessionRegistryRecord;
  } = {},
) {
  return {
    list: vi.fn(async () => [session]),
    get: vi.fn(async () => session),
    snapshot: vi.fn(async () => snapshot),
    create: vi.fn(async () => session),
    bind: vi.fn(async () => options.bindResult ?? session),
    unbind: vi.fn(async () => options.bindResult ?? session),
    archive: vi.fn(async () => options.archiveResult ?? session),
  } satisfies CockpitManagedSessionsClient;
}
