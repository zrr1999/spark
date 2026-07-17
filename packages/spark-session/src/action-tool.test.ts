import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { executeSparkSessionAction } from "./action-tool.ts";
import { SparkSessionMailStore } from "./mail-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createMailStore(): Promise<SparkSessionMailStore> {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-action-"));
  roots.push(sparkHome);
  return new SparkSessionMailStore({ sparkHome });
}

function session(
  sessionId: string,
  bindings: SparkSessionRegistryRecord["bindings"] = [],
): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace-routing" },
    workspaceId: "workspace-routing",
    status: "ready",
    bindings,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("session list and inbox progressive disclosure", () => {
  it("pages whole compact session records with an explicit continuation", async () => {
    const longTitle = "x".repeat(600);
    const records = [
      { ...session("sess_first"), title: longTitle, updatedAt: "2026-07-15T02:00:00.000Z" },
      { ...session("sess_second"), title: "Second", updatedAt: "2026-07-15T01:00:00.000Z" },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return records;
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const first = await executeSparkSessionAction(
      {
        action: "list",
        toolCallId: "list-page-1",
        params: { limit: 1, offset: 0 },
        signal: new AbortController().signal,
        ctx: {},
      },
      { request: request as never },
    );
    const firstText = first.content[0]!.text;
    expect(firstText).toContain(`title=${JSON.stringify(longTitle)}`);
    expect(firstText).toContain("next offset=1; remaining=1; use session get for details.");
    expect(first.details).toMatchObject({ offset: 0, limit: 1, total: 2 });

    const second = await executeSparkSessionAction(
      {
        action: "list",
        toolCallId: "list-page-2",
        params: { limit: 1, offset: 1 },
        signal: new AbortController().signal,
        ctx: {},
      },
      { request: request as never },
    );
    expect(second.content[0]!.text).toContain("sess_second");
    expect(second.content[0]!.text).toContain("next offset=none; remaining=0");
  });

  it("pages whole inbox summaries and points to read for full details", async () => {
    const mailStore = await createMailStore();
    await mailStore.send({
      toSessionId: "sess_inbox",
      fromSessionId: "sess_sender",
      body: "first ".repeat(100),
    });
    await mailStore.send({
      toSessionId: "sess_inbox",
      fromSessionId: "sess_sender",
      body: "second detail",
    });

    const first = await executeSparkSessionAction(
      {
        action: "inbox",
        toolCallId: "inbox-page-1",
        params: { limit: 1, offset: 0 },
        signal: new AbortController().signal,
        ctx: { sessionId: "sess_inbox" },
      },
      { mailStore: () => mailStore },
    );
    const text = first.content[0]!.text;
    expect(text).toContain(
      "next offset=1; remaining=1; use session read for full message details.",
    );
    expect(text.split("\n")[1]!.length).toBeLessThan(300);
    expect(first.details).toMatchObject({ offset: 0, limit: 1, total: 2 });
  });
});

describe("persistent session channel routing", () => {
  it("locks an asynchronous request result to its originating adapter binding", async () => {
    const mailStore = await createMailStore();
    const origin = session("sess_origin", [
      { kind: "channel", adapter: "qqbot", externalKey: "qqbot:user:42" },
      { kind: "channel", adapter: "infoflow", externalKey: "infoflow:user:42" },
    ]);
    const worker = session("sess_worker");
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "session.get") {
        const sessionId = (params as { sessionId: string }).sessionId;
        return sessionId === origin.sessionId ? origin : worker;
      }
      if (method === "turn.submit") {
        return {
          invocationId: "inv_routing",
          status: "queued",
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      }
      if (method === "session.notification.deliver") {
        return {
          deliveries: [
            {
              adapter: "qqbot",
              externalKey: "qqbot:user:42",
              status: "pending",
              attemptCount: 0,
            },
          ],
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    await executeSparkSessionAction(
      {
        action: "send",
        toolCallId: "tool-routing",
        params: {
          toSessionId: worker.sessionId,
          kind: "request",
          message: "Investigate and report back",
        },
        signal: new AbortController().signal,
        ctx: {
          sessionId: origin.sessionId,
          sessionSurface: "channel",
          sessionSource: "channel",
          channelBinding: { adapter: "qqbot", externalKey: "qqbot:user:42" },
        },
      },
      { request: request as never, mailStore: () => mailStore },
    );

    const [requestMessage] = await mailStore.list(worker.sessionId, { includeAcked: true });
    expect(requestMessage?.originBinding).toEqual({
      adapter: "qqbot",
      externalKey: "qqbot:user:42",
    });

    await executeSparkSessionAction(
      {
        action: "send",
        toolCallId: "tool-routing-result",
        params: {
          replyToMessageId: requestMessage?.id,
          kind: "notification",
          message: "Research complete",
        },
        signal: new AbortController().signal,
        ctx: {
          sessionId: worker.sessionId,
          sessionSurface: "local",
          sessionSource: "session",
        },
      },
      { request: request as never, mailStore: () => mailStore },
    );

    const [resultMessage] = await mailStore.list(origin.sessionId, { includeAcked: true });
    expect(resultMessage?.deliveries).toEqual([
      expect.objectContaining({
        adapter: "qqbot",
        externalKey: "qqbot:user:42",
        status: "pending",
      }),
    ]);
    expect(resultMessage?.deliveries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ adapter: "infoflow" })]),
    );
  });
});
