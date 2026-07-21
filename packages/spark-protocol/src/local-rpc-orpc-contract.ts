/**
 * Phase 4 oRPC spike: contract-first surface for five representative local-RPC
 * methods. This is scaffolding only — daemon dispatch still uses hand-written
 * local-rpc.ts. Schemas are intentionally simplified where full daemon result
 * types are not yet shared in protocol.
 */
import { oc } from "@orpc/contract";
import { z } from "zod";
import { sparkModelControlSnapshotSchema } from "./model-control.ts";
import { isoDateTimeSchema } from "./refs.ts";

const emptyInputSchema = z.object({}).default({});

/** Spike-shaped daemon.status result (subset of LocalDaemonStatusResult). */
export const sparkLocalRpcDaemonStatusResultSchema = z.object({
  lifecycle: z.object({
    state: z.enum(["starting", "running", "draining", "stopping"]),
  }),
  observedAt: isoDateTimeSchema,
});

export const sparkLocalRpcDaemonStopResultSchema = z.object({
  stopping: z.literal(true),
  observedAt: isoDateTimeSchema,
});

/** Spike-shaped workspace list entry (id + path only). */
export const sparkLocalRpcWorkspaceListResultSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      localPath: z.string().min(1),
    }),
  ),
  observedAt: isoDateTimeSchema,
});

/** Spike-shaped uplink.status (origins list). */
export const sparkLocalRpcUplinkStatusResultSchema = z.object({
  origins: z.array(
    z.object({
      serverUrl: z.string().min(1),
      preferred: z.boolean().optional(),
      parked: z.boolean().optional(),
    }),
  ),
});

export const sparkLocalRpcModelCatalogInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
  })
  .default({});

export const sparkLocalRpcDaemonStatusContract = oc
  .route({ method: "GET", path: "/daemon/status" })
  .input(emptyInputSchema)
  .output(sparkLocalRpcDaemonStatusResultSchema);

export const sparkLocalRpcDaemonStopContract = oc
  .route({ method: "POST", path: "/daemon/stop" })
  .input(emptyInputSchema)
  .output(sparkLocalRpcDaemonStopResultSchema);

export const sparkLocalRpcWorkspaceListContract = oc
  .route({ method: "GET", path: "/workspace/list" })
  .input(emptyInputSchema)
  .output(sparkLocalRpcWorkspaceListResultSchema);

export const sparkLocalRpcUplinkStatusContract = oc
  .route({ method: "GET", path: "/uplink/status" })
  .input(emptyInputSchema)
  .output(sparkLocalRpcUplinkStatusResultSchema);

export const sparkLocalRpcModelCatalogContract = oc
  .route({ method: "GET", path: "/model/catalog" })
  .input(sparkLocalRpcModelCatalogInputSchema)
  .output(sparkModelControlSnapshotSchema);

/**
 * Nested contract router mirroring local-RPC method domains.
 * Procedure keys use camelCase; wire method names stay dotted in docs/comments.
 */
export const sparkLocalRpcOrpcContract = {
  daemon: {
    /** local-rpc method: daemon.status */
    status: sparkLocalRpcDaemonStatusContract,
    /** local-rpc method: daemon.stop */
    stop: sparkLocalRpcDaemonStopContract,
  },
  workspace: {
    /** local-rpc method: workspace.list */
    list: sparkLocalRpcWorkspaceListContract,
  },
  uplink: {
    /** local-rpc method: uplink.status */
    status: sparkLocalRpcUplinkStatusContract,
  },
  model: {
    /** local-rpc method: model.catalog */
    catalog: sparkLocalRpcModelCatalogContract,
  },
} as const;

export type SparkLocalRpcOrpcContract = typeof sparkLocalRpcOrpcContract;

/** Stable map from existing dotted local-rpc method names → contract path. */
export const sparkLocalRpcOrpcMethodPaths = {
  "daemon.status": ["daemon", "status"],
  "daemon.stop": ["daemon", "stop"],
  "workspace.list": ["workspace", "list"],
  "uplink.status": ["uplink", "status"],
  "model.catalog": ["model", "catalog"],
} as const;

export type SparkLocalRpcOrpcSpikeMethod = keyof typeof sparkLocalRpcOrpcMethodPaths;
