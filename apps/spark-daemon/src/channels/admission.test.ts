import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/spark-channels";
import type { SparkDaemonTask } from "../core/types.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  channelInboundInvocationIdempotencyKey,
  legacyChannelInboundInvocationIdempotencyKey,
  submitChannelInboundInvocation,
} from "./admission.ts";
import { createChannelIngressController, type ChannelIngressAssignment } from "./ingress.ts";

interface ReplayCase {
  name: string;
  adapter: "infoflow" | "qqbot";
  externalKey: string;
  config: ReturnType<typeof parseChannelsConfig>;
  raw(messageId?: string): unknown;
}

const replayCases: ReplayCase[] = [
  {
    name: "Infoflow",
    adapter: "infoflow",
    externalKey: "infoflow:user:user-private",
    config: parseChannelsConfig({
      adapters: { infoflow: { type: "infoflow" } },
      routes: {},
      ingress: { enabled: true, on_unbound: "reject" },
    }),
    raw: (messageId) => ({
      user_id: "user-private",
      text: `message ${messageId ?? "without-id"}`,
      ...(messageId ? { message_id: messageId } : {}),
    }),
  },
  {
    name: "QQ",
    adapter: "qqbot",
    externalKey: "qqbot:c2c:user-private",
    config: parseChannelsConfig({
      adapters: { qqbot: { type: "qqbot", app_id: "app", client_secret: "secret" } },
      routes: {},
      ingress: { enabled: true, on_unbound: "reject" },
    }),
    raw: (messageId) => ({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        ...(messageId ? { id: messageId } : {}),
        content: `message ${messageId ?? "without-id"}`,
        author: { user_openid: "user-private" },
      },
    }),
  },
];

