import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { parseSparkInteractionRequest } from "@zendev-lab/spark-protocol";
import { SparkDaemonHumanWaitRegistry } from "../core/human-waits.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import type { DaemonChannelIngressRuntime } from "./ingress.ts";
import {
  projectChannelAsk,
  settleChannelAskInteraction,
  settleChannelAskTextReply,
} from "./human-interactions.ts";

describe("daemon channel human interactions", () => {
  it("projects a daemon ask to a sender-scoped QQ keyboard", async () => {
    const sendAsk = vi.fn(async () => ({}));
    const channelIngress = { sendAsk } as unknown as DaemonChannelIngressRuntime;
    const db = daemonDatabase();
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      const registration = waits.register({
        humanRequestId: "hreq_projection",
        delivery: "async",
        kind: "ask_user",
        title: "Choose a route",
        prompt: "Which route?",
        context: {},
      });
      const request = parseSparkInteractionRequest({
        kind: "askFlow",
        requestId: "ask_projection",
        title: "Choose a route",
        delivery: "async",
        questions: [
          {
            id: "route",
            type: "single",
            prompt: "Which route?",
            options: [
              { value: "fast", label: "Fast", description: "Prefer latency." },
              { value: "safe", label: "Safe" },
            ],
          },
        ],
      });
      if (request.kind !== "askFlow") throw new Error("expected askFlow request");

      await projectChannelAsk(channelIngress, {
        wait: registration.wait,
        request,
        channel: {
          workspaceId: "ws_1",
          adapterId: "qqbot",
          recipient: "group:group_1",
          actorId: "user_1",
          messageId: "msg_source",
        },
        callbackOptions: [
          {
            token: "opaque_fast",
            questionId: "route",
            value: "fast",
            label: "Fast",
            description: "Prefer latency.",
          },
          {
            token: "opaque_safe",
            questionId: "route",
            value: "safe",
            label: "Safe",
          },
        ],
      });

      expect(sendAsk).toHaveBeenCalledWith(
        "ws_1",
        "qqbot",
        "group:group_1",
        expect.objectContaining({
          audience: { kind: "users", userIds: ["user_1"] },
          messageId: "msg_source",
          options: [
            { id: "1", label: "Fast", data: "opaque_fast" },
            { id: "2", label: "Safe", data: "opaque_safe" },
          ],
        }),
      );
    } finally {
      db.close();
    }
  });

  it("projects an Infoflow ask as durable text and settles a numbered private reply", async () => {
    const sendAsk = vi.fn(async () => ({}));
    const channelIngress = { sendAsk } as unknown as DaemonChannelIngressRuntime;
    const db = daemonDatabase();
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      const registration = waits.register({
        humanRequestId: "hreq_infoflow",
        workspaceBindingId: "rtwb_1",
        workspaceId: "ws_1",
        delivery: "blocking",
        kind: "ask_user",
        title: "Choose a route",
        prompt: "Which route?",
        questions: [
          {
            id: "route",
            type: "single",
            prompt: "Which route?",
            required: true,
            options: [
              { value: "fast", label: "Fast", description: "Prefer latency." },
              { value: "safe", label: "Safe" },
            ],
          },
        ],
        context: {
          channel: {
            workspaceId: "ws_1",
            adapterId: "infoflow",
            recipient: "alice",
            actorId: "alice",
          },
          channelCallbacks: {
            opaque_fast: { questionId: "route", value: "fast", label: "Fast" },
            opaque_safe: { questionId: "route", value: "safe", label: "Safe" },
          },
        },
      });
      const request = parseSparkInteractionRequest({
        kind: "askFlow",
        requestId: "ask_infoflow",
        title: "Choose a route",
        delivery: "blocking",
        questions: [
          {
            id: "route",
            type: "single",
            prompt: "Which route?",
            options: [
              { value: "fast", label: "Fast", description: "Prefer latency." },
              { value: "safe", label: "Safe" },
            ],
          },
        ],
      });
      if (request.kind !== "askFlow") throw new Error("expected askFlow request");

      await projectChannelAsk(channelIngress, {
        wait: registration.wait,
        request,
        channel: {
          workspaceId: "ws_1",
          adapterId: "infoflow",
          recipient: "alice",
          actorId: "alice",
        },
        callbackOptions: [
          {
            token: "opaque_fast",
            questionId: "route",
            value: "fast",
            label: "Fast",
            description: "Prefer latency.",
          },
          {
            token: "opaque_safe",
            questionId: "route",
            value: "safe",
            label: "Safe",
          },
        ],
      });

      expect(sendAsk).toHaveBeenCalledWith(
        "ws_1",
        "infoflow",
        "alice",
        expect.objectContaining({
          prompt: expect.stringContaining("1. Fast — Prefer latency."),
          options: [
            { id: "1", label: "Fast", data: "opaque_fast" },
            { id: "2", label: "Safe", data: "opaque_safe" },
          ],
        }),
      );

      await expect(
        settleChannelAskTextReply(
          waits,
          {
            workspaceId: "ws_1",
            recipient: "alice",
            message: {
              adapter: "infoflow",
              externalKey: "infoflow:default:alice",
              text: "1",
              messageId: "msg_missing_actor",
            },
          },
          { runtimeId: "rt_test" },
        ),
      ).resolves.toBe("continue");
      expect(waits.get("hreq_infoflow")?.status).toBe("pending");

      await expect(
        settleChannelAskTextReply(
          waits,
          {
            workspaceId: "ws_1",
            recipient: "alice",
            message: {
              adapter: "infoflow",
              externalKey: "infoflow:default:alice",
              senderId: "alice",
              text: "1",
              messageId: "msg_reply_1",
            },
          },
          { runtimeId: "rt_test" },
        ),
      ).resolves.toBe("settled");

      expect(waits.get("hreq_infoflow")?.status).toBe("answered");
      const stored = db
        .prepare(
          "SELECT response_json AS responseJson FROM daemon_human_waits WHERE human_request_id = ?",
        )
        .get("hreq_infoflow") as { responseJson: string };
      expect(JSON.parse(stored.responseJson)).toMatchObject({ answers: { route: "fast" } });

      await expect(
        settleChannelAskTextReply(
          waits,
          {
            workspaceId: "ws_1",
            recipient: "alice",
            message: {
              adapter: "infoflow",
              externalKey: "infoflow:default:alice",
              senderId: "alice",
              text: "2",
              messageId: "msg_reply_2",
            },
          },
          { runtimeId: "rt_test" },
        ),
      ).resolves.toBe("continue");
    } finally {
      db.close();
    }
  });

  it("settles an Infoflow freeform ask from ordinary private text without starting another turn", async () => {
    const db = daemonDatabase();
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq_freeform",
        workspaceBindingId: "rtwb_1",
        workspaceId: "ws_1",
        delivery: "async",
        kind: "ask_user",
        title: "Name it",
        prompt: "What should we call this?",
        questions: [
          { id: "name", type: "freeform", prompt: "What should we call this?", required: true },
        ],
        context: {
          channel: {
            workspaceId: "ws_1",
            adapterId: "infoflow",
            recipient: "alice",
            actorId: "alice",
          },
        },
      });

      await expect(
        settleChannelAskTextReply(
          waits,
          {
            workspaceId: "ws_1",
            recipient: "alice",
            message: {
              adapter: "infoflow",
              externalKey: "infoflow:default:alice",
              senderId: "alice",
              text: "spark-alpha",
              messageId: "msg_freeform",
            },
          },
          { runtimeId: "rt_test" },
        ),
      ).resolves.toBe("settled");

      const stored = db
        .prepare(
          "SELECT status, response_json AS responseJson FROM daemon_human_waits WHERE human_request_id = ?",
        )
        .get("hreq_freeform") as { status: string; responseJson: string };
      expect(stored.status).toBe("answered");
      expect(JSON.parse(stored.responseJson)).toMatchObject({
        answers: { name: { values: [], customText: "spark-alpha" } },
      });
    } finally {
      db.close();
    }
  });

  it("accepts one valid callback, replays the same event, and rejects competing clicks", async () => {
    const ackInteraction = vi.fn(
      async (
        _workspaceId: string,
        _adapterId: string,
        _interactionId: string,
        _status?: Parameters<DaemonChannelIngressRuntime["ackInteraction"]>[3],
      ) => undefined,
    );
    const channelIngress = { ackInteraction } as unknown as DaemonChannelIngressRuntime;
    const db = daemonDatabase();
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq_callback",
        workspaceBindingId: "rtwb_1",
        workspaceId: "ws_1",
        delivery: "async",
        kind: "ask_user",
        title: "Choose",
        prompt: "Choose",
        context: {
          channel: {
            workspaceId: "ws_1",
            adapterId: "qq-main",
            recipient: "c2c:user_1",
            actorId: "user_1",
          },
          channelCallbacks: {
            opaque_safe: { questionId: "route", value: "safe", label: "Safe" },
          },
        },
      });
      const input = {
        workspaceId: "ws_1",
        event: {
          adapter: "qqbot" as const,
          adapterId: "qq-main",
          interactionId: "interaction_1",
          actorId: "user_1",
          scene: "c2c" as const,
          recipient: "c2c:user_1",
          buttonData: "opaque_safe",
        },
      };

      await settleChannelAskInteraction(channelIngress, waits, input, { runtimeId: "rt_test" });
      await settleChannelAskInteraction(channelIngress, waits, input, { runtimeId: "rt_test" });
      await settleChannelAskInteraction(
        channelIngress,
        waits,
        {
          ...input,
          event: { ...input.event, interactionId: "interaction_2" },
        },
        { runtimeId: "rt_test" },
      );

      expect(ackInteraction.mock.calls.map((call) => call[3])).toEqual([
        "success",
        "success",
        "duplicate",
      ]);
      const stored = db
        .prepare(
          "SELECT status, response_json AS responseJson FROM daemon_human_waits WHERE human_request_id = ?",
        )
        .get("hreq_callback") as { status: string; responseJson: string };
      expect(stored.status).toBe("answered");
      expect(JSON.parse(stored.responseJson)).toMatchObject({ answers: { route: "safe" } });
      const outbox = db
        .prepare("SELECT kind, payload_json AS payloadJson FROM outbox")
        .all() as Array<{ kind: string; payloadJson: string }>;
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.kind).toBe("human.response.recorded");
      expect(JSON.parse(outbox[0]!.payloadJson)).toMatchObject({
        type: "human.response.recorded",
        runtimeId: "rt_test",
        humanRequestId: "hreq_callback",
        payload: { source: "channel", status: "answered", answers: { route: "safe" } },
      });
    } finally {
      db.close();
    }
  });

  it("rejects unknown tokens and a different actor without settling the wait", async () => {
    const ackInteraction = vi.fn(
      async (
        _workspaceId: string,
        _adapterId: string,
        _interactionId: string,
        _status?: Parameters<DaemonChannelIngressRuntime["ackInteraction"]>[3],
      ) => undefined,
    );
    const channelIngress = { ackInteraction } as unknown as DaemonChannelIngressRuntime;
    const db = daemonDatabase();
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq_forbidden",
        delivery: "async",
        kind: "ask_user",
        title: "Choose",
        prompt: "Choose",
        context: {
          channel: {
            workspaceId: "ws_1",
            adapterId: "qq-main",
            recipient: "group:group_1",
            actorId: "user_1",
          },
          channelCallbacks: {
            opaque_safe: { questionId: "route", value: "safe", label: "Safe" },
          },
        },
      });
      const event = {
        adapter: "qqbot" as const,
        adapterId: "qq-main",
        interactionId: "interaction_bad",
        actorId: "user_2",
        scene: "group" as const,
        recipient: "group:group_1",
        buttonData: "opaque_safe",
      };

      await settleChannelAskInteraction(
        channelIngress,
        waits,
        {
          workspaceId: "ws_1",
          event,
        },
        { runtimeId: "rt_test" },
      );
      await settleChannelAskInteraction(
        channelIngress,
        waits,
        {
          workspaceId: "ws_1",
          event: { ...event, actorId: "user_1", buttonData: "unknown" },
        },
        { runtimeId: "rt_test" },
      );
      await settleChannelAskInteraction(
        channelIngress,
        waits,
        {
          workspaceId: "ws_1",
          event: { ...event, actorId: "user_1", recipient: undefined },
        },
        { runtimeId: "rt_test" },
      );

      expect(ackInteraction.mock.calls.map((call) => call[3])).toEqual([
        "forbidden",
        "forbidden",
        "forbidden",
      ]);
      expect(waits.get("hreq_forbidden")?.status).toBe("pending");
    } finally {
      db.close();
    }
  });
});

function daemonDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return db;
}
