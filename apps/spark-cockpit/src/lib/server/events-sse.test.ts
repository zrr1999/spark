import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { appendEvent } from "@zendev-lab/spark-cockpit-coordination/projection-services";
import type { DatabaseSync } from "node:sqlite";

import { createCockpitEventStreamResponse } from "./events-sse";

let db: DatabaseSync;

describe("Cockpit event SSE", () => {
  beforeEach(() => {
    db = openMemoryDatabase();
    migrate(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("drains a model-sized burst immediately and disables proxy buffering", async () => {
    const createdAt = "2026-07-15T00:00:00.000Z";
    const watermark = appendEvent(db, { actorKind: "server", kind: "watermark", createdAt });
    for (let index = 0; index < 188; index += 1) {
      appendEvent(db, {
        actorKind: "server",
        kind: "invocation.log_chunk",
        payload: { index },
        createdAt,
      });
    }

    const abort = new AbortController();
    const url = new URL(
      `http://localhost/api/v1/events?cursor=${encodeURIComponent(`${createdAt}|${watermark.id}`)}`,
    );
    const request = new Request(url, { signal: abort.signal });
    const response = createCockpitEventStreamResponse({
      db,
      request,
      url,
      sweepLivenessIfDue: () => undefined,
    });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
    const events: string[] = [];
    for (let index = 0; index < 188; index += 1) {
      events.push(decoder.decode((await reader.read()).value));
    }
    expect(events).toHaveLength(188);
    expect(events[0]).toContain('"index":0');
    expect(events.at(-1)).toContain('"index":187');
    abort.abort();
    await reader.cancel();
  });

  it("resumes from the monotonic browser cursor without replaying its watermark", async () => {
    const createdAt = "2026-07-15T00:00:00.000Z";
    const watermark = appendEvent(db, { actorKind: "server", kind: "watermark", createdAt });
    const next = appendEvent(db, {
      actorKind: "server",
      kind: "daemon.view_event",
      payload: { message: "next" },
      createdAt,
    });
    const sequence = db
      .prepare("SELECT ingest_sequence AS sequence FROM events WHERE id = ?")
      .get(watermark.id) as { sequence: number };
    const abort = new AbortController();
    const cursor = `${sequence.sequence}|${createdAt}|${watermark.id}`;
    const url = new URL(`http://localhost/api/v1/events?cursor=${encodeURIComponent(cursor)}`);
    const request = new Request(url, { signal: abort.signal });
    const response = createCockpitEventStreamResponse({
      db,
      request,
      url,
      sweepLivenessIfDue: () => undefined,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
    const event = decoder.decode((await reader.read()).value);
    expect(event).toContain(next.id);
    expect(event).not.toContain(watermark.id);
    abort.abort();
    await reader.cancel();
  });

  it("emits an idle heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const abort = new AbortController();
    const url = new URL("http://localhost/api/v1/events");
    const request = new Request(url, { signal: abort.signal });
    const response = createCockpitEventStreamResponse({
      db,
      request,
      url,
      sweepLivenessIfDue: () => undefined,
    });
    const reader = response.body!.getReader();
    await reader.read(); // ready

    await vi.advanceTimersByTimeAsync(15_000);
    const heartbeat = new TextDecoder().decode((await reader.read()).value);
    expect(heartbeat).toContain(": heartbeat 2026-07-15T00:00:15.000Z");
    abort.abort();
    await reader.cancel();
  });

  it("backs idle polling off while still delivering newly appended events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const abort = new AbortController();
    const url = new URL("http://localhost/api/v1/events");
    const request = new Request(url, { signal: abort.signal });
    let sweepCount = 0;
    const response = createCockpitEventStreamResponse({
      db,
      request,
      url,
      sweepLivenessIfDue: () => {
        sweepCount += 1;
      },
    });
    const reader = response.body!.getReader();
    await reader.read(); // ready

    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweepCount).toBeLessThanOrEqual(5);

    const event = appendEvent(db, {
      actorKind: "server",
      kind: "idle-wakeup.event",
      createdAt: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const payload = new TextDecoder().decode((await reader.read()).value);
    expect(payload).toContain(event.id);

    abort.abort();
    await reader.cancel();
  });
});
