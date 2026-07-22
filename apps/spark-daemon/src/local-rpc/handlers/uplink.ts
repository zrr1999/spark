import {
  parkSparkDaemonUplink,
  preferSparkDaemonWorkspaceUplinkWithTransfer,
  sparkDaemonUplinkStatus,
  unparkSparkDaemonUplink,
} from "../../uplink.ts";
import { SparkDaemonLeaseTransferBroker } from "../../core/lease-transfer.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type UplinkRequest = Extract<
  LocalRpcRequest,
  { method: "uplink.park" | "uplink.unpark" | "uplink.prefer" | "uplink.status" }
>;

export async function handleUplinkRequest(
  ctx: LocalRpcDispatchContext,
  request: UplinkRequest,
): Promise<LocalRpcResponse> {
  const { paths, db, options } = ctx;
  switch (request.method) {
    case "uplink.park": {
      const profile = await parkSparkDaemonUplink(paths, request.params.serverUrl);
      options.onUplinkReconfigure?.(profile.serverUrl);
      return { id: request.id, ok: true, result: profile };
    }
    case "uplink.unpark": {
      const profile = await unparkSparkDaemonUplink(paths, request.params.serverUrl);
      options.onUplinkReconfigure?.(profile.serverUrl);
      return { id: request.id, ok: true, result: profile };
    }
    case "uplink.prefer": {
      const transfers = options.leaseTransfers ?? new SparkDaemonLeaseTransferBroker();
      const preferred = await preferSparkDaemonWorkspaceUplinkWithTransfer(
        paths,
        db,
        request.params,
        {
          transfers,
          ...(options.humanWaits ? { humanWaits: options.humanWaits } : {}),
          ...(options.onHumanRequestOutboxReady
            ? { onOutboxReady: options.onHumanRequestOutboxReady }
            : {}),
          ...(options.getRuntimeIdForServer ? { getRuntimeId: options.getRuntimeIdForServer } : {}),
          ...(request.params.force === true ? { force: true } : {}),
        },
      );
      if (preferred.previousServerUrl) {
        options.onUplinkReconfigure?.(preferred.previousServerUrl);
      }
      options.onUplinkReconfigure?.(preferred.serverUrl);
      return { id: request.id, ok: true, result: preferred };
    }
    case "uplink.status":
      return {
        id: request.id,
        ok: true,
        result: sparkDaemonUplinkStatus(paths, db),
      };
  }
}
