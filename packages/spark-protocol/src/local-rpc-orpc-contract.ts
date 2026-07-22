/**
 * Phase 4 oRPC local-RPC contract surface.
 *
 * Covers every dotted local-rpc method name. Output schemas stay intentionally
 * loose (`z.unknown()` / minimal objects) where full daemon result types are
 * not yet shared in protocol — wire shape validation can tighten later.
 * Procedures marked in `sparkLocalRpcOrpcLiveMethods` are expected to round-trip
 * via oRPC; the rest remain contract-only until handlers migrate.
 */
import { oc } from "@orpc/contract";
import { z } from "zod";
import { sparkModelControlSnapshotSchema } from "./model-control.ts";
import { isoDateTimeSchema } from "./refs.ts";
import {
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadHandoffResultSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSnapshotRequestSchema,
  sparkSideThreadSnapshotSchema,
  sparkSideThreadSubmitRequestSchema,
  sparkSideThreadSubmitResultSchema,
} from "./side-thread.ts";

const emptyInputSchema = z.object({}).default({});
const unknownResultSchema = z.unknown();
const workspaceIdInputSchema = z.object({ workspaceId: z.string().min(1) });
const invocationIdInputSchema = z.object({ invocationId: z.string().min(1) });
const sessionIdInputSchema = z.object({ sessionId: z.string().min(1) });
const providerNameInputSchema = z.object({ providerName: z.string().min(1) });
const flowIdInputSchema = z.object({ flowId: z.string().min(1) });

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

export const sparkLocalRpcWorkspaceListResultSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      localPath: z.string().min(1),
    }),
  ),
  observedAt: isoDateTimeSchema,
});

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

function procedure(
  method: "GET" | "POST",
  path: `/${string}`,
  input: z.ZodType = emptyInputSchema,
  output: z.ZodType = unknownResultSchema,
) {
  return oc.route({ method, path }).input(input).output(output);
}

