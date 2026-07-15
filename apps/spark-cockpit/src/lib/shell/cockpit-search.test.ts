import { describe, expect, it } from "vitest";
import { getCockpitDictionary } from "@zendev-lab/spark-i18n";
import { buildCockpitSearchResults } from "./cockpit-search";

const baseInput = {
  sessions: [
    {
      sessionId: "sess_workspace",
      workspaceId: "ws_spore",
      title: "Effect handlers",
      status: "ready",
      activityStatus: "running",
    },
    {
      sessionId: "sess_daemon",
      scope: { kind: "daemon" as const, daemonId: "local", daemonLabel: "Local daemon" },
      title: "Global chat",
      status: "ready",
    },
  ],
  workspaces: [{ id: "ws_spore", slug: "spore", name: "Spore" }],
  untitledConversationLabel: "Untitled",
  channelLabels: getCockpitDictionary("en").sessions.channelLabels,
  statusLabels: { ready: "Ready", running: "Running" },
};

describe("cockpit search", () => {
  it("finds workspace conversations and uses their activity status", () => {
    expect(buildCockpitSearchResults({ ...baseInput, query: "effect" })).toEqual([
      expect.objectContaining({
        id: "sess_workspace",
        description: "Spore",
        status: "running",
      }),
    ]);
  });

  it("finds daemon-global conversations by title or daemon identity", () => {
    expect(buildCockpitSearchResults({ ...baseInput, query: "global" })).toEqual([
      expect.objectContaining({
        id: "sess_daemon",
        description: "Local daemon",
        href: "/sessions/sess_daemon",
      }),
    ]);
    expect(buildCockpitSearchResults({ ...baseInput, query: "local daemon" })).toEqual([
      expect.objectContaining({ id: "sess_daemon" }),
    ]);
  });

  it("returns workspace links after conversation matches", () => {
    expect(buildCockpitSearchResults({ ...baseInput, query: "spore" })).toEqual([
      expect.objectContaining({ id: "sess_workspace", type: "session" }),
      expect.objectContaining({ id: "ws_spore", type: "workspace", href: "/spore" }),
    ]);
  });
});
