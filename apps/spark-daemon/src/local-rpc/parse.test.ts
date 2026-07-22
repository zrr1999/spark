import { describe, expect, it } from "vitest";
import { parseLocalRpcRequest } from "./parse.ts";

describe("side-thread local RPC parsing", () => {
  it("maps each side-thread method to a validated transport command", () => {
    const cases = [
      ["side-thread.ensure", { parentSessionId: "parent" }, "side-thread.ensure.request"],
      ["side-thread.snapshot", { parentSessionId: "parent" }, "side-thread.snapshot.request"],
      [
        "side-thread.submit",
        {
          parentSessionId: "parent",
          expectedGeneration: 1,
          prompt: "inspect",
          idempotencyKey: "key",
        },
        "side-thread.submit.request",
      ],
      [
        "side-thread.reset",
        { parentSessionId: "parent", expectedGeneration: 1, mode: "tangent" },
        "side-thread.reset.request",
      ],
      [
        "side-thread.configure",
        { parentSessionId: "parent", expectedGeneration: 1, thinkingOverride: "low" },
        "side-thread.configure.request",
      ],
      [
        "side-thread.handoff",
        {
          parentSessionId: "parent",
          expectedGeneration: 1,
          expectedHeadExchangeId: "exchange",
          kind: "full",
          idempotencyKey: "key",
        },
        "side-thread.handoff.request",
      ],
    ] as const;

    for (const [method, params, kind] of cases) {
      const request = parseLocalRpcRequest(JSON.stringify({ id: method, method, params }));
      expect(request.sparkCommand).toMatchObject({ kind, route: { sessionId: "parent" } });
    }
  });
});
