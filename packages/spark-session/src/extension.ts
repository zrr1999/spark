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
      "Canonical persistent session capability. List and classify local/message-platform sessions, manage lifecycle and bindings, submit persistent calls, or send durable requests and notifications.",
    promptGuidelines: [
      "Use role for reusable role definitions and anonymous calls; use session for persistent conversation continuity.",
      "session list is paginated and labels each surface as local or channel plus activity as idle or running; use surface, activity, and adapter filters, then continue with offset when total exceeds the returned page.",
      "session send kind=notification persists and optionally delivers through channel bindings without triggering the target session.",
      "session send kind=request persists and immediately submits one asynchronous turn to an idle or running local target.",
      "session send kind=question persists, immediately submits to an idle local target, and waits up to timeoutMs for its terminal answer; timeout stops waiting but does not cancel the target invocation.",
      "mailto is a compatibility alias for a notification. Replies use kind=notification with replyToMessageId.",
      "Message-platform sessions may use only list/get/send/mailto/inbox/read/ack. Their list/get/send targets are restricted to the current workspace; requests require local targets, while notifications may target local or channel sessions.",
      "inbox/read/ack are current-session-only; inbox supports offset/limit pagination.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | get | create | call | bind | unbind | archive | send | mailto | inbox | read | ack",
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
      title: Type.Optional(Type.String()),
      role: Type.Optional(Type.String({ description: "Optional role metadata for create." })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory for create." })),
      externalKey: Type.Optional(Type.String()),
      toSessionId: Type.Optional(
        Type.String({ description: "Target session for send or mailto." }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            "request | question | notification. Request triggers asynchronously, question waits for a terminal answer, notification does not trigger. Defaults to notification.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Question wait timeout in milliseconds (1000-300000)." }),
      ),
      intent: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Any()),
      correlationId: Type.Optional(Type.String()),
      replyToMessageId: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      message: Type.Optional(
        Type.String({ description: "Durable message body for send or mailto." }),
      ),
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
    value === "mailto" ||
    value === "inbox" ||
    value === "read" ||
    value === "ack"
  )
    return value;
  throw new Error(
    "session.action must be list, get, create, call, bind, unbind, archive, send, mailto, inbox, read, or ack",
  );
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}
