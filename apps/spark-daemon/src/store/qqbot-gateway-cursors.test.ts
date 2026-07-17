import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";
import { SparkQqbotGatewayCursorStore } from "./qqbot-gateway-cursors.ts";

describe("SparkQqbotGatewayCursorStore", () => {
  it("scopes cursors and refuses to regress a sequence in the same session", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkQqbotGatewayCursorStore(db, {
      now: () => "2026-07-15T10:00:00.000Z",
    });
    try {
      store.save("workspace-1", "qq-main", { sessionId: "gateway-1", lastSeq: 8 });
      store.save("workspace-1", "qq-main", { sessionId: "gateway-1", lastSeq: 7 });
      store.save("workspace-2", "qq-main", { sessionId: "gateway-2", lastSeq: 3 });

      expect(store.get("workspace-1", "qq-main")).toEqual({
        sessionId: "gateway-1",
        lastSeq: 8,
      });
      expect(store.get("workspace-2", "qq-main")).toEqual({
        sessionId: "gateway-2",
        lastSeq: 3,
      });

      store.save("workspace-1", "qq-main", null);
      expect(store.get("workspace-1", "qq-main")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
