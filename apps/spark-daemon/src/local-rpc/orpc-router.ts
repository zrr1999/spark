/**
 * oRPC router for the live half-migration method allowlist.
 * Handlers call the same stores/helpers as legacy local-rpc; methods outside
 * `sparkLocalRpcOrpcLiveMethods` throw until migrated.
 */
import type { DatabaseSync } from "node:sqlite";
import { implement } from "@orpc/server";
import { sparkLocalRpcOrpcContract } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { SparkInvocationStore } from "../store/invocations.ts";
import { ensureLocalWorkspace, listWorkspaces } from "../store/workspaces.js";
import { executeSparkDaemonSessionControl } from "../session-control.ts";
import { sparkDaemonUplinkStatus } from "../uplink.ts";
import {
  invocationListResult,
  invocationResult,
  requireChannelIngress,
  requireModelControl,
  sessionControlOptions,
} from "./helpers.ts";
import type { LocalDaemonRestartResult, LocalRpcHandlerOptions } from "./types.ts";

export interface CreateLocalRpcOrpcRouterOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  options?: LocalRpcHandlerOptions;
  onStop?: () => void | Promise<void>;
}

export function createLocalRpcOrpcRouter(input: CreateLocalRpcOrpcRouterOptions) {
  const os = implement(sparkLocalRpcOrpcContract);
  const { paths, db, onStop } = input;
  const options = input.options ?? {};

  const notLive = (method: string) => {
    throw new Error(`${method} is not on the oRPC live allowlist yet.`);
  };

  return os.router({
    daemon: {
      status: os.daemon.status.handler(async () => {
        const lifecycle = options.getLifecycle?.() ?? { state: "running" as const };
        return {
          lifecycle: { state: lifecycle.state },
          observedAt: new Date().toISOString(),
        };
      }),
      stop: os.daemon.stop.handler(async () => {
        options.onStopRequested?.();
        setTimeout(() => {
          void onStop?.();
        }, 0);
        return {
          stopping: true as const,
          observedAt: new Date().toISOString(),
        };
      }),
      restart: os.daemon.restart.handler(async () => {
        if (!options.onRestart) {
          throw new Error("Spark daemon restart control is not available.");
        }
        return (await options.onRestart()) as LocalDaemonRestartResult;
      }),
    },
    channel: {
      status: os.channel.status.handler(async ({ input: params }) => {
        const workspaceId =
          params && typeof params === "object" && "workspaceId" in params
            ? String((params as { workspaceId: unknown }).workspaceId)
            : "";
        return requireChannelIngress(options).status(workspaceId);
      }),
      configure: os.channel.configure.handler(async () => notLive("channel.configure")),
      reload: os.channel.reload.handler(async () => notLive("channel.reload")),
      notify: os.channel.notify.handler(async () => notLive("channel.notify")),
    },
    turn: {
      submit: os.turn.submit.handler(async () => notLive("turn.submit")),
      status: os.turn.status.handler(async ({ input: params }) => {
        const payload =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const executed = await executeSparkDaemonSessionControl(
          sessionControlOptions(paths, db, options),
          { kind: "turn.status.request", scope: "any", payload },
        );
        return executed.result;
      }),
      result: os.turn.result.handler(async ({ input: params }) => {
        const invocationId =
          params && typeof params === "object" && "invocationId" in params
            ? String((params as { invocationId: unknown }).invocationId)
            : "";
        return invocationResult(new SparkInvocationStore(db), invocationId);
      }),
      stream: os.turn.stream.handler(async () => notLive("turn.stream")),
      cancel: os.turn.cancel.handler(async () => notLive("turn.cancel")),
    },
    invocation: {
      list: os.invocation.list.handler(async ({ input: params }) => {
        return invocationListResult(
          new SparkInvocationStore(db),
          params as Parameters<typeof invocationListResult>[1],
        );
      }),
      retry: os.invocation.retry.handler(async () => notLive("invocation.retry")),
      retention: {
        preview: os.invocation.retention.preview.handler(async () =>
          notLive("invocation.retention.preview"),
        ),
      },
    },
    workspace: {
      list: os.workspace.list.handler(async () => ({
        workspaces: listWorkspaces(db).map((workspace) => ({
          id: workspace.id,
          localPath: workspace.localPath,
        })),
        observedAt: new Date().toISOString(),
      })),
      register: os.workspace.register.handler(async () => notLive("workspace.register")),
      relocate: os.workspace.relocate.handler(async () => notLive("workspace.relocate")),
      ensureLocal: os.workspace.ensureLocal.handler(async ({ input: params }) => {
        return ensureLocalWorkspace(
          db,
          params as {
            localPath: string;
            displayName?: string;
            localWorkspaceKey?: string;
          },
        );
      }),
      attach: os.workspace.attach.handler(async () => notLive("workspace.attach")),
      stop: os.workspace.stop.handler(async () => notLive("workspace.stop")),
      client: {
        attach: os.workspace.client.attach.handler(async () => notLive("workspace.client.attach")),
        heartbeat: os.workspace.client.heartbeat.handler(async () =>
          notLive("workspace.client.heartbeat"),
        ),
        release: os.workspace.client.release.handler(async () =>
          notLive("workspace.client.release"),
        ),
      },
      executor: {
        ensure: os.workspace.executor.ensure.handler(async () =>
          notLive("workspace.executor.ensure"),
        ),
      },
      transfer: {
        pending: os.workspace.transfer.pending.handler(async () =>
          notLive("workspace.transfer.pending"),
        ),
        respond: os.workspace.transfer.respond.handler(async () =>
          notLive("workspace.transfer.respond"),
        ),
      },
    },
    uplink: {
      park: os.uplink.park.handler(async () => notLive("uplink.park")),
      unpark: os.uplink.unpark.handler(async () => notLive("uplink.unpark")),
      prefer: os.uplink.prefer.handler(async () => notLive("uplink.prefer")),
      status: os.uplink.status.handler(async () => {
        const status = sparkDaemonUplinkStatus(paths, db) as {
          origins?: Array<{ serverUrl: string; preferred?: boolean; parked?: boolean }>;
        };
        return {
          origins: (status.origins ?? []).map((origin) => ({
            serverUrl: origin.serverUrl,
            ...(origin.preferred !== undefined ? { preferred: origin.preferred } : {}),
            ...(origin.parked !== undefined ? { parked: origin.parked } : {}),
          })),
        };
      }),
    },
    session: {
      list: os.session.list.handler(async ({ input: params }) => {
        const payload =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const executed = await executeSparkDaemonSessionControl(
          sessionControlOptions(paths, db, options),
          { kind: "session.list.request", scope: "any", payload },
        );
        return executed.result.sessions;
      }),
      get: os.session.get.handler(async () => notLive("session.get")),
      snapshot: os.session.snapshot.handler(async () => notLive("session.snapshot")),
      create: os.session.create.handler(async () => notLive("session.create")),
      bind: os.session.bind.handler(async () => notLive("session.bind")),
      unbind: os.session.unbind.handler(async () => notLive("session.unbind")),
      archive: os.session.archive.handler(async () => notLive("session.archive")),
      notification: {
        deliver: os.session.notification.deliver.handler(async () =>
          notLive("session.notification.deliver"),
        ),
      },
      model: {
        set: os.session.model.set.handler(async () => notLive("session.model.set")),
      },
      thinking: {
        set: os.session.thinking.set.handler(async () => notLive("session.thinking.set")),
      },
    },
    model: {
      catalog: os.model.catalog.handler(async ({ input: params }) => {
        const sessionId =
          params && typeof params === "object" && "sessionId" in params
            ? (params as { sessionId?: string }).sessionId
            : undefined;
        return await requireModelControl(options).snapshot(sessionId);
      }),
      default: {
        set: os.model.default.set.handler(async () => notLive("model.default.set")),
      },
    },
    provider: {
      auth: {
        apiKey: {
          set: os.provider.auth.apiKey.set.handler(async () =>
            notLive("provider.auth.api-key.set"),
          ),
        },
        logout: os.provider.auth.logout.handler(async () => notLive("provider.auth.logout")),
        login: {
          start: os.provider.auth.login.start.handler(async () =>
            notLive("provider.auth.login.start"),
          ),
          status: os.provider.auth.login.status.handler(async () =>
            notLive("provider.auth.login.status"),
          ),
          respond: os.provider.auth.login.respond.handler(async () =>
            notLive("provider.auth.login.respond"),
          ),
          cancel: os.provider.auth.login.cancel.handler(async () =>
            notLive("provider.auth.login.cancel"),
          ),
        },
      },
    },
    human: {
      interaction: {
        respond: os.human.interaction.respond.handler(async () =>
          notLive("human.interaction.respond"),
        ),
      },
    },
  });
}

export type LocalRpcOrpcRouter = ReturnType<typeof createLocalRpcOrpcRouter>;
