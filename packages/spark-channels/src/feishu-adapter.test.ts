import { describe, expect, it } from "vitest";
import { FeishuAdapter } from "./feishu-adapter.ts";
import { FakeChannelTransport } from "./transport.ts";

describe("FeishuAdapter quote parsing", () => {
  it("parses parent_id and reply preview into messageReference", () => {
    const adapter = new FeishuAdapter({
      id: "feishu",
      config: { type: "feishu", app_id: "app", app_secret: "secret" },
      transport: new FakeChannelTransport(),
    });
    const message = adapter.parseInbound({
      chat_id: "oc_1",
      sender_id: "ou_1",
      message_id: "om_reply",
      text: "跟进一下",
      parent_id: "om_parent",
      reply: {
        message_id: "om_parent",
        text: "原始任务说明",
        sender_name: "Alice",
      },
    });
    expect(message.text).toBe("跟进一下");
    expect(message.messageReference).toEqual({
      messageId: "om_parent",
      preview: "原始任务说明",
      senderName: "Alice",
      source: "embedded",
    });
  });
});
