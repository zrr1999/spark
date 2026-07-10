import { describe, expect, it } from "vitest";
import {
  parseSparkAuthFlow,
  parseSparkModelControlSnapshot,
  sparkDefaultModelSetRequestSchema,
} from "./model-control.ts";
import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionSetModelRequest,
} from "./session-assignment.ts";

const model = {
  providerName: "openai",
  modelId: "gpt-5-codex",
  providerLabel: "OpenAI",
  modelLabel: "GPT-5 Codex",
};

describe("Spark model-control protocol", () => {
  it("parses a provider catalog with default and session model selections", () => {
    const snapshot = parseSparkModelControlSnapshot({
      providers: [
        {
          providerName: "openai",
          label: "OpenAI",
          auth: {
            providerName: "openai",
            kind: "oauth",
            configured: true,
            source: "stored",
            reference: "openai-codex",
          },
          models: [
            {
              model,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 200_000,
              maxTokens: 32_000,
              available: true,
            },
          ],
        },
      ],
      defaultModel: model,
      session: { sessionId: "sess_demo", model },
    });

    expect(snapshot.providers[0]?.auth.reference).toBe("openai-codex");
    expect(snapshot.session?.model).toEqual(model);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("projects OAuth flow state without accepting credential fields", () => {
    const flow = parseSparkAuthFlow({
      id: "oauth_1",
      providerName: "openai",
      oauthProviderId: "openai-codex",
      status: "waiting_for_user",
      createdAt: "2026-07-10T06:00:00.000Z",
      updatedAt: "2026-07-10T06:00:01.000Z",
      authorization: { url: "https://example.com/oauth" },
      prompt: {
        id: "prompt_1",
        kind: "manual_code",
        message: "Enter the callback code",
        allowEmpty: false,
      },
      access: "must-not-cross-the-protocol",
      credentials: { refresh: "must-not-cross-the-protocol" },
    });

    expect(flow.status).toBe("waiting_for_user");
    expect(flow.progress).toEqual([]);
    expect(flow).not.toHaveProperty("access");
    expect(flow).not.toHaveProperty("credentials");
  });

  it("uses the same model ref for default and session set requests and records", () => {
    expect(sparkDefaultModelSetRequestSchema.parse({ model })).toEqual({ model });
    expect(parseSparkSessionSetModelRequest({ sessionId: "sess_demo", model })).toEqual({
      sessionId: "sess_demo",
      model,
    });
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_demo",
        workspaceId: "ws_demo",
        model,
        createdAt: "2026-07-10T06:00:00.000Z",
        updatedAt: "2026-07-10T06:00:00.000Z",
      }).model,
    ).toEqual(model);
  });
});
