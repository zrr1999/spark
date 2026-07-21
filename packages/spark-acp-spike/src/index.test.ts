import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, client, methods } from "@agentclientprotocol/sdk";

import { createSparkAcpAgent } from "./index.ts";

describe("spark-acp-spike", () => {
  it("initializes, opens a session, and answers a prompt in-process", async () => {
    const updates: string[] = [];
    const { app, sessions } = createSparkAcpAgent({ name: "spark-acp-spike-test" });

    const host = client({ name: "spark-acp-spike-test-client" }).onNotification(
      methods.client.session.update,
      (ctx) => {
        const update = ctx.params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          updates.push(update.content.text);
        }
      },
    );

    await host.connectWith(app, async (agentCtx) => {
      const init = await agentCtx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "spark-acp-spike-test-client", version: "0.0.0" },
      });
      expect(init.agentInfo?.name).toBe("spark-acp-spike-test");

      await agentCtx
        .buildSession({ cwd: "/tmp/spark-acp-spike", mcpServers: [] })
        .withSession(async (session) => {
          expect(sessions.get(session.sessionId)?.cwd).toBe("/tmp/spark-acp-spike");
          const result = await session.prompt("hello from ACP client");
          expect(result.stopReason).toBe("end_turn");
        });
    });

    expect(updates.some((text) => text.includes("hello from ACP client"))).toBe(true);
    expect(updates.some((text) => text.includes("Daemon turn.submit is not wired"))).toBe(true);
  });
});
