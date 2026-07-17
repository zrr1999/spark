import {
  cockpitRuntimeRelocationMetadataSchema,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { errorJson } from "$lib/server/json";
import { cockpitRuntimeRelocationInstanceId } from "$lib/server/runtime-relocation";

export const GET: RequestHandler = ({ locals }) => {
  const instanceId = cockpitRuntimeRelocationInstanceId();
  if (!instanceId) {
    return errorJson(
      "cockpit_instance_unavailable",
      "Cockpit instance identity is unavailable.",
      503,
      undefined,
      locals.requestId,
    );
  }
  return json(
    cockpitRuntimeRelocationMetadataSchema.parse({
      instanceId,
      protocolVersion: runtimeProtocolVersion,
    }),
  );
};
