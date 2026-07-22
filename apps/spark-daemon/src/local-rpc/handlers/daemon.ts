import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkChannelDeliveryStore } from "../../store/channel-deliveries.ts";
import { sparkDaemonServerStatusSummaries } from "../../store/workspaces.js";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type DaemonRequest = Extract<
  LocalRpcRequest,
  { method: "daemon.status" | "daemon.stop" | "daemon.restart" }
>;

export async function handleDaemonRequest(
  ctx: LocalRpcDispatchContext,
  request: DaemonRequest,
): Promise<LocalRpcResponse> {
  const { db, onStop, options } = ctx;
  switch (request.method) {
    case "daemon.status": {
      const store = new SparkInvocationStore(db);
      const oldestActive = store.oldestActive();
      return {
        id: request.id,
        ok: true,
        result: {
          servers: sparkDaemonServerStatusSummaries(db),
          invocations: store.counts(),
          invocationHealth: {
            ...(oldestActive.queued ? { oldestQueuedAt: oldestActive.queued } : {}),
            ...(oldestActive.running ? { oldestRunningAt: oldestActive.running } : {}),
          },
          channelDeliveries: new SparkChannelDeliveryStore(db).summary(),
          lifecycle: options.getLifecycle?.() ?? { state: "running" },
          observedAt: new Date().toISOString(),
        },
      };
    }
    case "daemon.stop":
      options.onStopRequested?.();
      setTimeout(() => {
        void onStop?.();
      }, 0);
      return {
        id: request.id,
        ok: true,
        result: {
          stopping: true,
          observedAt: new Date().toISOString(),
        },
      };
    case "daemon.restart": {
      if (!options.onRestart) {
        throw new Error("Spark daemon restart control is not available.");
      }
      return {
        id: request.id,
        ok: true,
        result: await options.onRestart(),
      };
    }
  }
}
