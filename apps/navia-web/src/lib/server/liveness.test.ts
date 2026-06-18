import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/navia-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/navia-db";
import { sweepStaleRuntimeConnections } from "./liveness";

describe("runtime liveness", () => {
  it("marks stale online runtimes offline and appends an event", () => {
    const db = openMemoryDatabase();
    migrate(db);

    const runtimeId = createId("rt");
    const sessionId = createId("rtsn");
    const freshRuntimeId = createId("rt");
    const now = new Date("2026-05-22T00:01:00.000Z");
    const staleHeartbeat = "2026-05-22T00:00:00.000Z";
    const freshHeartbeat = "2026-05-22T00:00:50.000Z";

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Stale runtime', 'online', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      runtimeId,
      "stale-install",
      runtimeProtocolVersion,
      staleHeartbeat,
      staleHeartbeat,
      staleHeartbeat,
    );
    db.prepare(
      `INSERT INTO runtime_sessions
        (id, runtime_id, transport, status, connected_at, last_seen_at)
       VALUES (?, ?, 'websocket', 'connected', ?, ?)`,
    ).run(sessionId, runtimeId, staleHeartbeat, staleHeartbeat);

    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, last_heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'Fresh runtime', 'online', ?, '{}', '{}', ?, ?, ?)`,
    ).run(
      freshRuntimeId,
      "fresh-install",
      runtimeProtocolVersion,
      freshHeartbeat,
      freshHeartbeat,
      freshHeartbeat,
    );

    const result = sweepStaleRuntimeConnections(db, { now });

    const staleRuntime = db
      .prepare("SELECT status FROM runtime_connections WHERE id = ?")
      .get(runtimeId) as { status: string };
    const freshRuntime = db
      .prepare("SELECT status FROM runtime_connections WHERE id = ?")
      .get(freshRuntimeId) as { status: string };
    const session = db
      .prepare("SELECT status FROM runtime_sessions WHERE id = ?")
      .get(sessionId) as {
      status: string;
    };
    const event = db
      .prepare("SELECT kind, subject_id AS subjectId FROM events WHERE subject_id = ?")
      .get(runtimeId) as { kind: string; subjectId: string };

    expect(result).toEqual({ staleRuntimeIds: [runtimeId], staleSessionCount: 1 });
    expect(staleRuntime.status).toBe("offline");
    expect(freshRuntime.status).toBe("online");
    expect(session.status).toBe("stale");
    expect(event).toEqual({ kind: "runtime.offline", subjectId: runtimeId });
    db.close();
  });
});
