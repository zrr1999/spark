import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInfoflowTransport,
  normalizeInfoflowInbound,
  signInfoflowAppSecret,
} from "./infoflow-transport.ts";

void describe("infoflow transport", () => {
  void it("signs app secrets as lowercase md5 hex", () => {
    assert.equal(signInfoflowAppSecret("secret"), "5ebe2294ecd0e0f08eab7690d2a6ee69");
  });

  void it("fetches a token and sends a private text message", async () => {
    const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        body,
        ...(headers.get("Authorization")
          ? { authorization: headers.get("Authorization") ?? undefined }
          : {}),
      });
      if (url.endsWith("/api/v1/auth/app_access_token")) {
        return new Response(
          JSON.stringify({
            code: "ok",
            data: { app_access_token: "tok_demo", expire: 7200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: "ok", data: { msgkey: "mk_1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        endpoint: "https://api.im.baidu.com",
        app_key: "key",
        app_secret: "secret",
        app_agent_id: "19690",
      },
      { fetchImpl },
    );

    await transport.send("alice", "hello from spark");
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /\/api\/v1\/auth\/app_access_token$/);
    assert.deepEqual(calls[0]?.body, {
      app_key: "key",
      app_secret: signInfoflowAppSecret("secret"),
    });
    assert.match(calls[1]?.url ?? "", /\/api\/v1\/app\/message\/send$/);
    assert.equal(calls[1]?.authorization, "Bearer-tok_demo");
    assert.deepEqual(calls[1]?.body, {
      touser: "alice",
      msgtype: "text",
      text: { content: "hello from spark" },
      agentid: "19690",
    });
  });

  void it("sends group messages with nyakore payload shape", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url.endsWith("/api/v1/auth/app_access_token")) {
        return new Response(
          JSON.stringify({
            code: "ok",
            data: { app_access_token: "tok_demo", expire: 7200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: "ok", data: { errcode: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        endpoint: "https://api.im.baidu.com",
        app_key: "key",
        app_secret: "secret",
        app_agent_id: "19690",
      },
      { fetchImpl },
    );

    await transport.send("group:10838226", "group reply");
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.url ?? "", /\/api\/v1\/robot\/msg\/groupmsgsend$/);
    const body = calls[1]?.body as {
      message?: { header?: Record<string, unknown>; body?: unknown };
    };
    assert.equal(body.message?.header?.toid, 10838226);
    assert.equal(body.message?.header?.totype, "GROUP");
    assert.equal(body.message?.header?.msgtype, "TEXT");
    assert.deepEqual(body.message?.body, [{ type: "TEXT", content: "group reply" }]);
  });

  void it("fails when nested data.errcode is non-zero", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.endsWith("/api/v1/auth/app_access_token")) {
        return new Response(
          JSON.stringify({
            code: "ok",
            data: { app_access_token: "tok_demo", expire: 7200 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          code: "ok",
          data: { errcode: 40000, errmsg: "lack param. header or body is null" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const transport = createInfoflowTransport(
      {
        type: "infoflow",
        endpoint: "https://api.im.baidu.com",
        app_key: "key",
        app_secret: "secret",
      },
      { fetchImpl },
    );

    await assert.rejects(
      () => transport.send("group:1", "x"),
      /lack param\. header or body is null/,
    );
  });

  void it("normalizes private and group inbound payloads", () => {
    assert.deepEqual(
      normalizeInfoflowInbound({
        FromUserId: "alice",
        Content: "hi",
        MsgId: "1",
      }),
      { user_id: "alice", text: "hi", chat_type: "private", message_id: "1" },
    );
    assert.deepEqual(
      normalizeInfoflowInbound({
        groupid: 42,
        message: {
          header: { fromuserid: "bob", msgid: "9", msgtype: "text" },
          body: [{ type: "TEXT", content: "group hi" }],
        },
      }),
      {
        user_id: "bob",
        text: "group hi",
        chat_type: "group",
        chat_id: "42",
        message_id: "9",
      },
    );
    assert.deepEqual(
      normalizeInfoflowInbound({
        groupid: 42,
        message: {
          header: { fromuserid: "bob", msgid: "10", msgtype: "mixed" },
          body: [
            { type: "AT", name: "spark-bot" },
            { type: "TEXT", content: " 什么关系？" },
          ],
        },
      }),
      {
        user_id: "bob",
        text: "@spark-bot 什么关系？",
        chat_type: "group",
        chat_id: "42",
        message_id: "10",
      },
    );
  });
});
