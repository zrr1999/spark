import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent } from "@zendev-lab/spark-extension-api";
import {
  executeSparkSessionAction,
  type SparkSessionAction,
  type SparkSessionActionDeps,
  type SparkSessionToolContext,
} from "./action-tool.ts";

export interface SparkSessionExtensionApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkSessionToolOptions {
  deps?: SparkSessionActionDeps;
}

export function registerPiSessionTool(
  pi: SparkSessionExtensionApi,
  options: SparkSessionToolOptions = {},
): void {
  pi.registerTool({
    name: "session",
    label: "Session",
    description:
      "Canonical persistent session capability for long-lived staff roles. Reuse sessions by stable division of labour, manage lifecycle and bindings, submit tasks, or send durable requests and notifications.",
    promptGuidelines: [
      "A persistent session represents a long-lived division of labour, never one task. List and reuse the matching role session before creating another.",
      "session create requires role and names the session from that stable responsibility. Put the concrete task only in session call/send; never create or name a session after a task or deliverable.",
      "session list is paginated and labels each surface as local or channel plus activity as idle or running; use surface, activity, and adapter filters, then continue with offset when total exceeds the returned page.",
      "session send kind=notification persists without triggering the target session; it is the default and cannot wait for completion.",
      "session send kind=request persists and submits one turn to an idle or running local target. wait=accepted is asynchronous and is the default; wait=completed polls the durable invocation through restart and returns its terminal response.",
      "Message-platform sessions may use only list/get/send/inbox/read/ack. Their list/get/send targets are restricted to the current workspace, and sends require local targets.",
      "inbox/read/ack are current-session-only; inbox supports offset/limit pagination.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | get | create | call | bind | unbind | archive | send | inbox | read | ack",
      }),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Persistent target for get/call/bind/unbind/archive/inbox/read/ack, or requested id for create.",
        }),
      ),
      instruction: Type.Optional(
        Type.String({ description: "Instruction for an explicit persistent session call." }),
      ),
      reset: Type.Optional(
        Type.Boolean({ description: "Persistent call only; reset before submitting the turn." }),
      ),
      scope: Type.Optional(Type.String({ description: "workspace | daemon for create/list." })),
      workspaceId: Type.Optional(Type.String()),
      includeArchived: Type.Optional(Type.Boolean()),
      surface: Type.Optional(
        Type.String({ description: "all | local | channel for list. Defaults to all." }),
      ),
      activity: Type.Optional(
        Type.String({ description: "all | idle | running for list. Defaults to all." }),
      ),
      adapter: Type.Optional(
        Type.String({
          description: "all | feishu | infoflow | qqbot for list. Defaults to all.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum rows. Defaults to 20." })),
      offset: Type.Optional(Type.Number({ description: "List offset. Defaults to 0." })),
      role: Type.Optional(
        Type.String({
          description:
            "Required for create: concise, reusable division of labour such as administrator, frontend, runtime-ops, or verifier.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Optional working directory for create." })),
      externalKey: Type.Optional(Type.String()),
      toSessionId: Type.Optional(Type.String({ description: "Target session for send." })),
      kind: Type.Optional(
        Type.String({
          description:
            "request | notification. Defaults to notification; only request triggers target execution.",
        }),
      ),
      wait: Type.Optional(
        Type.String({
          description:
            "accepted | completed. Defaults to accepted; completed is valid only for request.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Completed request wait timeout in milliseconds (1000-300000).",
        }),
      ),
      intent: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Any()),
      correlationId: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      message: Type.Optional(Type.String({ description: "Durable message body for send." })),
      messageId: Type.Optional(Type.String()),
      includeAcked: Type.Optional(Type.Boolean()),
    }),
    renderCall(args) {
      return new SessionToolCallText(
        [
          "session",
          typeof args.action === "string" ? `action=${args.action}` : "action=?",
          typeof args.toSessionId === "string"
            ? `to=${args.toSessionId}`
            : typeof args.sessionId === "string"
              ? args.sessionId
              : undefined,
          typeof args.kind === "string" ? `kind=${args.kind}` : undefined,
          typeof args.wait === "string" ? `wait=${args.wait}` : undefined,
          typeof args.surface === "string" ? `surface=${args.surface}` : undefined,
          typeof args.activity === "string" ? `activity=${args.activity}` : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" "),
      );
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const action = normalizeSessionAction(params.action);
      return await executeSparkSessionAction(
        {
          action,
          toolCallId,
          params: stripAction(params),
          signal,
          ctx: ctx as SparkSessionToolContext,
        },
        options.deps,
      );
    },
  });
}

export default function sparkSessionExtension(api: SparkSessionExtensionApi): void {
  registerPiSessionTool(api);
}

class SessionToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    if (this.text.length <= width) return [this.text];
    return [`${this.text.slice(0, Math.max(0, width - 1))}…`];
  }
}

function normalizeSessionAction(value: unknown): SparkSessionAction {
  if (
    value === "list" ||
    value === "get" ||
    value === "create" ||
    value === "call" ||
    value === "bind" ||
    value === "unbind" ||
    value === "archive" ||
    value === "send" ||
    value === "inbox" ||
    value === "read" ||
    value === "ack"
  )
    return value;
  throw new Error(
    "session.action must be list, get, create, call, bind, unbind, archive, send, inbox, read, or ack",
  );
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}
