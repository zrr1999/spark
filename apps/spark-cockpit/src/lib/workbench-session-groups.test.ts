import { describe, expect, it } from "vitest";
import { getCockpitDictionary } from "@zendev-lab/spark-i18n";
import {
  groupWorkbenchSessionsByType,
  workbenchSessionType,
  type WorkbenchSessionGroupLike,
} from "./workbench-session-groups";

const sessionsMessages = getCockpitDictionary("en").sessions;
const options = {
  channelLabels: sessionsMessages.channelLabels,
  fallback: sessionsMessages.untitledConversation,
  labels: sessionsMessages.sessionTypes,
};

describe("workbench session type groups", () => {
  it.each([
    [session("workspace"), "workspace"],
    [channelSession("infoflow:user:alice"), "private"],
    [channelSession("qqbot:c2c:alice"), "private"],
    [channelSession("infoflow:group:ops"), "group"],
    [channelSession("qqbot:group:ops"), "group"],
    [channelSession("qqbot:channel:dev"), "channel"],
    [channelSession("feishu:chat:oc_ops"), "conversation"],
  ] as const)("classifies %s as %s", (value, expected) => {
    expect(workbenchSessionType(value, options)).toBe(expected);
  });

  it("does not create a group for daemon-global sessions", () => {
    const daemon = session("daemon", { scope: { kind: "daemon", daemonId: "local" } });

    expect(workbenchSessionType(daemon, options)).toBeNull();
    expect(groupWorkbenchSessionsByType([session("workspace"), daemon], options)).toEqual([
      expect.objectContaining({ key: "workspace" }),
    ]);
  });

  it("uses binding identity with a custom title and legacy title-only identity", () => {
    expect(
      workbenchSessionType(channelSession("infoflow:group:ops", { title: "Operations" }), options),
    ).toBe("group");
    expect(
      workbenchSessionType(session("legacy", { title: "channel qqbot:c2c:398418FB" }), options),
    ).toBe("private");
  });

  it("keeps an unparsable channel binding in the messaging fallback group", () => {
    expect(
      workbenchSessionType(
        session("unknown-channel", {
          bindings: [{ kind: "channel", adapter: "custom", externalKey: "custom:room:ops" }],
        }),
        options,
      ),
    ).toBe("conversation");
  });

  it("keeps a stable type order and attention order without mutating input", () => {
    const input = [
      channelSession("infoflow:group:old", { updatedAt: "2026-07-14T08:00:00Z" }),
      session("workspace"),
      channelSession("infoflow:group:running", {
        activityStatus: "running",
        updatedAt: "2026-07-14T07:00:00Z",
      }),
      channelSession("qqbot:c2c:alice"),
    ];

    const groups = groupWorkbenchSessionsByType(input, options);

    expect(groups.map((group) => group.key)).toEqual(["workspace", "private", "group"]);
    expect(groups.at(-1)?.sessions.map((value) => value.sessionId)).toEqual([
      "infoflow:group:running",
      "infoflow:group:old",
    ]);
    expect(input.map((value) => value.sessionId)).toEqual([
      "infoflow:group:old",
      "workspace",
      "infoflow:group:running",
      "qqbot:c2c:alice",
    ]);
  });
});

function session(
  sessionId: string,
  overrides: Partial<WorkbenchSessionGroupLike> = {},
): WorkbenchSessionGroupLike {
  return {
    sessionId,
    workspaceId: "ws_spore",
    status: "ready",
    title: sessionId,
    updatedAt: "2026-07-14T09:00:00Z",
    ...overrides,
  };
}

function channelSession(
  externalKey: string,
  overrides: Partial<WorkbenchSessionGroupLike> = {},
): WorkbenchSessionGroupLike {
  return session(externalKey, {
    title: `channel ${externalKey}`,
    bindings: [
      {
        kind: "channel",
        adapter: externalKey.split(":", 1)[0],
        externalKey,
      },
    ],
    ...overrides,
  });
}
