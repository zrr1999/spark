import { describe, expect, it } from "vitest";
import { parseChannelExternalKeyParts, workspaceChannelListFromSessions } from "./create-channel";

describe("parseChannelExternalKeyParts", () => {
  it("parses adapter, scope, and id", () => {
    expect(parseChannelExternalKeyParts("infoflow:user:zhanrongrui")).toEqual({
      adapter: "infoflow",
      scope: "user",
      id: "zhanrongrui",
    });
  });

  it("rejects unknown adapters and scopes", () => {
    expect(parseChannelExternalKeyParts("slack:user:x")).toBeNull();
    expect(parseChannelExternalKeyParts("infoflow:room:x")).toBeNull();
  });
});

describe("workspaceChannelListFromSessions", () => {
  it("keeps only sessions with channel bindings and sorts by updatedAt desc", () => {
    const items = workspaceChannelListFromSessions([
      {
        sessionId: "sess_plain",
        title: "Plain",
        status: "ready",
        updatedAt: "2026-07-13T12:00:00.000Z",
        bindings: [],
      },
      {
        sessionId: "sess_old",
        title: "channel infoflow:user:alice",
        status: "ready",
        updatedAt: "2026-07-12T12:00:00.000Z",
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            externalKey: "infoflow:user:alice",
            boundAt: "2026-07-12T12:00:00.000Z",
          },
        ],
      },
      {
        sessionId: "sess_new",
        title: "Ops room",
        status: "ready",
        updatedAt: "2026-07-13T18:00:00.000Z",
        bindings: [
          {
            kind: "channel",
            adapter: "feishu",
            externalKey: "feishu:chat:oc_1",
          },
        ],
      },
    ]);

    expect(items.map((item) => item.sessionId)).toEqual(["sess_new", "sess_old"]);
    expect(items[0]?.bindings[0]).toMatchObject({
      adapter: "feishu",
      externalKey: "feishu:chat:oc_1",
    });
  });
});