export const sparkLocalRpcOrpcContract = {
  daemon: {
    /** local-rpc method: daemon.status */
    status: procedure(
      "GET",
      "/daemon/status",
      emptyInputSchema,
      sparkLocalRpcDaemonStatusResultSchema,
    ),
    /** local-rpc method: daemon.stop */
    stop: procedure("POST", "/daemon/stop", emptyInputSchema, sparkLocalRpcDaemonStopResultSchema),
    /** local-rpc method: daemon.restart */
    restart: procedure("POST", "/daemon/restart"),
  },
  channel: {
    status: procedure("GET", "/channel/status", workspaceIdInputSchema),
    configure: procedure(
      "POST",
      "/channel/configure",
      z.object({ workspaceId: z.string().min(1), config: z.unknown() }),
    ),
    reload: procedure("POST", "/channel/reload", workspaceIdInputSchema),
    notify: procedure(
      "POST",
      "/channel/notify",
      z.object({ workspaceId: z.string().min(1) }).passthrough(),
    ),
  },
  turn: {
    submit: procedure("POST", "/turn/submit", z.record(z.string(), z.unknown())),
    status: procedure("GET", "/turn/status", invocationIdInputSchema),
    result: procedure("GET", "/turn/result", invocationIdInputSchema),
    stream: procedure(
      "GET",
      "/turn/stream",
      z.object({
        invocationId: z.string().min(1),
        after: z.number().optional(),
        limit: z.number().optional(),
      }),
    ),
    cancel: procedure(
      "POST",
      "/turn/cancel",
      z.object({ invocationId: z.string().min(1), reason: z.string().optional() }),
    ),
  },
  invocation: {
    list: procedure("GET", "/invocation/list", z.record(z.string(), z.unknown()).default({})),
    retry: procedure("POST", "/invocation/retry", invocationIdInputSchema),
    retention: {
      preview: procedure(
        "GET",
        "/invocation/retention/preview",
        z.object({
          before: z.string().optional(),
          limit: z.number().optional(),
        }),
      ),
    },
  },
  workspace: {
    list: procedure(
      "GET",
      "/workspace/list",
      emptyInputSchema,
      sparkLocalRpcWorkspaceListResultSchema,
    ),
    register: procedure("POST", "/workspace/register", z.record(z.string(), z.unknown())),
    relocate: procedure("POST", "/workspace/relocate", z.record(z.string(), z.unknown())),
    ensureLocal: procedure(
      "POST",
      "/workspace/ensure-local",
      z.object({
        localPath: z.string().min(1),
        displayName: z.string().optional(),
        localWorkspaceKey: z.string().optional(),
      }),
    ),
    attach: procedure("POST", "/workspace/attach", z.object({ id: z.string().min(1) })),
    stop: procedure("POST", "/workspace/stop", z.object({ id: z.string().min(1) })),
    client: {
      attach: procedure("POST", "/workspace/client/attach", z.record(z.string(), z.unknown())),
      heartbeat: procedure(
        "POST",
        "/workspace/client/heartbeat",
        z.record(z.string(), z.unknown()),
      ),
      release: procedure(
        "POST",
        "/workspace/client/release",
        z.object({ clientId: z.string().min(1) }),
      ),
    },
    executor: {
      ensure: procedure("POST", "/workspace/executor/ensure", z.record(z.string(), z.unknown())),
    },
    transfer: {
      pending: procedure(
        "GET",
        "/workspace/transfer/pending",
        z.object({ workspaceId: z.string().min(1).optional() }).default({}),
      ),
      respond: procedure(
        "POST",
        "/workspace/transfer/respond",
        z.object({
          transferId: z.string().min(1),
          decision: z.enum(["accept", "reject"]),
          source: z.enum(["tui", "cli"]).optional(),
        }),
      ),
    },
  },
  uplink: {
    park: procedure("POST", "/uplink/park", z.object({ serverUrl: z.string().min(1) })),
    unpark: procedure("POST", "/uplink/unpark", z.object({ serverUrl: z.string().min(1) })),
    prefer: procedure(
      "POST",
      "/uplink/prefer",
      z.object({
        workspace: z.string().min(1),
        serverUrl: z.string().min(1),
        force: z.boolean().optional(),
      }),
    ),
    status: procedure(
      "GET",
      "/uplink/status",
      emptyInputSchema,
      sparkLocalRpcUplinkStatusResultSchema,
    ),
  },
  session: {
    list: procedure("GET", "/session/list", z.record(z.string(), z.unknown()).default({})),
    get: procedure("GET", "/session/get", sessionIdInputSchema),
    snapshot: procedure("GET", "/session/snapshot", sessionIdInputSchema),
    create: procedure("POST", "/session/create", z.record(z.string(), z.unknown())),
    bind: procedure("POST", "/session/bind", z.record(z.string(), z.unknown())),
    unbind: procedure("POST", "/session/unbind", z.record(z.string(), z.unknown())),
    archive: procedure("POST", "/session/archive", z.record(z.string(), z.unknown())),
    notification: {
      deliver: procedure(
        "POST",
        "/session/notification/deliver",
        z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) }),
      ),
    },
    model: {
      set: procedure(
        "POST",
        "/session/model/set",
        z.object({ sessionId: z.string().min(1), model: z.unknown() }),
      ),
    },
    thinking: {
      set: procedure(
        "POST",
        "/session/thinking/set",
        z.object({ sessionId: z.string().min(1), thinkingLevel: z.unknown() }),
      ),
    },
  },
  sideThread: {
    ensure: procedure(
      "POST",
      "/side-thread/ensure",
      sparkSideThreadEnsureRequestSchema,
      sparkSideThreadSnapshotSchema,
    ),
    snapshot: procedure(
      "GET",
      "/side-thread/snapshot",
      sparkSideThreadSnapshotRequestSchema,
      sparkSideThreadSnapshotSchema,
    ),
    submit: procedure(
      "POST",
      "/side-thread/submit",
      sparkSideThreadSubmitRequestSchema,
      sparkSideThreadSubmitResultSchema,
    ),
    reset: procedure(
      "POST",
      "/side-thread/reset",
      sparkSideThreadResetRequestSchema,
      sparkSideThreadSnapshotSchema,
    ),
    configure: procedure(
      "POST",
      "/side-thread/configure",
      sparkSideThreadConfigureRequestSchema,
      sparkSideThreadSnapshotSchema,
    ),
    handoff: procedure(
      "POST",
      "/side-thread/handoff",
      sparkSideThreadHandoffRequestSchema,
      sparkSideThreadHandoffResultSchema,
    ),
  },
  model: {
    catalog: procedure(
      "GET",
      "/model/catalog",
      sparkLocalRpcModelCatalogInputSchema,
      sparkModelControlSnapshotSchema,
    ),
    default: {
      set: procedure("POST", "/model/default/set", z.object({ model: z.unknown() })),
    },
  },
  provider: {
    auth: {
      apiKey: {
        set: procedure(
          "POST",
          "/provider/auth/api-key/set",
          z.object({ providerName: z.string().min(1), apiKey: z.string().min(1) }),
        ),
      },
      logout: procedure("POST", "/provider/auth/logout", providerNameInputSchema),
      login: {
        start: procedure("POST", "/provider/auth/login/start", providerNameInputSchema),
        status: procedure("GET", "/provider/auth/login/status", flowIdInputSchema),
        respond: procedure(
          "POST",
          "/provider/auth/login/respond",
          z.object({
            flowId: z.string().min(1),
            promptId: z.string().min(1),
            value: z.string(),
          }),
        ),
        cancel: procedure("POST", "/provider/auth/login/cancel", flowIdInputSchema),
      },
    },
  },
  human: {
    interaction: {
      respond: procedure("POST", "/human/interaction/respond", z.record(z.string(), z.unknown())),
    },
  },
} as const;

