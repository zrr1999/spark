import { DatabaseSync } from "node:sqlite";
import { FakeChannelTransport, type QqbotTransportOptions } from "@zendev-lab/spark-channels";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { createDaemonChannelTransportFactory } from "./transport-factory.ts";

describe("createDaemonChannelTransportFactory", () => {
  it("injects a cursor scoped by workspace and adapter into each rebuilt QQ transport", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const createdOptions: QqbotTransportOptions[] = [];
    const createQqbotTransport = vi.fn((_config, options: QqbotTransportOptions) => {
      createdOptions.push(options);
      return new FakeChannelTransport();
    });
    const factory = createDaemonChannelTransportFactory(db, { createQqbotTransport });
    try {
      expect(
        factory({
          workspaceId: "workspace-1",
          adapterId: "qq-main",
          config: { type: "qqbot", app_id: "app", client_secret: "secret" },
        }),
      ).toBeInstanceOf(FakeChannelTransport);
      await createdOptions[0]?.saveCursor?.({ sessionId: "gateway-session", lastSeq: 12 });

      factory({
        workspaceId: "workspace-1",
        adapterId: "qq-main",
        config: { type: "qqbot", app_id: "app", client_secret: "secret" },
      });
      expect(await createdOptions[1]?.loadCursor?.()).toEqual({
        sessionId: "gateway-session",
        lastSeq: 12,
      });

      factory({
        workspaceId: "workspace-2",
        adapterId: "qq-main",
        config: { type: "qqbot", app_id: "app", client_secret: "secret" },
      });
      expect(await createdOptions[2]?.loadCursor?.()).toBeNull();
      expect(
        factory({
          workspaceId: "workspace-1",
          adapterId: "info-main",
          config: { type: "infoflow" },
        }),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
