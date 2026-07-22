import { requireChannelIngress } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type ChannelRequest = Extract<
  LocalRpcRequest,
  {
    method: "channel.status" | "channel.configure" | "channel.reload" | "channel.notify";
  }
>;

export async function handleChannelRequest(
  ctx: LocalRpcDispatchContext,
  request: ChannelRequest,
): Promise<LocalRpcResponse> {
  const { options } = ctx;
  switch (request.method) {
    case "channel.status": {
      const channelIngress = requireChannelIngress(options);
      return {
        id: request.id,
        ok: true,
        result: channelIngress.status(request.params.workspaceId),
      };
    }
    case "channel.configure": {
      const channelIngress = requireChannelIngress(options);
      const result = await channelIngress.configure(
        request.params.workspaceId,
        request.params.config,
      );
      return { id: request.id, ok: true, result };
    }
    case "channel.reload": {
      const channelIngress = requireChannelIngress(options);
      const result = await channelIngress.reload(request.params.workspaceId);
      return { id: request.id, ok: true, result };
    }
    case "channel.notify": {
      const channelIngress = requireChannelIngress(options);
      const { workspaceId, ...notifyInput } = request.params;
      const result = await channelIngress.notify(workspaceId, notifyInput);
      return { id: request.id, ok: true, result };
    }
  }
}
