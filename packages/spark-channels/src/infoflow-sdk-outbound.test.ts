import { describe, expect, it, vi } from "vitest";
import { createInfoflowSdkOutbound, type InfoflowSdkClientLike } from "./infoflow-sdk-outbound.ts";
import { channelDeliveryFailureCertainty, channelDeliveryNotSent } from "./reply.ts";

function fakeClient() {
  const sendToUser = vi.fn(
    async (
      _userId: string,
      _content: string | { content: string },
      _msgtype?: "text" | "md" | "image" | "richtext",
      _reply?: Array<{ content: string; uid: string; msgid: string; msgid2: string }>,
    ) => ({ msgkey: "private-key" }),
  );
  const sendToGroup = vi.fn(async () => ({ messageid: "group-id", msgseqid: "group-seq" }));
  const sendToGroupWithOptions = vi.fn(async () => ({
    messageid: "group-options-id",
    msgseqid: "group-options-seq",
  }));
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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
  return JSON.parse(init.body) as unknown;
}

describe("Infoflow SDK outbound", () => {
  it("sends private Markdown and image content through the SDK message API", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    const markdown = await outbound.sendWithReceipt!({
      recipient: "alice",
      content: { type: "markdown", text: "# Hello" },
    });
    const image = await outbound.sendWithReceipt!({
      recipient: "alice",
      content: { type: "image", base64: "iVBORw0KGgo=" },
    });

    expect(markdown).toEqual({
      replaySafety: "unsafe",
      receipt: { messageKey: "private-key" },
    });
    expect(image).toEqual({
      replaySafety: "unsafe",
      receipt: { messageKey: "private-key" },
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

    const result = await outbound.sendWithReceipt!({
      recipient: "group:10838226",
      content: { type: "markdown", text: "**处理完成**" },
      mentionUserIds: [" zhanrongrui ", "zhanrongrui"],
      reply: {
        messageId: "1870315656716618699",
        preview: "请处理",
        robotImId: "4105004371",
      },
    });

    expect(result).toEqual({
      replaySafety: "unsafe",
      receipt: { messageId: "group-options-id", messageSequence: "group-options-seq" },
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

    const error = await outbound
      .send({
        recipient: "group:1",
        content: { type: "text", text: "reply" },
        reply: { messageId: "msg", preview: "source" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("reply.robotImId");
    expect(channelDeliveryFailureCertainty(error)).toBe("not-sent");
    expect(fake.sendToGroup).not.toHaveBeenCalled();
  });

  it("keeps injected provider failures unknown after dispatch", async () => {
    const fake = fakeClient();
    fake.sendToUser.mockRejectedValueOnce(new Error("response timeout"));
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });

    const error = await outbound
      .send({ recipient: "alice", content: { type: "text", text: "hello" } })
      .catch((caught: unknown) => caught);

    expect(channelDeliveryFailureCertainty(error)).toBe("unknown");
    expect(fake.sendToUser).toHaveBeenCalledTimes(1);
  });

  it("uses one SDK MessageApi fetch attempt and returns its private receipt", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init });
      return new Response(JSON.stringify({ code: "ok", data: { msgkey: "message-key-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const accessTokenProvider = vi.fn(async () => "access-token-1");
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider,
    });

    await expect(
      outbound.sendWithReceipt!({ recipient: "alice", content: { type: "text", text: "hello" } }),
    ).resolves.toEqual({
      replaySafety: "unsafe",
      receipt: { messageKey: "message-key-1" },
    });

    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = requests[0];
    expect(request?.url).toBe("https://api.im.baidu.com/api/v1/app/message/send");
    expect(request?.init?.method).toBe("POST");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer-access-token-1");
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(requestBody(request?.init)).toEqual({
      touser: "alice",
      msgtype: "text",
      agentid: "43163",
      text: { content: "hello" },
    });
  });

  it("marks token failures not-sent without starting a message fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider: async () => {
        throw new Error("token unavailable");
      },
    });

    const error = await outbound
      .send({ recipient: "alice", content: { type: "text", text: "hello" } })
      .catch((caught: unknown) => caught);

    expect(channelDeliveryFailureCertainty(error)).toBe("not-sent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry or claim not-sent after the message fetch starts", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset after request write");
    });
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider: async () => "access-token-1",
    });

    const error = await outbound
      .send({ recipient: "alice", content: { type: "text", text: "hello" } })
      .catch((caught: unknown) => caught);

    expect(channelDeliveryFailureCertainty(error)).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves large group receipt ids through the single-attempt transport", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '{"code":"ok","data":{"data":{"messageid":1870319810785709055,"msgseqid":1870319810785709056}}}',
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider: async () => "access-token-1",
    });

    await expect(
      outbound.sendWithReceipt!({
        recipient: "group:10838226",
        content: { type: "markdown", text: "**done**" },
      }),
    ).resolves.toEqual({
      replaySafety: "unsafe",
      receipt: {
        messageId: "1870319810785709055",
        messageSequence: "1870319810785709056",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("opens an SDK StreamingCardSession and fails closed when card start is ambiguous", async () => {
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
    expect(fake.stream.appendReasoning).toHaveBeenCalledWith("正在处理");
    expect(fake.stream.appendText).not.toHaveBeenCalledWith("正在处理");
    await stream!.complete("已完成");
    expect(fake.stream.complete).toHaveBeenCalledWith("已完成");

    fake.stream.start.mockResolvedValueOnce(false);
    const error = await outbound
      .openReplyStream("alice", { answerFormat: "text" })
      .catch((caught: unknown) => caught);
    expect(channelDeliveryFailureCertainty(error)).toBe("unknown");
    expect((error as Error).message).toContain("streaming card create outcome is unknown");
  });

  it("uses one streaming-card create attempt and never falls back after a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("response timeout after request write");
    });
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider: async () => "access-token-1",
    });

    const error = await outbound.openReplyStream("alice").catch((caught: unknown) => caught);

    expect(channelDeliveryFailureCertainty(error)).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("opens a stream through the real single-attempt StreamingCardApi integration", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: requestUrl(input), init });
      return new Response(
        JSON.stringify({ code: "ok", data: { modify_token: "modify-token-success" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const accessTokenProvider = vi.fn(async () => "access-token-1");
    const outbound = createInfoflowSdkOutbound(config, {
      fetch: fetchImpl as unknown as typeof fetch,
      accessTokenProvider,
    });

    const stream = await outbound.openReplyStream("alice");

    expect(stream).toBeTruthy();
    expect(stream?.answerMode).toBe("inline");
    expect(stream?.deliveryRecovery).toMatchObject({
      kind: "infoflow.streaming-card.v1",
      data: { to: "alice", modifyToken: "modify-token-success" },
    });
    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url.endsWith("/msg/sender/interactivity_msg")).toBe(true);
    expect(requests[0]?.init?.method).toBe("POST");
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

  it("keeps a readable prefix on recovery without replaying ambiguous overflow", async () => {
    const fake = fakeClient();
    Object.assign(fake.stream, { modifyToken: "modify-token-1", groupVersion: 114 });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("alice");
    const long = `${"前".repeat(5_000)}**本段加粗**${"后".repeat(2_000)}`;
    expect(long.length).toBeGreaterThan(6_000);

    await outbound.recoverReply({
      recipient: "alice",
      text: long,
      recovery: stream!.deliveryRecovery!,
    });

    expect(fake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.objectContaining({
          ai_markdown: { type: "text", content: expect.stringMatching(/^前/) },
        }),
      }),
    );
    const updateInput = fake.update.mock.calls[0]?.[0];
    expect(updateInput).toBeDefined();
    const cardText = (updateInput as { contents: { ai_markdown: { content: string } } }).contents
      .ai_markdown.content;
    expect(cardText.length).toBeLessThanOrEqual(6_000);
    expect(cardText.startsWith("前")).toBe(true);
    expect(cardText).toContain("Spark Cockpit");
    expect(cardText).toContain("**本段加粗**");
    expect(fake.sendToUser).not.toHaveBeenCalled();
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

  it("retries the final flush when a throttled update races complete", async () => {
    const fake = fakeClient();
    let attempts = 0;
    let finalCalls = 0;
    const sessionState = fake.stream as typeof fake.stream & {
      isFlushing: boolean;
      flushQueued: boolean;
      flushNow: (opts: { final?: boolean; doneLabel?: string }) => Promise<void>;
      cancelFlushTimer: () => void;
      updateFailCount: number;
      failed: boolean;
      done: boolean;
      answerText: string;
    };
    sessionState.isFlushing = false;
    sessionState.flushQueued = false;
    sessionState.updateFailCount = 0;
    sessionState.failed = false;
    sessionState.done = false;
    sessionState.answerText = "";
    sessionState.cancelFlushTimer = vi.fn();
    sessionState.flushNow = vi.fn(async (opts) => {
      attempts += 1;
      if (opts.final && attempts === 1) {
        // Reproduce the SDK race: complete() arrived while a flush was in flight.
        sessionState.flushQueued = true;
        return;
      }
      if (opts.final) finalCalls += 1;
      sessionState.flushQueued = false;
    });

    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("zhanrongrui");
    stream?.appendText("可见前半本");
    stream?.appendText("与后半结束标记");
    await expect(stream?.complete("已完成")).resolves.toBeUndefined();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(finalCalls).toBe(1);
    expect(sessionState.answerText).toContain("可见前半本");
    expect(sessionState.answerText).toContain("与后半结束标记");
  });

  it("finalizes long Chinese markdown with one ordinary overflow mutation", async () => {
    const fake = fakeClient();
    Object.assign(fake.stream, { modifyToken: "modify-token-long", groupVersion: 111 });
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("alice");
    const long = `${"甲".repeat(3_500)}\n\n**本**段加粗\n\n${"乙".repeat(3_500)}`;
    stream?.appendText(long.slice(0, 1_800));
    stream?.appendText(long.slice(1_800, 3_600));
    stream?.appendText(long.slice(3_600));
    await stream!.complete("已完成");

    expect(fake.stream.complete).toHaveBeenCalled();
    expect((fake.stream as { answerText?: string }).answerText?.startsWith("甲")).toBe(true);
    expect(((fake.stream as { answerText?: string }).answerText ?? "").length).toBeLessThanOrEqual(
      6_000,
    );
    expect((fake.stream as { answerText?: string }).answerText).toContain("Spark Cockpit");
    expect(fake.sendToUser).toHaveBeenCalledTimes(1);
    const body = fake.sendToUser.mock.calls[0]?.[1];
    const overflow = typeof body === "string" ? body : body?.content;
    expect(overflow).toContain("乙");
  });

  it("keeps answers within the card limit inline without an unnecessary follow-up", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("alice");
    const answer = "正".repeat(5_999);
    stream?.appendText(answer);

    await stream?.complete("已完成");

    expect((fake.stream as { answerText?: string }).answerText).toBe(answer);
    expect(fake.sendToUser).not.toHaveBeenCalled();
  });

  it("sends long ordinary markdown exactly once without silently truncating", async () => {
    const fake = fakeClient();
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const long = `${"短".repeat(100)}**本**${"文".repeat(6_000)}`;
    await outbound.send({
      recipient: "alice",
      content: { type: "markdown", text: long },
    });
    expect(fake.sendToUser).toHaveBeenCalledTimes(1);
    expect(fake.sendToUser).toHaveBeenCalledWith("alice", { content: long }, "md", undefined);
  });

  it("keeps an overflow failure outcome unknown after the card already exists", async () => {
    const fake = fakeClient();
    fake.sendToUser.mockRejectedValueOnce(channelDeliveryNotSent(new Error("token unavailable")));
    const outbound = createInfoflowSdkOutbound(config, { createClient: () => fake.client });
    const stream = await outbound.openReplyStream("alice");
    stream?.appendText("长".repeat(7_000));

    const error = await stream?.complete("已完成").catch((caught: unknown) => caught);

    expect(channelDeliveryFailureCertainty(error)).toBe("unknown");
    expect(fake.stream.complete).toHaveBeenCalledTimes(1);
    expect(fake.sendToUser).toHaveBeenCalledTimes(1);
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
