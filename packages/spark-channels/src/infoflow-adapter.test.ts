import { describe, expect, it } from "vitest";
import { InfoflowAdapter } from "./infoflow-adapter.ts";
import { FakeChannelTransport } from "./transport.ts";

describe("InfoflowAdapter durable receipt dedupe", () => {
  it("passes provider-ready image blocks without exposing the signed URL", () => {
    const adapter = new InfoflowAdapter({
      id: "infoflow",
      config: { type: "infoflow" },
      transport: new FakeChannelTransport(),
    });
    const data = Buffer.from("image").toString("base64");
    const message = adapter.parseInbound({
      user_id: "alice",
      text: "[图片]",
      chat_type: "private",
      content_type: "image",
      attachments: [{ kind: "image", reference: "fid-1" }],
      images: [{ data, mediaType: "image/png", name: "photo.png" }],
    });

    expect(message).toMatchObject({
      text: "[图片]",
      attachments: [{ kind: "image", reference: "fid-1" }],
      images: [{ data, mediaType: "image/png", name: "photo.png" }],
    });
  });

  it("marks a message seen only after the receipt callback succeeds", async () => {
    const transport = new FakeChannelTransport();
    let attempts = 0;
    const adapter = new InfoflowAdapter({
      id: "infoflow",
      config: { type: "infoflow" },
      transport,
      onMessage: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("receipt unavailable");
      },
    });
    const raw = {
      user_id: "alice",
      text: "retry me",
      message_id: "message-1",
      chat_type: "private",
    };
    await adapter.start();

    expect(() => transport.emitInbound(raw)).toThrow("receipt unavailable");
    expect(() => transport.emitInbound(raw)).not.toThrow();
    transport.emitInbound(raw);
    expect(attempts).toBe(2);
    await adapter.stop();
  });
});
