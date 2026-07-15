import { describe, expect, it } from "vitest";
import { validateSparkDaemonTask } from "./types.ts";

describe("daemon task validation", () => {
  it("preserves normalized channel context without folding it into the prompt", () => {
    expect(
      validateSparkDaemonTask({
        type: "session.run",
        sessionId: " sess_infoflow ",
        prompt: "  human body stays exact  ",
        cwd: "/workspace/frozen",
        thinkingLevel: "high",
        messageMetadata: {
          origin: { kind: "session", sessionId: "session:sender", host: "web" },
          sessionMail: { messageId: "mail:1" },
        },
        channelContext: {
          externalKey: " infoflow:group:10838226 ",
          senderId: " zhanrongrui ",
          chatId: " 10838226 ",
          messageId: " m1 ",
          contentType: " mixed ",
          attachments: [
            { kind: "file", name: " plan.pdf ", reference: " fid-plan " },
            { kind: "unknown", url: "https://signed.invalid" },
          ],
          mentions: [" 神经蛙 ", ""],
          mentionedSelf: true,
        },
      }),
    ).toMatchObject({
      sessionId: "sess_infoflow",
      prompt: "  human body stays exact  ",
      cwd: "/workspace/frozen",
      thinkingLevel: "high",
      messageMetadata: {
        origin: { kind: "session", sessionId: "session:sender", host: "web" },
        sessionMail: { messageId: "mail:1" },
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        chatId: "10838226",
        messageId: "m1",
        contentType: "mixed",
        attachments: [{ kind: "file", name: "plan.pdf", reference: "fid-plan" }],
        mentions: ["神经蛙"],
        mentionedSelf: true,
      },
    });
  });

  it("rejects malformed message metadata instead of silently dropping it", () => {
    expect(() =>
      validateSparkDaemonTask({
        type: "session.run",
        sessionId: "session-a",
        prompt: "hello",
        messageMetadata: "not-an-object",
      }),
    ).toThrow("daemon task messageMetadata must be an object");
  });
});
