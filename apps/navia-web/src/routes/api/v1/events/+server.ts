import { getDatabase } from "$lib/server/db";
import {
  cursorFromEvent,
  encodeSseMessage,
  loadEventBatch,
  serializeEventRow,
} from "$lib/server/events";
import { sweepStaleRuntimeConnections } from "$lib/server/liveness";
import type { EventCursor } from "$lib/server/events";
import type { RequestHandler } from "@sveltejs/kit";

const encoder = new TextEncoder();
const pollIntervalMs = 2_000;

export const GET: RequestHandler = ({ request, url }) => {
  const db = getDatabase();
  let cursor = parseCursor(url.searchParams.get("cursor"));
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown, id?: string) => {
        controller.enqueue(encoder.encode(encodeSseMessage(event, data, id)));
      };
      const flushEvents = () => {
        sweepStaleRuntimeConnections(db);
        const rows = loadEventBatch(db, cursor);
        for (const row of rows) {
          const serialized = serializeEventRow(row);
          send("navia.event", serialized, row.id);
          cursor = cursorFromEvent(row);
        }
      };
      const closeStream = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (interval) {
          clearInterval(interval);
        }
        try {
          controller.close();
        } catch {
          // The client can abort while the runtime has already closed the stream.
        }
      };

      send("ready", { status: "ok" });
      flushEvents();
      interval = setInterval(() => {
        if (!closed) {
          flushEvents();
        }
      }, pollIntervalMs);

      request.signal.addEventListener("abort", closeStream);
    },
    cancel() {
      closed = true;
      if (interval) {
        clearInterval(interval);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream",
      connection: "keep-alive",
    },
  });
};

function parseCursor(value: string | null): EventCursor | null {
  if (!value) {
    return null;
  }

  const [createdAt, id] = value.split("|");
  if (!createdAt || !id) {
    return null;
  }

  return { createdAt, id };
}
