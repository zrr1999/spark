import { describe, expect, it } from "vitest";
import { normalizeInfoflowContent } from "./infoflow-content.ts";

describe("normalizeInfoflowContent", () => {
  it("keeps mixed text and mentions while replacing binary attachments with descriptors", () => {
    const normalized = normalizeInfoflowContent({
      messageType: "group.mixed",
      body: [
        { type: "AT", userid: "alice", name: "Alice" },
        { type: "TEXT", content: "请查看" },
        { type: "IMAGE", content: "a".repeat(2_000), downloadurl: "https://signed/image" },
        {
          type: "FILE",
          fileName: "report.pdf",
          fileType: "application/pdf",
          fid: "fid-1",
          downloadurl: "https://signed/file",
          size: 42,
        },
        { type: "VOICE", voiceText: "今天下午开会", downloadurl: "https://signed/voice" },
      ],
    });

    expect(normalized.text).toBe("@Alice 请查看\n[图片]\n[文件: report.pdf]\n[语音] 今天下午开会");
    expect(normalized.mentions).toEqual(["Alice"]);
    expect(normalized.attachments).toEqual([
      { kind: "image" },
      {
        kind: "file",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 42,
        reference: "fid-1",
      },
      { kind: "voice" },
    ]);
    expect(JSON.stringify(normalized)).not.toContain("https://signed");
    expect(normalized.text).not.toContain("a".repeat(100));
  });

  it("does not copy private image base64 into prompt text or metadata", () => {
    const normalized = normalizeInfoflowContent({
      messageType: "private.image",
      content: JSON.stringify({ content: "A".repeat(2_000), downloadurl: "https://signed" }),
    });

    expect(normalized).toEqual({
      text: "[图片]",
      contentType: "image",
      mentions: [],
      attachments: [{ kind: "image" }],
    });
  });

  it("preserves Markdown and flattens private rich text", () => {
    expect(
      normalizeInfoflowContent({ messageType: "private.markdown", content: "# 标题\n正文" }).text,
    ).toBe("# 标题\n正文");
    expect(
      normalizeInfoflowContent({
        messageType: "private.richtext",
        content: JSON.stringify({
          items: [
            { type: "text", text: "查看" },
            { type: "a", label: "文档", href: "https://example.test" },
          ],
        }),
      }).text,
    ).toBe("查看 文档");
  });

  it("keeps an unsupported message visible instead of dropping the turn", () => {
    expect(normalizeInfoflowContent({ messageType: "private.face" }).text).toBe("[如流消息: face]");
  });

  it("extracts quote/reply parts into messageReference without inlining into text", () => {
    const normalized = normalizeInfoflowContent({
      messageType: "group.mixed",
      body: [
        {
          type: "quote",
          text: "被引用原文",
          msgid: "m-1",
          msgid2: "m-2",
          uid: "bob",
          username: "Bob",
        },
        { type: "TEXT", content: "请继续" },
      ],
    });

    expect(normalized.text).toBe("请继续");
    expect(normalized.text).not.toContain(">");
    expect(normalized.messageReference).toEqual({
      messageId: "m-1",
      secondaryMessageId: "m-2",
      preview: "被引用原文",
      senderId: "bob",
      senderName: "Bob",
      source: "embedded",
    });
  });
});
