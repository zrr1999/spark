import type { DatabaseSync } from "node:sqlite";

import {
  cursorFromEvent,
  drainEventBatches,
  encodeSseMessage,
  serializeEventRow,
  type EventCursor,
} from "@zendev-lab/spark-coordination/events";
import { getDatabase, pinDatabase, unpinDatabase } from "./db";

const encoder = new TextEncoder();
const pollIntervalMs = 200;
const heartbeatIntervalMs = 15_000;
const eventBatchSize = 100;
const maxBatchesPerFlush = 8;

export interface CockpitEventStreamOptions {
  request: Request;
  url: URL;
  sweepLivenessIfDue: (db: DatabaseSync) => void;
  workspaceId?: string | null;
  /** Optional injected DB (tests). Defaults to the pinned Cockpit database. */
  db?: DatabaseSync;
}

export function createCockpitEventStreamResponse(options: CockpitEventStreamOptions): Response {
  // Extra pin beyond the request hook: the hook unpins when the response is
  // returned, but the SSE stream keeps reading the DB until abort/cancel.
  // Injected `db` (unit tests) skips the process lock pin.
  const usesPinnedDb = !options.db;
  if (usesPinnedDb) {
    pinDatabase();
  }
  const db = options.db ?? getDatabase();
  let cursor = parseCursor(options.url.searchParams.get("cursor"));
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const releasePin = () => {
    if (released) return;
    released = true;
    if (usesPinnedDb) {
      unpinDatabase();
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      let lastWriteAt = Date.now();
      const enqueue = (value: string) => {
        controller.enqueue(encoder.encode(value));
        lastWriteAt = Date.now();
      };
      const send = (event: string, data: unknown, id?: string) => {
        enqueue(encodeSseMessage(event, data, id));
      };
      const flushEvents = () => {
        options.sweepLivenessIfDue(db);
        const drained = drainEventBatches(db, cursor, {
          batchSize: eventBatchSize,
          maxBatches: maxBatchesPerFlush,
          workspaceId: options.workspaceId,
        });
        for (const row of drained.rows) {
          const serialized = serializeEventRow(row);
          send("spark-cockpit.event", serialized, row.id);
          cursor = cursorFromEvent(row);
        }
        if (Date.now() - lastWriteAt >= heartbeatIntervalMs) {
          enqueue(`: heartbeat ${new Date().toISOString()}\n\n`);
        }
      };
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        releasePin();
        try {
          controller.close();
        } catch {
          // The client can abort while the runtime has already closed the stream.
        }
      };

      send("ready", { status: "ok" });
      flushEvents();
      interval = setInterval(() => {
        if (!closed) flushEvents();
      }, pollIntervalMs);

      options.request.signal.addEventListener("abort", closeStream);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
      releasePin();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function parseCursor(value: string | null): EventCursor | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length === 3 && /^\d+$/.test(parts[0] ?? "")) {
    const [rawSequence, createdAt, id] = parts;
    const sequence = Number(rawSequence);
    if (!createdAt || !id || !Number.isSafeInteger(sequence)) return null;
    return { createdAt, id, sequence };
  }
  const [createdAt, id] = parts;
  if (!createdAt || !id) return null;
  return { createdAt, id };
}
