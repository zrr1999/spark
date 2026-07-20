import { getDatabase } from "$lib/server/db";
import { createCockpitEventStreamResponse } from "$lib/server/events-sse";
import { createLivenessSweepScheduler } from "$lib/server/liveness";
import type { RequestHandler } from "@sveltejs/kit";

const sweepLivenessIfDue = createLivenessSweepScheduler();

export const GET: RequestHandler = ({ locals, request, url }) => {
  return createCockpitEventStreamResponse({
    db: getDatabase(),
    request,
    url,
    sweepLivenessIfDue,
    workspaceId: locals.workspaceId,
  });
};