describe("channel inbound durable admission", () => {
  for (const replayCase of replayCases) {
    it(`deduplicates ${replayCase.name} replay from overlapping ingress transports`, async () => {
      const root = await mkdtemp(join(tmpdir(), "spark-channel-admission-"));
      const databasePath = join(root, "daemon.sqlite");
      const firstDb = new DatabaseSync(databasePath);
      migrateSparkDaemonDatabase(firstDb);
      const secondDb = new DatabaseSync(databasePath);
      migrateSparkDaemonDatabase(secondDb);
      const firstStore = new SparkInvocationStore(firstDb);
      const secondStore = new SparkInvocationStore(secondDb);
      const firstTransport = new FakeChannelTransport();
      const secondTransport = new FakeChannelTransport();
      const invocationIds: string[] = [];
      const session = {
        sessionId: `session-${replayCase.name.toLowerCase()}`,
        scope: { kind: "workspace" as const, workspaceId: "ws-overlap" },
        workspaceId: "ws-overlap",
        status: "ready" as const,
        bindings: [
          {
            kind: "channel" as const,
            adapter: replayCase.adapter,
            externalKey: replayCase.externalKey,
          },
        ],
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      };
      const resolveBinding = vi.fn(async () => session);
      const createAssignmentHandler =
        (store: SparkInvocationStore) => async (assignment: ChannelIngressAssignment) => {
          const task: SparkDaemonTask = {
            type: "session.run",
            sessionId: assignment.sessionId,
            prompt: assignment.goal,
            assignment: assignment.assignment,
            workspaceId: "ws-overlap",
            cwd: "/workspace",
            channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          };
          invocationIds.push(submitChannelInboundInvocation(store, assignment, task).invocationId);
        };
      const createController = (transport: FakeChannelTransport, store: SparkInvocationStore) =>
        createChannelIngressController({
          sparkHome: "/unused",
          config: replayCase.config,
          hooks: { onAssignment: createAssignmentHandler(store) },
          sessionRegistry: { resolveBinding },
          workspaceId: "ws-overlap",
          createTransport: () => transport,
        });
      const first = createController(firstTransport, firstStore);
      const second = createController(secondTransport, secondStore);

      try {
        await Promise.all([first.start(), second.start()]);
        firstTransport.emitInbound(replayCase.raw("platform-message-1"));
        secondTransport.emitInbound(replayCase.raw("platform-message-1"));
        await vi.waitFor(() => expect(invocationIds).toHaveLength(2));

        firstTransport.emitInbound(replayCase.raw("platform-message-2"));
        await vi.waitFor(() => expect(invocationIds).toHaveLength(3));

        expect(invocationIds[1]).toBe(invocationIds[0]);
        expect(invocationIds[2]).not.toBe(invocationIds[0]);
        expect(firstStore.listPage({ limit: 10 })).toMatchObject({ total: 2 });

        const records = firstStore.listPage({ limit: 10 }).invocations;
        expect(records.every((record) => record.sourceKind === "channel")).toBe(true);
        for (const record of records) {
          expect(record.idempotencyKey).not.toContain("user-private");
          expect(record.idempotencyKey).not.toContain("platform-message");
        }
      } finally {
        await Promise.all([first.stop(), second.stop()]);
        secondDb.close();
        firstDb.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("returns the original invocation when mutable admission projection has drifted", () => {
    const assignment = {
      sessionId: "session-original",
      goal: "original message",
      assignment: {
        goal: "original message",
        target: { sessionId: "session-original", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: {
          kind: "channel",
          channel: "qqbot",
          externalRef: "platform-message-stable",
        },
      },
      source: {
        kind: "channel",
        channel: "qqbot",
        externalRef: "platform-message-stable",
      },
      externalKey: "qqbot:c2c:user-private",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
      channelReply: {
        adapter: "qqbot" as const,
        workspaceId: "ws-overlap",
        adapterId: "qqbot",
        recipient: "c2c:user-private",
        externalKey: "qqbot:test:frozen",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-private",
        senderId: "user-private",
        messageId: "platform-message-stable",
      },
    } satisfies ChannelIngressAssignment;
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const originalTask: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        model: "provider/original",
        cwd: "/workspace/original",
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
        channelContext: assignment.channelContext,
      };
      const replayProjection: SparkDaemonTask = {
        ...originalTask,
        sessionId: "session-raced-binding",
        model: "provider/new-default",
        cwd: "/workspace/new",
      };

      const first = submitChannelInboundInvocation(store, assignment, originalTask);
      const replay = submitChannelInboundInvocation(store, assignment, replayProjection);

      expect(replay.invocationId).toBe(first.invocationId);
      expect(replay.task).toEqual(originalTask);
    } finally {
      db.close();
    }
  });

  it("accepts a matching v1 admission after upgrade without collapsing another account", () => {
    const assignment = {
      sessionId: "session-account-a",
      goal: "account scoped message",
      assignment: {
        goal: "account scoped message",
        target: { sessionId: "session-account-a", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: {
          kind: "channel",
          channel: "qqbot",
          externalRef: "shared-message-id",
        },
      },
      source: { kind: "channel", channel: "qqbot", externalRef: "shared-message-id" },
      externalKey: "qqbot:c2c:shared-user",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
      channelReply: {
        adapter: "qqbot" as const,
        workspaceId: "ws-overlap",
        adapterId: "qqbot-account-a",
        externalKey: "qqbot:c2c:shared-user",
        recipient: "c2c:shared-user",
      },
      channelContext: {
        externalKey: "qqbot:c2c:shared-user",
        senderId: "shared-user",
        messageId: "shared-message-id",
      },
    } satisfies ChannelIngressAssignment;
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const task: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        cwd: "/workspace",
        // v1 rows predate stable account identity, but retained the configured adapter id.
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
        channelContext: assignment.channelContext,
      };
      const legacyKey = legacyChannelInboundInvocationIdempotencyKey(assignment);
      expect(legacyKey).toMatch(/^channel\.inbound:v1:[a-f0-9]{64}$/u);
      const legacy = store.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
        sourceKind: "channel",
        idempotencyKey: legacyKey,
      });

      expect(submitChannelInboundInvocation(store, assignment, task).invocationId).toBe(
        legacy.invocationId,
      );

      const otherAccount = {
        ...assignment,
        sessionId: "session-account-b",
        adapterAccountIdentity: "channel-account:qqbot:account-b",
        channelReply: { ...assignment.channelReply, adapterId: "qqbot-account-b" },
      } satisfies ChannelIngressAssignment;
      const otherTask: SparkDaemonTask = {
        ...task,
        sessionId: otherAccount.sessionId,
        channelReply: {
          ...otherAccount.channelReply,
          externalKey: otherAccount.externalKey,
          adapterAccountIdentity: otherAccount.adapterAccountIdentity,
        },
      };
      const admitted = submitChannelInboundInvocation(store, otherAccount, otherTask);
      expect(admitted.invocationId).not.toBe(legacy.invocationId);
      expect(admitted.idempotencyKey).toMatch(/^channel\.inbound:v2:[a-f0-9]{64}$/u);
      expect(store.listPage({ limit: 10 }).total).toBe(2);
    } finally {
      db.close();
    }
  });

  it("keeps messages without a platform id on the non-idempotent path", () => {
    const assignment = {
      sessionId: "session-no-id",
      goal: "message without id",
      assignment: {
        goal: "message without id",
        target: { sessionId: "session-no-id", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: { kind: "channel", channel: "infoflow" },
      },
      source: { kind: "channel", channel: "infoflow" },
      externalKey: "infoflow:user:user-private",
      channelReply: {
        adapter: "infoflow" as const,
        workspaceId: "ws-overlap",
        adapterId: "infoflow",
        externalKey: "infoflow:user:user-private",
        recipient: "user-private",
      },
    } satisfies ChannelIngressAssignment;

    expect(channelInboundInvocationIdempotencyKey(assignment)).toBeUndefined();

    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const task: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        cwd: "/workspace",
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
      };
      const first = submitChannelInboundInvocation(store, assignment, task);
      const second = submitChannelInboundInvocation(store, assignment, task);
      expect(second.invocationId).not.toBe(first.invocationId);
    } finally {
      db.close();
    }
  });
});
