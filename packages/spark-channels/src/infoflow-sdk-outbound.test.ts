import { describe, expect, it, vi } from "vitest";
import {
  createInfoflowSdkOutbound,
  type InfoflowSdkClientLike,
  type InfoflowReplyStream,
} from "./infoflow-sdk-outbound.ts";

function fakeClient() {
  const sendToUser = vi.fn(async () => ({}));
  const sendToGroup = vi.fn(async () => ({}));
  const sendToGroupWithOptions = vi.fn(async () => ({}));
  const start = vi.fn<() => Promise<boolean>>(async () => true);
  const stream: InfoflowReplyStream & { start: typeof start } = {
    start,
    appendText: vi.fn(),
    notifyToolStart: vi.fn(),
    notifyToolResult: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const createSession = vi.fn(() => stream);
  const client: InfoflowSdkClientLike = {
    im: {
      message: { sendToUser, sendToGroup, sendToGroupWithOptions },
      streamingCard: { createSession },
    },
  };
  return { client, sendToUser, sendToGroup, sendToGroupWithOptions, createSession, stream };
}

const config = {
  type: "infoflow" as const,
  app_key: "key",
  app_secret: "secret",
  app_agent_id: "43163",
};

describe("Infoflow SDK outbound", () => {
  it("sends private Markdown and image content through the SDK message API", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    await outbound.send({
      recipient: "alice",
      content: { type: "markdown", text: "# Hello" },
    });
    await outbound.send({
      recipient: "alice",
      content: { type: "image", base64: "iVBORw0KGgo=" },
    });

    expect(fake.sendToUser).toHaveBeenNthCalledWith(
      1,
      "alice",
      { content: "# Hello" },
      "md",
      undefined,
    );
    expect(fake.sendToUser).toHaveBeenNthCalledWith(
      2,
      "alice",
      { content: "iVBORw0KGgo=" },
      "image",
      undefined,
    );
  });

  it("sends group mentions and quotes through sendToGroupWithOptions", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    await outbound.send({
      recipient: "group:10838226",
      content: { type: "markdown", text: "**处理完成**" },
      mentionUserIds: [" zhanrongrui ", "zhanrongrui"],
      reply: {
        messageId: "1870315656716618699",
        preview: "请处理",
        robotImId: "4105004371",
      },
    });

    expect(fake.sendToGroupWithOptions).toHaveBeenCalledWith({
      groupId: "10838226",
      msgtype: "MD",
      body: [
        { type: "AT", atall: false, atuserids: ["zhanrongrui"] },
        { type: "MD", content: "**处理完成**" },
      ],
      reply: {
        messageid: "1870315656716618699",
        preview: "请处理",
        imid: "4105004371",
      },
    });
  });

  it("rejects incomplete quote metadata instead of guessing platform ids", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    await expect(
      outbound.send({
        recipient: "group:1",
        content: { type: "text", text: "reply" },
        reply: { messageId: "msg", preview: "source" },
      }),
    ).rejects.toThrow("reply.robotImId");
    expect(fake.sendToGroup).not.toHaveBeenCalled();
  });

  it("opens an SDK StreamingCardSession and returns undefined when card start fails", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    await expect(outbound.openReplyStream("group:10838226")).resolves.toBe(fake.stream);
    expect(fake.createSession).toHaveBeenCalledWith({
      to: "group:10838226",
      answerFormat: "markdown",
    });

    fake.stream.start.mockResolvedValueOnce(false);
    await expect(outbound.openReplyStream("alice", { answerFormat: "text" })).resolves.toBe(
      undefined,
    );
  });
});
