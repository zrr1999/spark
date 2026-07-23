import { describe, expect, it } from "vitest";
import {
  sparkSessionMailMessageSchema,
  sparkSessionSendRequestSchema,
  sparkSessionSendResultSchema,
} from "./session-mail.ts";

const request = {
  toSessionId: "sess_worker",
  fromSessionId: "sess_origin",
  kind: "request" as const,
  intent: "work.request",
  payload: { body: "investigate" },
  idempotencyKey: "session.send:sess_origin:tool-1",
  body: "investigate",
  origin: { surface: "local" as const, host: "session" as const },
};

const message = {
  id: "mail:1",
  toSessionId: "sess_worker",
  fromSessionId: "sess_origin",
  kind: "request" as const,
  visibility: "internal" as const,
  delivery: "mailbox" as const,
  deliveries: [],
  intent: "work.request",
  payload: { body: "investigate" },
  correlationId: "corr:1",
  replyToMessageId: null,
  idempotencyKey: "session.send:sess_origin:tool-1",
  subject: null,
  body: "investigate",
  createdAt: "2026-07-23T00:00:00.000Z",
  readAt: null,
  ackedAt: null,
  source: "tool" as const,
  requestAdmission: {
    status: "accepted" as const,
    invocationId: "inv_1",
    acceptedAt: "2026-07-23T00:00:01.000Z",
    updatedAt: "2026-07-23T00:00:01.000Z",
  },
};

describe("session mail protocol", () => {
  it("keeps send admission as one daemon-owned RPC contract", () => {
    expect(sparkSessionSendRequestSchema.parse(request)).toMatchObject({
      kind: "request",
      notifyOnCompletion: false,
      source: "tool",
    });
    expect(sparkSessionMailMessageSchema.parse(message).requestAdmission).toMatchObject({
      status: "accepted",
      invocationId: "inv_1",
    });
  });

  it("requires an invocation receipt when execution was triggered", () => {
    expect(
      sparkSessionSendResultSchema.parse({
        message,
        filePath: "/tmp/mailbox.json",
        created: true,
        executionTriggered: true,
        target: {
          sessionId: "sess_worker",
          scope: { kind: "workspace", workspaceId: "workspace-1" },
          status: "ready",
          bindings: [],
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
        submitted: {
          invocationId: "inv_1",
          status: "queued",
          acceptedAt: "2026-07-23T00:00:01.000Z",
        },
      }).submitted,
    ).toMatchObject({ invocationId: "inv_1" });
  });
});