export type SparkLocalRpcOrpcContract = typeof sparkLocalRpcOrpcContract;

/**
 * Stable map from existing dotted local-rpc method names → contract path.
 * Every local-rpc method must appear here once the contract is complete.
 */
export const sparkLocalRpcOrpcMethodPaths = {
  "daemon.status": ["daemon", "status"],
  "daemon.stop": ["daemon", "stop"],
  "daemon.restart": ["daemon", "restart"],
  "channel.status": ["channel", "status"],
  "channel.configure": ["channel", "configure"],
  "channel.reload": ["channel", "reload"],
  "channel.notify": ["channel", "notify"],
  "turn.submit": ["turn", "submit"],
  "turn.status": ["turn", "status"],
  "turn.result": ["turn", "result"],
  "turn.stream": ["turn", "stream"],
  "turn.cancel": ["turn", "cancel"],
  "invocation.list": ["invocation", "list"],
  "invocation.retry": ["invocation", "retry"],
  "invocation.retention.preview": ["invocation", "retention", "preview"],
  "workspace.list": ["workspace", "list"],
  "workspace.register": ["workspace", "register"],
  "workspace.relocate": ["workspace", "relocate"],
  "workspace.ensure-local": ["workspace", "ensureLocal"],
  "workspace.attach": ["workspace", "attach"],
  "workspace.stop": ["workspace", "stop"],
  "workspace.client.attach": ["workspace", "client", "attach"],
  "workspace.client.heartbeat": ["workspace", "client", "heartbeat"],
  "workspace.client.release": ["workspace", "client", "release"],
  "workspace.executor.ensure": ["workspace", "executor", "ensure"],
  "workspace.transfer.pending": ["workspace", "transfer", "pending"],
  "workspace.transfer.respond": ["workspace", "transfer", "respond"],
  "uplink.park": ["uplink", "park"],
  "uplink.unpark": ["uplink", "unpark"],
  "uplink.prefer": ["uplink", "prefer"],
  "uplink.status": ["uplink", "status"],
  "session.list": ["session", "list"],
  "session.get": ["session", "get"],
  "session.snapshot": ["session", "snapshot"],
  "session.create": ["session", "create"],
  "session.bind": ["session", "bind"],
  "session.unbind": ["session", "unbind"],
  "session.archive": ["session", "archive"],
  "session.notification.deliver": ["session", "notification", "deliver"],
  "session.model.set": ["session", "model", "set"],
  "session.thinking.set": ["session", "thinking", "set"],
  "side-thread.ensure": ["sideThread", "ensure"],
  "side-thread.snapshot": ["sideThread", "snapshot"],
  "side-thread.submit": ["sideThread", "submit"],
  "side-thread.reset": ["sideThread", "reset"],
  "side-thread.configure": ["sideThread", "configure"],
  "side-thread.handoff": ["sideThread", "handoff"],
  "model.catalog": ["model", "catalog"],
  "model.default.set": ["model", "default", "set"],
  "provider.auth.api-key.set": ["provider", "auth", "apiKey", "set"],
  "provider.auth.logout": ["provider", "auth", "logout"],
  "provider.auth.login.start": ["provider", "auth", "login", "start"],
  "provider.auth.login.status": ["provider", "auth", "login", "status"],
  "provider.auth.login.respond": ["provider", "auth", "login", "respond"],
  "provider.auth.login.cancel": ["provider", "auth", "login", "cancel"],
  "human.interaction.respond": ["human", "interaction", "respond"],
} as const;

export type SparkLocalRpcOrpcMethod = keyof typeof sparkLocalRpcOrpcMethodPaths;

/**
 * Methods with live oRPC handlers. The daemon router bridges every contracted
 * method onto legacy local-rpc dispatch; clients may still fall back to
 * daemon.sock when the oRPC socket is unavailable.
 */
export const sparkLocalRpcOrpcLiveMethods = Object.keys(
  sparkLocalRpcOrpcMethodPaths,
) as SparkLocalRpcOrpcMethod[];

export type SparkLocalRpcOrpcLiveMethod = SparkLocalRpcOrpcMethod;

/** @deprecated Use SparkLocalRpcOrpcMethod — spike alias retained for callers. */
export type SparkLocalRpcOrpcSpikeMethod = SparkLocalRpcOrpcMethod;
