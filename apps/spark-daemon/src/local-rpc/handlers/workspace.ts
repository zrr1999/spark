import {
  attachWorkspace,
  attachWorkspaceClient,
  ensureLocalWorkspace,
  ensureWorkspaceExecutorClient,
  heartbeatWorkspaceClient,
  listWorkspaces,
  planWorkspaceRegistration,
  registerWorkspace,
  releaseWorkspaceClient,
  stopWorkspace,
} from "../../store/workspaces.js";
import { relocateSparkDaemonCockpit } from "../../relocation.ts";
import { workspaceClientResult } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcRequest, LocalRpcResponse } from "../types.ts";

type WorkspaceRequest = Extract<
  LocalRpcRequest,
  {
    method:
      | "workspace.list"
      | "workspace.ensure-local"
      | "workspace.relocate"
      | "workspace.transfer.pending"
      | "workspace.transfer.respond"
      | "workspace.register"
      | "workspace.attach"
      | "workspace.stop"
      | "workspace.client.attach"
      | "workspace.client.heartbeat"
      | "workspace.client.release"
      | "workspace.executor.ensure";
  }
>;

export async function handleWorkspaceRequest(
  ctx: LocalRpcDispatchContext,
  request: WorkspaceRequest,
): Promise<LocalRpcResponse> {
  const {
    paths,
    db,
    options,
    ensureRegistration,
    verifyWorkspaceConnection,
    unbindWorkspaceFromCockpit,
  } = ctx;
  switch (request.method) {
    case "workspace.list":
      return {
        id: request.id,
        ok: true,
        result: {
          workspaces: listWorkspaces(db),
          observedAt: new Date().toISOString(),
        },
      };
    case "workspace.ensure-local":
      return {
        id: request.id,
        ok: true,
        result: ensureLocalWorkspace(db, request.params),
      };
    case "workspace.relocate":
      return {
        id: request.id,
        ok: true,
        result: await (options.relocateSparkDaemonCockpit ?? relocateSparkDaemonCockpit)(
          paths,
          db,
          request.params,
          { onUplinkReconfigure: options.onUplinkReconfigure },
        ),
      };
    case "workspace.transfer.pending": {
      const transfers = options.leaseTransfers;
      const pending = !transfers
        ? []
        : request.params.workspaceId
          ? (() => {
              const item = transfers.pendingForWorkspace(request.params.workspaceId!);
              return item ? [item] : [];
            })()
          : transfers.listPending();
      return {
        id: request.id,
        ok: true,
        result: {
          pending,
          observedAt: new Date().toISOString(),
        },
      };
    }
    case "workspace.transfer.respond": {
      const transfers = options.leaseTransfers;
      if (!transfers) {
        throw new Error("Lease transfer broker is not available on this daemon.");
      }
      const settlement = transfers.respond(
        request.params.transferId,
        request.params.decision,
        request.params.source === "tui" || request.params.source === "cli"
          ? request.params.source
          : "unknown",
      );
      if (!settlement) {
        throw new Error(`Unknown or already settled lease transfer: ${request.params.transferId}`);
      }
      return { id: request.id, ok: true, result: settlement };
    }
    case "workspace.register": {
      // A workspace-scoped one-time token is explicit authority to move the
      // Cockpit projection to another daemon-owned directory. Preserve the
      // daemon-local workspace id so existing sessions keep resolving after
      // correcting or intentionally changing its path.
      const allowLocalPathRebind = Boolean(request.params.registrationToken);
      const planned = planWorkspaceRegistration(db, {
        ...request.params,
        ...(allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
      });
      if (planned.previousServerUrl && planned.previousServerBindingId) {
        await unbindWorkspaceFromCockpit(paths, {
          serverUrl: planned.previousServerUrl,
          bindingId: planned.previousServerBindingId,
          // Credentials were already provisioned for this origin. This only
          // permits completing the explicit local rebind on a trusted legacy
          // HTTP Cockpit; new target registration keeps its own URL guard.
          allowInsecureHttp: true,
        });
      }
      const serviceRegistration = await ensureRegistration(paths, {
        serverUrl: planned.serverUrl,
        ...(request.params.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
        workspaceRegistration: {
          localWorkspaceKey: planned.localWorkspaceKey,
          localPath: planned.localPath,
          displayName: planned.displayName,
          workspaceName: planned.workspaceName,
          workspaceSlug: planned.workspaceSlug,
        },
        ...(request.params.registrationToken
          ? { registrationToken: request.params.registrationToken }
          : {}),
      });
      if (!serviceRegistration.workspaceBinding) {
        throw new Error("Workspace registration did not return a server workspace connection.");
      }
      await verifyWorkspaceConnection({
        config: serviceRegistration.config,
        workspaceBinding: serviceRegistration.workspaceBinding,
        localPath: planned.localPath,
      });
      const workspace = registerWorkspace(db, {
        ...request.params,
        ...(allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
        ...(request.params.registrationToken
          ? { consumedRegistrationToken: request.params.registrationToken }
          : {}),
        ...(serviceRegistration.config.runtimeId && serviceRegistration.config.runtimeToken
          ? {
              serverCredential: {
                runtimeId: serviceRegistration.config.runtimeId,
                runtimeToken: serviceRegistration.config.runtimeToken,
                ...(serviceRegistration.config.runtimeTokenExpiresAt
                  ? { runtimeTokenExpiresAt: serviceRegistration.config.runtimeTokenExpiresAt }
                  : {}),
                ...(serviceRegistration.config.refreshToken
                  ? { refreshToken: serviceRegistration.config.refreshToken }
                  : {}),
                ...(serviceRegistration.config.refreshTokenExpiresAt
                  ? { refreshTokenExpiresAt: serviceRegistration.config.refreshTokenExpiresAt }
                  : {}),
              },
            }
          : {}),
        ...(serviceRegistration.workspaceBinding
          ? {
              serverWorkspaceId: serviceRegistration.workspaceBinding.workspaceId,
              serverBindingId: serviceRegistration.workspaceBinding.bindingId,
              serverStatus: serviceRegistration.workspaceBinding.status,
            }
          : {}),
      });
      if (planned.previousServerUrl) {
        options.onUplinkReconfigure?.(planned.previousServerUrl);
      }
      options.onUplinkReconfigure?.(workspace.serverUrl);
      return {
        id: request.id,
        ok: true,
        result: {
          ...workspace,
          ...(serviceRegistration.workspaceAuthorization
            ? { workspaceAuthorization: serviceRegistration.workspaceAuthorization }
            : {}),
        },
      };
    }
    case "workspace.attach": {
      const workspace = attachWorkspace(db, { id: request.params.id });
      options.onUplinkReconfigure?.(workspace.serverUrl);
      return { id: request.id, ok: true, result: workspace };
    }
    case "workspace.stop": {
      const workspace = stopWorkspace(db, { id: request.params.id });
      options.onUplinkReconfigure?.(workspace.serverUrl);
      return { id: request.id, ok: true, result: workspace };
    }
    case "workspace.client.attach": {
      const client = attachWorkspaceClient(db, request.params);
      return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
    }
    case "workspace.client.heartbeat": {
      const client = heartbeatWorkspaceClient(db, request.params);
      return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
    }
    case "workspace.client.release": {
      const client = releaseWorkspaceClient(db, request.params);
      return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
    }
    case "workspace.executor.ensure": {
      const client = ensureWorkspaceExecutorClient(db, request.params);
      return { id: request.id, ok: true, result: workspaceClientResult(db, client) };
    }
  }
}
