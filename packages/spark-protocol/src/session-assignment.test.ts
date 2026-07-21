import { describe, expect, it } from "vitest";
import {
  parseSparkSessionRegistryRecord,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionUnbindRequestSchema,
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

  it("preserves configured and stable account identities on channel bindings", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_channel",
        scope: { kind: "workspace", workspaceId: "ws_channel" },
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            adapterId: "info-main",
            adapterAccountIdentity: "channel-account:infoflow:account-a",
            externalKey: "infoflow:user:alice",
          },
        ],
        ...timestamps,
      }),
    ).toMatchObject({
      bindings: [
        {
          adapterId: "info-main",
          adapterAccountIdentity: "channel-account:infoflow:account-a",
        },
      ],
    });
    expect(
      sparkSessionBindRequestSchema.parse({
        sessionId: "sess_channel",
        externalKey: "infoflow:user:alice",
        adapterId: "info-main",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).toMatchObject({ adapterId: "info-main", adapterAccountIdentity: expect.any(String) });
    expect(
      sparkSessionUnbindRequestSchema.parse({
        sessionId: "sess_channel",
        externalKey: "infoflow:user:alice",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).toMatchObject({ adapterAccountIdentity: "channel-account:infoflow:account-a" });
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

  it("rejects mismatched workspace ids and normalizes list legacy workspaceId", () => {
    expect(() =>
      parseSparkSessionRegistryRecord({
        sessionId: "sess_mismatch",
        scope: { kind: "workspace", workspaceId: "ws_a" },
        workspaceId: "ws_b",
        createdAt: "2026-07-10T06:00:00.000Z",
        updatedAt: "2026-07-10T06:00:01.000Z",
      }),
    ).toThrow(/workspaceId must match scope.workspaceId/u);

    expect(
      sparkSessionListRequestSchema.parse({
        workspaceId: "ws_legacy_list",
        limit: 10,
      }),
    ).toMatchObject({
      scope: { kind: "workspace", workspaceId: "ws_legacy_list" },
      workspaceId: "ws_legacy_list",
      limit: 10,
    });

    expect(() => sparkSessionListRequestSchema.parse(null)).toThrow();
    expect(() => sparkSessionListRequestSchema.parse([])).toThrow();
  });
});
