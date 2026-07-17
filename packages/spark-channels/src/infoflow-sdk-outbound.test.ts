import { describe, expect, it, vi } from "vitest";
import { createInfoflowSdkOutbound, type InfoflowSdkClientLike } from "./infoflow-sdk-outbound.ts";

function fakeClient() {
  const sendToUser = vi.fn(async () => ({}));
  const sendToGroup = vi.fn(async () => ({}));
  const sendToGroupWithOptions = vi.fn(async () => ({}));
  const update = vi.fn(
    async (_input: unknown): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
  );
  const start = vi.fn<() => Promise<boolean>>(async () => true);
  const stream = {
    start,
    appendText: vi.fn(),
    appendReasoning: vi.fn(),
    notifyToolStart: vi.fn(),
    notifyToolResult: vi.fn(),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  } satisfies ReturnType<InfoflowSdkClientLike["im"]["streamingCard"]["createSession"]>;
  const createSession = vi.fn(() => stream);
  const client: InfoflowSdkClientLike = {
    im: {
      message: { sendToUser, sendToGroup, sendToGroupWithOptions },
      streamingCard: { createSession, update },
    },
  };
  return {
    client,
    sendToUser,
    sendToGroup,
    sendToGroupWithOptions,
    createSession,
    update,
    stream,
  };
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

    const stream = await outbound.openReplyStream("group:10838226");
    expect(stream).toBeTruthy();
    expect(stream?.answerMode).toBe("inline");
    expect(fake.createSession).toHaveBeenCalledWith({
      to: "group:10838226",
      answerFormat: "markdown",
    });
    stream?.appendProgress?.("正在处理");
    expect(fake.stream.appendText).toHaveBeenCalledWith("正在处理");
    await stream!.complete("已完成");
    expect(fake.stream.complete).toHaveBeenCalledWith("已完成");

    fake.stream.start.mockResolvedValueOnce(false);
    await expect(outbound.openReplyStream("alice", { answerFormat: "text" })).resolves.toBe(
      undefined,
    );
  });

  it("recovers an interrupted completion by updating the same streaming card", async () => {
    const fake = fakeClient();
    Object.assign(fake.stream, { modifyToken: "modify-token-1", groupVersion: 114 });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("group:10838226");
    expect(stream?.deliveryRecovery).toMatchObject({
      kind: "infoflow.streaming-card.v1",
      data: {
        to: "group:10838226",
        modifyToken: "modify-token-1",
        answerFormat: "markdown",
      },
    });

    await outbound.recoverReply({
      recipient: "group:10838226",
      text: "最终答案",
      recovery: stream!.deliveryRecovery!,
    });

    expect(fake.update).toHaveBeenCalledWith({
      to: "group:10838226",
      modifyToken: "modify-token-1",
      contents: expect.objectContaining({
        ai_markdown: { type: "text", content: "最终答案" },
        dc_print_end: { type: "text", content: "1" },
      }),
      groupVersion: expect.any(Number),
    });
  });

  it("rejects recovery when the platform refuses the same-card update", async () => {
    const fake = fakeClient();
    Object.assign(fake.stream, { modifyToken: "modify-token-1", groupVersion: 114 });
    fake.update.mockResolvedValueOnce({ ok: false, error: "stale card version" });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("group:10838226");

    await expect(
      outbound.recoverReply({
        recipient: "group:10838226",
        text: "最终答案",
        recovery: stream!.deliveryRecovery!,
      }),
    ).rejects.toThrow("Infoflow stream recovery failed: stale card version");
  });

  it("does not report completion while the SDK final update has failed", async () => {
    const fake = fakeClient();
    const sessionState = fake.stream as typeof fake.stream & {
      updateFailCount: number;
    };
    sessionState.updateFailCount = 0;
    fake.stream.complete.mockImplementationOnce(async () => {
      sessionState.updateFailCount = 1;
    });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("zhanrongrui");

    await expect(stream?.complete("已完成")).rejects.toThrow(
      "Infoflow stream completion update failed",
    );
  });

  it("waits for an in-flight SDK update before finalizing the stream", async () => {
    const fake = fakeClient();
    const sessionState = fake.stream as typeof fake.stream & { isFlushing: boolean };
    sessionState.isFlushing = true;
    fake.stream.complete.mockImplementationOnce(async () => {
      expect(sessionState.isFlushing).toBe(false);
    });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("zhanrongrui");

    setTimeout(() => {
      sessionState.isFlushing = false;
    }, 0);
    await expect(stream?.complete("已完成")).resolves.toBeUndefined();
  });

  it("opens process details with the outer disclosure and keeps final labels distinct", async () => {
    const buildContents = vi.fn((opts: { final?: boolean; doneLabel?: string; error?: string }) => {
      const label = opts.doneLabel ?? "思考完成";
      return {
        status_info: { type: "text", content: label },
        think_status_text: { type: "text", content: label },
      };
    });
    const start = vi.fn(async () => true);
    const session = {
      start,
      appendText: vi.fn(),
      appendReasoning: vi.fn(),
      notifyToolStart: vi.fn(),
      notifyToolResult: vi.fn(),
      complete: vi.fn(async function (
        this: { buildContents: typeof buildContents },
        label?: string,
      ) {
        this.buildContents({ final: true, doneLabel: label ?? "思考完成" });
      }),
      fail: vi.fn(async () => undefined),
      buildContents,
    };
    const outbound = createInfoflowSdkOutbound(config, {
      createClient: () =>
        ({
          im: {
            message: {
              sendToUser: vi.fn(),
              sendToGroup: vi.fn(),
              sendToGroupWithOptions: vi.fn(),
            },
            streamingCard: {
              createSession: () => session,
              update: vi.fn(async () => ({ ok: true })),
            },
          },
        }) as InfoflowSdkClientLike,
    });

    const stream = await outbound.openReplyStream("alice");
    expect(stream).toBeTruthy();

    const streamingContents = session.buildContents({}) as Record<
      string,
      { type: string; content: string }
    >;
    expect(streamingContents.status_info_1_install?.content).toBe("1");
    expect(streamingContents.flex_item_status_info_1_install?.content).toBe("1");

    await stream!.complete("已完成");

    expect(session.complete).toHaveBeenCalledWith("已完成");
    expect(buildContents).toHaveBeenCalled();
    const contents = buildContents.mock.results.at(-1)?.value as Record<
      string,
      { type: string; content: string }
    >;
    expect(contents.think_status_text?.content).toBe("已完成");
    expect(contents.status_info?.content).toBe("处理过程");
    expect(contents.status_info?.content).not.toBe(contents.think_status_text?.content);
    expect(contents.status_info_1_install?.content).toBe("1");
    expect(contents.flex_item_status_info_1_install?.content).toBe("1");
  });
});
