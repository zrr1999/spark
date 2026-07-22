import { requireModelControl } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type ModelRequest = Extract<
  LocalRpcRequest,
  {
    method:
      | "model.catalog"
      | "model.default.set"
      | "provider.auth.api-key.set"
      | "provider.auth.logout"
      | "provider.auth.login.start"
      | "provider.auth.login.status"
      | "provider.auth.login.respond"
      | "provider.auth.login.cancel";
  }
>;

export async function handleModelRequest(
  ctx: LocalRpcDispatchContext,
  request: ModelRequest,
): Promise<LocalRpcResponse> {
  const { options } = ctx;
  switch (request.method) {
    case "model.catalog": {
      const snapshot = await requireModelControl(options).snapshot(request.params.sessionId);
      return { id: request.id, ok: true, result: snapshot };
    }
    case "model.default.set": {
      const snapshot = await requireModelControl(options).setDefaultModel(request.params.model);
      return { id: request.id, ok: true, result: snapshot };
    }
    case "provider.auth.api-key.set": {
      const snapshot = await requireModelControl(options).setApiKey(
        request.params.providerName,
        request.params.apiKey,
      );
      return { id: request.id, ok: true, result: snapshot };
    }
    case "provider.auth.logout": {
      const result = await requireModelControl(options).logout(request.params.providerName);
      return { id: request.id, ok: true, result };
    }
    case "provider.auth.login.start": {
      const flow = await requireModelControl(options).startOAuth(request.params.providerName);
      return { id: request.id, ok: true, result: flow };
    }
    case "provider.auth.login.status": {
      const flow = await requireModelControl(options).oauthStatus(request.params.flowId);
      return { id: request.id, ok: true, result: flow };
    }
    case "provider.auth.login.respond": {
      const flow = await requireModelControl(options).respondOAuth(
        request.params.flowId,
        request.params.promptId,
        request.params.value,
      );
      return { id: request.id, ok: true, result: flow };
    }
    case "provider.auth.login.cancel": {
      const flow = await requireModelControl(options).cancelOAuth(request.params.flowId);
      return { id: request.id, ok: true, result: flow };
    }
  }
}
