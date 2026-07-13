import { describe, expect, it, vi } from "vitest";
import { createQqbotApiClient } from "./qqbot-api.ts";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("createQqbotApiClient", () => {
  it("caches access tokens until near expiry", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.getAccessToken("app", "secret")).resolves.toBe("tok");
    await expect(api.getAccessToken("app", "secret")).resolves.toBe("tok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends C2C messages with QQBot authorization", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
        });
      }
      expect(url).toContain("/v2/users/u1/messages");
      expect(init?.headers).toMatchObject({
        Authorization: "QQBot tok",
      });
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const api = createQqbotApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const token = await api.getAccessToken("app", "secret");
    await expect(api.sendC2CMessage(token, "u1", "hello", "src")).resolves.toEqual({ id: "m1" });
  });

  it("uses the sandbox OpenAPI host when configured", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
          status: 200,
        });
      }
      expect(url).toBe("https://sandbox.api.sgroup.qq.com/gateway");
      return new Response(JSON.stringify({ url: "wss://sandbox.example" }), { status: 200 });
    });
    const api = createQqbotApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: "https://sandbox.api.sgroup.qq.com",
    });
    const token = await api.getAccessToken("app", "secret");
    await expect(api.getGatewayUrl(token)).resolves.toBe("wss://sandbox.example");
  });
});
