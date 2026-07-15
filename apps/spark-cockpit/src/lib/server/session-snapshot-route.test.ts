import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  getManagedSessionForCockpit: mocks.get,
  getManagedSessionSnapshotForCockpit: mocks.snapshot,
}));

vi.mock("$lib/session-snapshot-window", () => ({
  normalizeSessionSnapshotLimit: () => 80,
  sessionSnapshotWindow: (snapshot: unknown, limit: number) => ({ snapshot, limit }),
}));

import { GET } from "../../routes/api/v1/sessions/[sessionId]/snapshot/+server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue({ sessionId: "sess_global", messages: [] });
});

describe("session snapshot route", () => {
  it("returns snapshot history for a daemon-global conversation", async () => {
    mocks.get.mockResolvedValue({
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "daemon-local" },
    });

    const response = await getSnapshot("sess_global");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: { sessionId: "sess_global", messages: [] },
      limit: 80,
    });
  });

  it("keeps an unknown session private", async () => {
    mocks.get.mockResolvedValue(null);

    const response = await getSnapshot("sess_missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "session_not_found" });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});

async function getSnapshot(sessionId: string): Promise<Response> {
  const url = new URL(`http://localhost/api/v1/sessions/${sessionId}/snapshot?limit=80`);
  return (await GET({ params: { sessionId }, url } as Parameters<typeof GET>[0])) as Response;
}
