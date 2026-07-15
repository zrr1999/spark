import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  SparkDaemonHumanWaitRegistry,
  type SparkDaemonHumanWaitDelivery,
  type SparkDaemonHumanWaitInput,
} from "./human-waits.ts";

function createHarness(): { db: DatabaseSync; waits: SparkDaemonHumanWaitRegistry } {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, waits: new SparkDaemonHumanWaitRegistry(db) };
}

function waitInput(
  humanRequestId: string,
  delivery: SparkDaemonHumanWaitDelivery = "async",
  context: Record<string, unknown> = {},
): SparkDaemonHumanWaitInput {
  return {
    humanRequestId,
    interactionRequestId: `interaction-${humanRequestId}`,
    sessionId: "session-1",
    invocationId: "invocation-1",
    workspaceBindingId: "binding-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    toolCallId: "tool-call-1",
    delivery,
    kind: "ask_user",
    title: "Choose",
    prompt: "Continue?",
    context,
  };
}

describe("SparkDaemonHumanWaitRegistry", () => {
  it("registers async asks without a suspended Promise and persists a pending outbox", () => {
    const { db, waits } = createHarness();
    try {
      const envelope = {
        type: "human.request.created",
        humanRequestId: "hreq-async",
        payload: { title: "Choose" },
      };
      const registration = waits.register(waitInput("hreq-async"), {
        messageId: "message-async",
        kind: "human.request.created",
        envelope,
      });

      expect("response" in registration).toBe(false);
      expect(registration.response).toBeUndefined();
      expect(registration.wait).toMatchObject({
        humanRequestId: "hreq-async",
        delivery: "async",
        status: "pending",
      });
      expect(waits.hasActive("hreq-async")).toBe(false);
      expect(waits.listPending()).toMatchObject([
        { humanRequestId: "hreq-async", status: "pending" },
      ]);
      expect(waits.listPendingOutbox()).toEqual([
        {
          messageId: "message-async",
          kind: "human.request.created",
          envelope,
        },
      ]);

      expect(waits.acknowledgeOutbox("message-async")).toBe(true);
      expect(waits.acknowledgeOutbox("message-async")).toBe(false);
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(db.prepare("SELECT status FROM outbox WHERE id = ?").get("message-async")).toEqual({
        status: "acked",
      });
    } finally {
      db.close();
    }
  });

  it("rolls back the request row when the matching outbox insert fails", () => {
    const { db, waits } = createHarness();
    try {
      waits.register(waitInput("hreq-first"), {
        messageId: "duplicate-message",
        kind: "human.request.created",
        envelope: { request: "first" },
      });

      expect(() =>
        waits.register(waitInput("hreq-rolled-back"), {
          messageId: "duplicate-message",
          kind: "human.request.created",
          envelope: { request: "second" },
        }),
      ).toThrow();

      expect(waits.get("hreq-rolled-back")).toBeNull();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM daemon_human_waits WHERE human_request_id = ?")
          .get("hreq-rolled-back"),
      ).toEqual({ count: 0 });
      expect(waits.listPendingOutbox()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("uses a first-writer CAS and replays only the winning response id", () => {
    const { db, waits } = createHarness();
    try {
      waits.register(waitInput("hreq-race"));

      const accepted = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-winner",
        status: "answered",
        answers: { decision: "yes" },
      });
      const competing = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-loser",
        status: "answered",
        answers: { decision: "no" },
      });
      const replay = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-winner",
        status: "answered",
        answers: { decision: "tampered" },
      });

      expect(accepted).toMatchObject({
        outcome: "accepted",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(competing).toMatchObject({
        outcome: "already_resolved",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(replay).toMatchObject({
        outcome: "replayed",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(
        db
          .prepare(
            `SELECT status, accepted_response_id AS acceptedResponseId
             FROM daemon_human_waits WHERE human_request_id = ?`,
          )
          .get("hreq-race"),
      ).toEqual({ status: "answered", acceptedResponseId: "response-winner" });
    } finally {
      db.close();
    }
  });

  it("distinguishes an attached blocking continuation from an orphaned one", async () => {
    const { db, waits } = createHarness();
    try {
      const attached = waits.register(waitInput("hreq-attached", "blocking"));
      expect(attached.response).toBeDefined();
      expect(waits.hasActive("hreq-attached")).toBe(true);

      const attachedResult = waits.deliver({
        humanRequestId: "hreq-attached",
        humanResponseId: "response-attached",
        status: "answered",
        answers: { decision: "yes" },
      });
      await expect(attached.response).resolves.toMatchObject({
        humanResponseId: "response-attached",
        answers: { decision: "yes" },
      });
      expect(attachedResult).toMatchObject({
        outcome: "accepted",
        returnedToTool: true,
      });
      expect(waits.hasActive("hreq-attached")).toBe(false);

      waits.register(waitInput("hreq-orphaned", "blocking"));
      const restarted = new SparkDaemonHumanWaitRegistry(db);
      expect(restarted.hasActive("hreq-orphaned")).toBe(false);
      expect(
        restarted.deliver({
          humanRequestId: "hreq-orphaned",
          humanResponseId: "response-orphaned",
          status: "answered",
          answers: { decision: "yes" },
        }),
      ).toMatchObject({
        outcome: "orphaned",
        returnedToTool: false,
        winnerResponseId: "response-orphaned",
      });
      expect(restarted.get("hreq-orphaned")).toMatchObject({ status: "answered" });
    } finally {
      db.close();
    }
  });

  it("looks up opaque callback tokens without parsing their contents", () => {
    const { db, waits } = createHarness();
    try {
      const token = "opaque.token/with:+symbols==";
      waits.register(
        waitInput("hreq-callback", "async", {
          channelCallbacks: {
            [token]: {
              questionId: "decision",
              value: "continue",
              label: "Continue",
            },
            [`${token}-other`]: {
              questionId: "decision",
              value: "stop",
              label: "Stop",
            },
          },
        }),
      );

      expect(waits.findCallback(token)).toMatchObject({
        wait: { humanRequestId: "hreq-callback", status: "pending" },
        questionId: "decision",
        value: "continue",
        label: "Continue",
      });
      expect(waits.findCallback(`${token}.missing`)).toBeNull();
      expect(waits.findCallback("")).toBeNull();
    } finally {
      db.close();
    }
  });
});
