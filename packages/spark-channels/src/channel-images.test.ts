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
