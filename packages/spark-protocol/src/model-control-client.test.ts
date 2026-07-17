import { describe, expect, it } from "vitest";
import {
  createSparkModelControlClient,
  parseSparkModelValue,
  sparkModelValue,
} from "./model-control-client.ts";

describe("spark model control client", () => {
  it("routes catalog and session setters through one method table", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client = createSparkModelControlClient(
      async (method, params) => {
        calls.push({ method, params });
        if (method === "session.model.set") {
          return {
            sessionId: "sess_demo",
            workspaceId: "ws_demo",
            model: { providerName: "openai", modelId: "gpt" },
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
          };
        }
        return {
          providers: [],
          defaultModel: { providerName: "openai", modelId: "gpt" },
          session: {
            sessionId: "sess_demo",
            model: { providerName: "openai", modelId: "gpt" },
          },
        };
      },
      { sessionId: "sess_demo" },
    );

    const snapshot = await client.snapshot();
    const session = await client.setSessionModel({ providerName: "openai", modelId: "gpt" });

    expect(snapshot.session?.model).toEqual({ providerName: "openai", modelId: "gpt" });
    expect(session.model).toEqual({ providerName: "openai", modelId: "gpt" });
    expect(calls).toEqual([
      { method: "model.catalog", params: { sessionId: "sess_demo" } },
      {
        method: "session.model.set",
        params: { sessionId: "sess_demo", model: { providerName: "openai", modelId: "gpt" } },
      },
    ]);
  });

  it("parses provider/model values", () => {
    expect(parseSparkModelValue("openai/gpt-5")).toEqual({
      providerName: "openai",
      modelId: "gpt-5",
    });
    expect(sparkModelValue({ providerName: "openai", modelId: "gpt-5" })).toBe("openai/gpt-5");
  });
});
