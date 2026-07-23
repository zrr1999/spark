import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_IMAGE_MAX_BYTES,
  materializeChannelImages,
  normalizeChannelImage,
} from "./channel-images.ts";

describe("channel images", () => {
  const safeLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }] as const);

  it("normalizes data URLs into provider-ready image blocks", async () => {
    const [image] = await materializeChannelImages([
      {
        data: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
        name: "demo.png",
      },
    ]);

    expect(image).toEqual({
      data: Buffer.from("png-bytes").toString("base64"),
      mediaType: "image/png",
      name: "demo.png",
    });
  });

  it("downloads HTTPS images with MIME and byte limits", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/webp", "Content-Length": "3" },
        }),
    );

    const [image] = await materializeChannelImages(
      [{ url: "https://multimedia.nt.qq.com/image", mediaType: "image/jpeg" }],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHostname: safeLookup,
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://multimedia.nt.qq.com/image", {
      method: "GET",
      redirect: "manual",
    });
    expect(image).toEqual({
      data: Buffer.from([1, 2, 3]).toString("base64"),
      mediaType: "image/webp",
    });
    expect(safeLookup).toHaveBeenCalledWith("multimedia.nt.qq.com");
  });

  it("rejects a public-looking hostname resolving to metadata or private addresses", async () => {
    const fetchImpl = vi.fn();
    const onError = vi.fn();

    const images = await materializeChannelImages(
      [{ url: "https://media.example/image", mediaType: "image/png" }],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHostname: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        onError,
      },
    );

    expect(images).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "channel image URL must not target a local or private address",
    });
  });

  it("allows one transport-owned private media endpoint with per-hop authentication", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const mediaUrl = "https://apiin.im.baidu.com/api/v2/im/images?imgKey=opaque";

    const images = await materializeChannelImages([{ url: mediaUrl, mediaType: "image/png" }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHostname: async () => [{ address: "10.11.154.217", family: 4 }],
      isTrustedPrivateUrl: (url) =>
        url.hostname === "apiin.im.baidu.com" && url.pathname === "/api/v2/im/images",
      requestHeaders: async (url) =>
        url.hostname === "apiin.im.baidu.com" ? { Authorization: "Bearer-test-token" } : undefined,
    });

    expect(images).toEqual([
      {
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        mediaType: "image/png",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(mediaUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: "Bearer-test-token" },
    });
  });

  it("revalidates DNS on redirects before issuing the next request", async () => {
    const fetchImpl = vi.fn(async () => Response.redirect("https://media.example/next", 302));
    const lookupHostname = vi
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const onError = vi.fn();

    const images = await materializeChannelImages(
      [{ url: "https://media.example/image", mediaType: "image/png" }],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHostname,
        onError,
      },
    );

    expect(images).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupHostname).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "channel image URL must not target a local or private address",
    });
  });

  it("rejects IPv4-mapped loopback addresses", async () => {
    const fetchImpl = vi.fn();
    const onError = vi.fn();

    const images = await materializeChannelImages(
      [{ url: "https://media.example/image", mediaType: "image/png" }],
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHostname: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
        onError,
      },
    );

    expect(images).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("drops private URLs and oversized persisted values", async () => {
    const onError = vi.fn();
    const images = await materializeChannelImages(
      [{ url: "https://127.0.0.1/private", mediaType: "image/png" }],
      { onError },
    );

    expect(images).toEqual([]);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      message: "channel image URL must not target a local or private address",
    });
    expect(
      normalizeChannelImage({
        data: Buffer.alloc(CHANNEL_IMAGE_MAX_BYTES + 1).toString("base64"),
        mediaType: "image/png",
      }),
    ).toBeUndefined();
  });
});
