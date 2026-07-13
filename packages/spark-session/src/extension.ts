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
      "Canonical persistent session capability. List and classify local/message-platform sessions, manage lifecycle and bindings, submit explicit persistent calls, or exchange durable session mail.",
    promptGuidelines: [
      "Use role for reusable role definitions and anonymous calls; use session for persistent conversation continuity.",
      "session list is paginated and labels each surface as local or channel; use surface and adapter filters, then continue with offset when total exceeds the returned page.",
      "send/mailto append durable mail but never execute or wake the target session. Do not poll after sending.",
      "Message-platform sessions may use only list/get/send/mailto/inbox/read/ack. Their list/get/send targets are restricted to local sessions in the current workspace; forward execution requests with session send.",
      "inbox/read/ack are current-session-only.",
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
      toSessionId: Type.Optional(Type.String()),
      kind: Type.Optional(
        Type.String({ description: "request | inform | reply for send/mailto." }),
      ),
      intent: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Any()),
      correlationId: Type.Optional(Type.String()),
      replyToMessageId: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      messageId: Type.Optional(Type.String()),
      includeAcked: Type.Optional(Type.Boolean()),
    }),
    renderCall(args) {
      return new SessionToolCallText(
        [
          "session",
          typeof args.action === "string" ? `action=${args.action}` : "action=?",
          typeof args.sessionId === "string" ? args.sessionId : undefined,
          typeof args.surface === "string" ? `surface=${args.surface}` : undefined,
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
