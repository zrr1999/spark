import { driverUpdateEvent, SparkDriverStore } from "../../store/drivers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type DriverRequest = Extract<LocalRpcRequest, { method: `driver.${string}` }>;

export async function handleDriverRequest(
  ctx: LocalRpcDispatchContext,
  request: DriverRequest,
): Promise<LocalRpcResponse> {
  const store = new SparkDriverStore(ctx.db);
  const mutation = (record: ReturnType<SparkDriverStore["start"]>): LocalRpcResponse => {
    const result = store.mutationResult(record);
    ctx.options.eventBus?.publish(driverUpdateEvent(result.driver));
    return { id: request.id, ok: true, result };
  };
  switch (request.method) {
    case "driver.start": {
      const session = await ctx.options.sessionRegistry?.get(request.params.ownerSessionId);
      if (ctx.options.sessionRegistry && !session) {
        throw new Error(`DRIVER_OWNER_NOT_FOUND: ${request.params.ownerSessionId}`);
      }
      if (session?.status === "archived") {
        throw new Error(`DRIVER_OWNER_ARCHIVED: ${request.params.ownerSessionId}`);
      }
      return mutation(store.start(request.params));
    }
    case "driver.status":
      return {
        id: request.id,
        ok: true,
        result: store.listResult(request.params),
      };
    case "driver.stop":
      return mutation(
        store.stop(request.params.driverId, request.params.reason ?? "stopped by control plane"),
      );
    case "driver.restart":
      return mutation(
        store.restart(
          request.params.driverId,
          request.params.reason ?? "restarted by control plane",
        ),
      );
    case "driver.wake":
      return mutation(
        store.wake(request.params.driverId, {
          prompt: request.params.prompt,
          reason: request.params.reason ?? "manual wake",
        }),
      );
    case "driver.schedule":
      return mutation(store.schedule(request.params));
  }
}
