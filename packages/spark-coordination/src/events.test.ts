import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { appendEvent } from "./projection-services";
import {
  cursorFromEvent,
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
    });
    const latestCursorPlan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .all() as Array<{ detail: string }>;
    expect(latestCursorPlan.some(({ detail }) => detail.includes("events_created_id_idx"))).toBe(
      true,
    );

    const encoded = encodeSseMessage("spark-cockpit.event", next[0], next[0]?.id);
    expect(encoded).toContain("event: spark-cockpit.event\n");
    expect(encoded).toContain("data: ");
    expect(encoded.endsWith("\n\n")).toBe(true);
    db.close();
  });
});
