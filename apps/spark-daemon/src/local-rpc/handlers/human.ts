import { SparkDaemonHumanWaitLookupError } from "../../core/human-waits.ts";
import { requireHumanInteractionResponder, requireHumanWaitRegistry } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type HumanRequest = Extract<LocalRpcRequest, { method: "human.interaction.respond" }>;

export async function handleHumanRequest(
  ctx: LocalRpcDispatchContext,
  request: HumanRequest,
): Promise<LocalRpcResponse> {
  const { options } = ctx;
  switch (request.method) {
    case "human.interaction.respond": {
      const waits = requireHumanWaitRegistry(options);
      let wait;
      try {
        wait = waits.requireUniquePendingInteraction(request.params);
      } catch (error) {
        if (
          error instanceof SparkDaemonHumanWaitLookupError &&
          error.code === "human_interaction_not_found" &&
          request.params.humanResponseId
        ) {
          wait = waits.requireUniqueInteraction(request.params);
        } else {
          throw error;
        }
      }
      const result = await requireHumanInteractionResponder(options)(wait, {
        ...(request.params.humanResponseId
          ? { humanResponseId: request.params.humanResponseId }
          : {}),
        status: request.params.status,
        answers: request.params.answers,
        responseArtifactRefs: request.params.responseArtifactRefs,
      });
      return { id: request.id, ok: true, result };
    }
  }
}
