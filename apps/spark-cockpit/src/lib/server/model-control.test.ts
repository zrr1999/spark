import { describe, expect, it } from "vitest";
import {
  loadModelControlForCockpit,
  modelValue,
  parseModelValue,
  setSessionModelForCockpit,
  startProviderOAuthForCockpit,
  type CockpitModelControlClient,
} from "./model-control";

const model = { providerName: "baidu-oneapi", modelId: "ernie-4.5" };

describe("Cockpit model control adapter", () => {
  it("parses daemon catalog and session model responses", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const client: CockpitModelControlClient = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "session.model.set") {
          return {
            sessionId: "sess_demo",
            workspaceId: "ws_demo",
            model,
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:01:00.000Z",
          };
        }
        return {
          providers: [],
          defaultModel: model,
          session: { sessionId: "sess_demo", model },
        };
      },
    };

    const state = await loadModelControlForCockpit("sess_demo", client);
    const session = await setSessionModelForCockpit("sess_demo", model, client);

    expect(state.available).toBe(true);
    expect(state.snapshot.session?.model).toEqual(model);
    expect(session.model).toEqual(model);
    expect(calls).toEqual([
      { method: "model.catalog", params: { sessionId: "sess_demo" } },
      { method: "session.model.set", params: { sessionId: "sess_demo", model } },
    ]);
  });

  it("parses only the non-sensitive OAuth projection", async () => {
    const flow = await startProviderOAuthForCockpit("openai-codex", {
      request: async () => ({
        id: "flow_1",
        providerName: "openai-codex",
        status: "pending",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
        progress: [],
        accessToken: "must-not-survive",
      }),
    });

    expect(flow).not.toHaveProperty("accessToken");
  });

  it("uses one canonical provider/model form value", () => {
    expect(parseModelValue("baidu-oneapi/ernie-4.5")).toEqual(model);
    expect(modelValue(model)).toBe("baidu-oneapi/ernie-4.5");
    expect(() => parseModelValue("ernie-4.5")).toThrow(/provider\/model/u);
  });

  it("soft-fails catalog loads instead of throwing through the session page", async () => {
    const state = await loadModelControlForCockpit("sess_demo", {
      request: async () => {
        throw new Error("catalog unavailable");
      },
    });

    expect(state).toEqual({
      available: false,
      snapshot: { providers: [], diagnostics: [] },
      error: "catalog unavailable",
    });
  });
});
