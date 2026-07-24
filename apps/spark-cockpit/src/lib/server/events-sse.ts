import type { DatabaseSync } from "node:sqlite";

import {
  cursorFromEvent,
  drainEventBatches,
  encodeSseMessage,
  serializeEventRow,
  type EventCursor,
} from "@zendev-lab/spark-cockpit-coordination/events";
import { getDatabase, pinDatabase, unpinDatabase } from "./db";

const encoder = new TextEncoder();
const activePollIntervalMs = 200;
const maximumIdlePollIntervalMs = 1_000;
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
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
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
      let nextPollIntervalMs = activePollIntervalMs;
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
        return drained;
      };
      const schedulePoll = (delay: number) => {
        if (closed) return;
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          if (closed) return;
          const drained = flushEvents();
          if (drained.rows.length > 0 || drained.mayHaveMore) {
            nextPollIntervalMs = activePollIntervalMs;
          } else {
            nextPollIntervalMs = Math.min(nextPollIntervalMs * 2, maximumIdlePollIntervalMs);
          }
          const preferredDelay = drained.mayHaveMore ? 0 : nextPollIntervalMs;
          const heartbeatDelay = Math.max(0, heartbeatIntervalMs - (Date.now() - lastWriteAt));
          schedulePoll(Math.min(preferredDelay, heartbeatDelay));
        }, delay);
      };
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        releasePin();
        try {
          controller.close();
        } catch {
          // The client can abort while the runtime has already closed the stream.
        }
      };

      send("ready", { status: "ok" });
      const initialDrain = flushEvents();
      schedulePoll(initialDrain.mayHaveMore ? 0 : activePollIntervalMs);

      options.request.signal.addEventListener("abort", closeStream);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
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
