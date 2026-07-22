import { createCockpitEventStreamResponse } from "$lib/server/events-sse";
import { createLivenessSweepScheduler } from "@zendev-lab/spark-cockpit-coordination/liveness";
import type { RequestHandler } from "@sveltejs/kit";

const sweepLivenessIfDue = createLivenessSweepScheduler();

export const GET: RequestHandler = ({ locals, request, url }) => {
  return createCockpitEventStreamResponse({
    request,
    url,
    sweepLivenessIfDue,
    workspaceId: locals.workspaceId,
  });
};
