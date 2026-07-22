/**
 * oRPC router for local-rpc methods.
 *
 * Every contracted method is live: handlers bridge into the same legacy
 * `handleLocalRpcLine` dispatch used by daemon.sock so behavior stays unified.
 */
import type { DatabaseSync } from "node:sqlite";
import { implement } from "@orpc/server";
import { sparkLocalRpcOrpcContract } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { invokeLegacyLocalRpc } from "./orpc-bridge.ts";
import type { LocalRpcHandlerOptions } from "./types.ts";

export interface CreateLocalRpcOrpcRouterOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  options?: LocalRpcHandlerOptions;
  onStop?: () => void | Promise<void>;
}

export function createLocalRpcOrpcRouter(input: CreateLocalRpcOrpcRouterOptions) {
  const os = implement(sparkLocalRpcOrpcContract);
  const { paths, db, onStop } = input;
  const handlerOptions = input.options ?? {};

  const invoke = (method: string, params: unknown = {}) =>
    invokeLegacyLocalRpc(method, params, {
      paths,
      db,
      ...(onStop ? { onStop } : {}),
      handlerOptions,
    });

  return os.router({
    daemon: {
      status: os.daemon.status.handler(async () => invoke("daemon.status")),
      stop: os.daemon.stop.handler(async () => invoke("daemon.stop")),
      restart: os.daemon.restart.handler(async () => invoke("daemon.restart")),
    },
    channel: {
      status: os.channel.status.handler(async ({ input: params }) =>
        invoke("channel.status", params),
      ),
      configure: os.channel.configure.handler(async ({ input: params }) =>
        invoke("channel.configure", params),
      ),
      reload: os.channel.reload.handler(async ({ input: params }) =>
        invoke("channel.reload", params),
      ),
      notify: os.channel.notify.handler(async ({ input: params }) =>
        invoke("channel.notify", params),
      ),
    },
    turn: {
      submit: os.turn.submit.handler(async ({ input: params }) => invoke("turn.submit", params)),
      status: os.turn.status.handler(async ({ input: params }) => invoke("turn.status", params)),
      result: os.turn.result.handler(async ({ input: params }) => invoke("turn.result", params)),
      stream: os.turn.stream.handler(async ({ input: params }) => invoke("turn.stream", params)),
      cancel: os.turn.cancel.handler(async ({ input: params }) => invoke("turn.cancel", params)),
    },
    invocation: {
      list: os.invocation.list.handler(async ({ input: params }) =>
        invoke("invocation.list", params),
      ),
      retry: os.invocation.retry.handler(async ({ input: params }) =>
        invoke("invocation.retry", params),
      ),
      retention: {
        preview: os.invocation.retention.preview.handler(async ({ input: params }) =>
          invoke("invocation.retention.preview", params),
        ),
      },
    },
    workspace: {
      list: os.workspace.list.handler(async () => invoke("workspace.list")),
      register: os.workspace.register.handler(async ({ input: params }) =>
        invoke("workspace.register", params),
      ),
      relocate: os.workspace.relocate.handler(async ({ input: params }) =>
        invoke("workspace.relocate", params),
      ),
      ensureLocal: os.workspace.ensureLocal.handler(async ({ input: params }) =>
        invoke("workspace.ensure-local", params),
      ),
      attach: os.workspace.attach.handler(async ({ input: params }) =>
        invoke("workspace.attach", params),
      ),
      stop: os.workspace.stop.handler(async ({ input: params }) =>
        invoke("workspace.stop", params),
      ),
      client: {
        attach: os.workspace.client.attach.handler(async ({ input: params }) =>
          invoke("workspace.client.attach", params),
        ),
        heartbeat: os.workspace.client.heartbeat.handler(async ({ input: params }) =>
          invoke("workspace.client.heartbeat", params),
        ),
        release: os.workspace.client.release.handler(async ({ input: params }) =>
          invoke("workspace.client.release", params),
        ),
      },
      executor: {
        ensure: os.workspace.executor.ensure.handler(async ({ input: params }) =>
          invoke("workspace.executor.ensure", params),
        ),
      },
      transfer: {
        pending: os.workspace.transfer.pending.handler(async ({ input: params }) =>
          invoke("workspace.transfer.pending", params),
        ),
        respond: os.workspace.transfer.respond.handler(async ({ input: params }) =>
          invoke("workspace.transfer.respond", params),
        ),
      },
    },
    uplink: {
      park: os.uplink.park.handler(async ({ input: params }) => invoke("uplink.park", params)),
      unpark: os.uplink.unpark.handler(async ({ input: params }) =>
        invoke("uplink.unpark", params),
      ),
      prefer: os.uplink.prefer.handler(async ({ input: params }) =>
        invoke("uplink.prefer", params),
      ),
      status: os.uplink.status.handler(async () => invoke("uplink.status")),
    },
    session: {
      list: os.session.list.handler(async ({ input: params }) => invoke("session.list", params)),
      get: os.session.get.handler(async ({ input: params }) => invoke("session.get", params)),
      snapshot: os.session.snapshot.handler(async ({ input: params }) =>
        invoke("session.snapshot", params),
      ),
      create: os.session.create.handler(async ({ input: params }) =>
        invoke("session.create", params),
      ),
      bind: os.session.bind.handler(async ({ input: params }) => invoke("session.bind", params)),
      unbind: os.session.unbind.handler(async ({ input: params }) =>
        invoke("session.unbind", params),
      ),
      archive: os.session.archive.handler(async ({ input: params }) =>
        invoke("session.archive", params),
      ),
      notification: {
        deliver: os.session.notification.deliver.handler(async ({ input: params }) =>
          invoke("session.notification.deliver", params),
        ),
      },
      model: {
        set: os.session.model.set.handler(async ({ input: params }) =>
          invoke("session.model.set", params),
        ),
      },
      thinking: {
        set: os.session.thinking.set.handler(async ({ input: params }) =>
          invoke("session.thinking.set", params),
        ),
      },
    },
    sideThread: {
      ensure: os.sideThread.ensure.handler(async ({ input: params }) =>
        invoke("side-thread.ensure", params),
      ),
      snapshot: os.sideThread.snapshot.handler(async ({ input: params }) =>
        invoke("side-thread.snapshot", params),
      ),
      submit: os.sideThread.submit.handler(async ({ input: params }) =>
        invoke("side-thread.submit", params),
      ),
      reset: os.sideThread.reset.handler(async ({ input: params }) =>
        invoke("side-thread.reset", params),
      ),
      configure: os.sideThread.configure.handler(async ({ input: params }) =>
        invoke("side-thread.configure", params),
      ),
      handoff: os.sideThread.handoff.handler(async ({ input: params }) =>
        invoke("side-thread.handoff", params),
      ),
    },
    model: {
      catalog: os.model.catalog.handler(async ({ input: params }) =>
        invoke("model.catalog", params),
      ),
      default: {
        set: os.model.default.set.handler(async ({ input: params }) =>
          invoke("model.default.set", params),
        ),
      },
    },
    provider: {
      auth: {
        apiKey: {
          set: os.provider.auth.apiKey.set.handler(async ({ input: params }) =>
            invoke("provider.auth.api-key.set", params),
          ),
        },
        logout: os.provider.auth.logout.handler(async ({ input: params }) =>
          invoke("provider.auth.logout", params),
        ),
        login: {
          start: os.provider.auth.login.start.handler(async ({ input: params }) =>
            invoke("provider.auth.login.start", params),
          ),
          status: os.provider.auth.login.status.handler(async ({ input: params }) =>
            invoke("provider.auth.login.status", params),
          ),
          respond: os.provider.auth.login.respond.handler(async ({ input: params }) =>
            invoke("provider.auth.login.respond", params),
          ),
          cancel: os.provider.auth.login.cancel.handler(async ({ input: params }) =>
            invoke("provider.auth.login.cancel", params),
          ),
        },
      },
    },
    human: {
      interaction: {
        respond: os.human.interaction.respond.handler(async ({ input: params }) =>
          invoke("human.interaction.respond", params),
        ),
      },
    },
  });
}

export type LocalRpcOrpcRouter = ReturnType<typeof createLocalRpcOrpcRouter>;
