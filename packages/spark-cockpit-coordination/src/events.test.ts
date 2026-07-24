import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { appendEvent } from "./projection-services";
import {
  cursorFromEvent,
  drainEventBatches,
  encodeSseMessage,
  latestEventCursor,
  loadEventBatch,
  serializeEventRow,
} from "./events";

describe("event streaming helpers", () => {
  it("loads events in cursor order and encodes SSE messages", () => {
    const db = openMemoryDatabase();
    migrate(db);

    appendEvent(db, {
      actorKind: "server",
      kind: "first.event",
      payload: { index: 1 },
      createdAt: "2026-05-22T00:00:00.000Z",
    });
    appendEvent(db, {
      actorKind: "server",
      kind: "second.event",
      payload: { index: 2 },
      createdAt: "2026-05-22T00:00:01.000Z",
    });

    const initial = loadEventBatch(db, null, 10).map(serializeEventRow);
    expect(initial.map((event) => event.kind)).toEqual(["first.event", "second.event"]);
    expect(initial[0]?.payload).toEqual({ index: 1 });

    const cursor = cursorFromEvent(initial[0]!);
    const next = loadEventBatch(db, cursor, 10).map(serializeEventRow);
    expect(next.map((event) => event.kind)).toEqual(["second.event"]);
    expect(latestEventCursor(db)).toEqual({
      id: next[0]?.id,
      createdAt: "2026-05-22T00:00:01.000Z",
      sequence: next[0]?.sequence,
    });
    const latestCursorPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, created_at FROM events ORDER BY ingest_sequence DESC LIMIT 1",
      )
      .all() as Array<{ detail: string }>;
    expect(
      latestCursorPlan.some(({ detail }) => detail.includes("events_ingest_sequence_unique")),
    ).toBe(true);

    const encoded = encodeSseMessage("spark-cockpit.event", next[0], next[0]?.id);
    expect(encoded).toContain("event: spark-cockpit.event\n");
    expect(encoded).toContain("data: ");
    expect(encoded.endsWith("\n\n")).toBe(true);
    db.close();
  });

  it("resolves legacy cursors onto monotonic ingest order", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const createdAt = "2026-05-22T00:00:00.000Z";
    const first = appendEvent(db, {
      actorKind: "server",
      kind: "first.event",
      createdAt,
    });
    const legacyCursor = { id: first.id, createdAt };

    db.prepare(
      `INSERT INTO events
        (id, workspace_id, project_id, actor_kind, actor_id, kind, subject_kind, subject_id, payload_json, created_at)
       VALUES ('evt_00000000000000000000000000000000', NULL, NULL, 'server', NULL, 'late.event', NULL, NULL, '{}', ?)`,
    ).run(createdAt);

    const next = loadEventBatch(db, legacyCursor, 10);
    expect(next.map((event) => event.kind)).toEqual(["late.event"]);
    expect(next[0]?.sequence).toBeGreaterThan(first.sequence);
    db.close();
  });

  it("drains a burst in bounded batches", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const watermark = appendEvent(db, { actorKind: "server", kind: "watermark" });
    for (let index = 0; index < 188; index += 1) {
      appendEvent(db, { actorKind: "server", kind: "burst.event", payload: { index } });
    }

    const firstDrain = drainEventBatches(db, watermark, { batchSize: 50, maxBatches: 3 });
    expect(firstDrain.rows).toHaveLength(150);
    expect(firstDrain.mayHaveMore).toBe(true);
    const secondDrain = drainEventBatches(db, firstDrain.cursor, {
      batchSize: 50,
      maxBatches: 3,
    });
    expect(secondDrain.rows).toHaveLength(38);
    expect(secondDrain.mayHaveMore).toBe(false);
    expect(secondDrain.rows.at(-1)?.payloadJson).toContain('"index":187');
    db.close();
  });

  it("keeps workspace-scoped cursor scans on the workspace sequence index", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-24T00:00:00.000Z";
    const insertWorkspace = db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, status, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
    );
    insertWorkspace.run("ws_a", "workspace-a", "Workspace A", now, now);
    insertWorkspace.run("ws_b", "workspace-b", "Workspace B", now, now);
    const watermark = appendEvent(db, { actorKind: "server", kind: "watermark", createdAt: now });
    appendEvent(db, {
      workspaceId: "ws_a",
      actorKind: "server",
      kind: "workspace-a.event",
      createdAt: now,
    });
    appendEvent(db, {
      workspaceId: "ws_b",
      actorKind: "server",
      kind: "workspace-b.event",
      createdAt: now,
    });

    expect(loadEventBatch(db, watermark, 10, "ws_a").map((event) => event.kind)).toEqual([
      "workspace-a.event",
    ]);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id
           FROM events
          WHERE workspace_id = ? AND ingest_sequence > ?
          ORDER BY ingest_sequence ASC
          LIMIT ?`,
      )
      .all("ws_a", watermark.sequence, 10) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("events_workspace_ingest_sequence_idx"))).toBe(
      true,
    );
    db.close();
  });
});
