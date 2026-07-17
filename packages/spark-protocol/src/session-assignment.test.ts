import { describe, expect, it } from "vitest";
import {
  parseSparkSessionRegistryRecord,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
} from "./session-assignment.ts";

const timestamps = {
  createdAt: "2026-07-10T06:00:00.000Z",
  updatedAt: "2026-07-10T06:00:01.000Z",
};

describe("session ownership protocol", () => {
  it("normalizes legacy workspaceId-only records into canonical workspace scope", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_legacy",
        workspaceId: "ws_legacy",
        ...timestamps,
      }),
    ).toMatchObject({
      sessionId: "sess_legacy",
      scope: { kind: "workspace", workspaceId: "ws_legacy" },
      workspaceId: "ws_legacy",
    });
  });

  it("represents daemon-global records without a synthetic workspace", () => {
    const record = parseSparkSessionRegistryRecord({
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "spark-daemon-install-test" },
      ...timestamps,
    });
    expect(record.scope).toEqual({
      kind: "daemon",
      daemonId: "spark-daemon-install-test",
    });
    expect(record).not.toHaveProperty("workspaceId");
  });

  it("lets clients request daemon scope but rejects a client-supplied daemonId", () => {
    expect(sparkSessionCreateRequestSchema.parse({ scope: { kind: "daemon" } })).toEqual({
      scope: { kind: "daemon" },
    });
    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "daemon", daemonId: "spoofed-installation" },
      }),
    ).toThrow();
    expect(
      sparkSessionListRequestSchema.parse({
        scope: { kind: "daemon" },
        cursor: "sess_cursor",
        limit: 100,
      }),
    ).toEqual({
      scope: { kind: "daemon" },
      cursor: "sess_cursor",
      limit: 100,
    });
    expect(() =>
      sparkSessionListRequestSchema.parse({ scope: { kind: "daemon" }, limit: 101 }),
    ).toThrow();
  });
});
