import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import {
  createWorkspaceWithOwnerBinding,
  submitRuntimeControlCommand,
} from "@zendev-lab/spark-cockpit-coordination";
import { conversationTurnIdempotencyKey } from "./conversation-submission";

describe("Cockpit conversation runtime idempotency contract", () => {
  it("submits its derived turn key through the runtime control validator", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-20T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, 'cockpit-idempotency-test', 'Test runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
         diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'workspace-local', 'Workspace', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "idempotency-workspace",
      name: "Idempotency workspace",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const sessionId = createId("sess");
    const idempotencyKey = conversationTurnIdempotencyKey(sessionId, "browser-submit-1");

    try {
      expect(idempotencyKey).toMatch(/^idem_[a-f0-9]{32}$/);
      const command = submitRuntimeControlCommand(db, {
        runtimeId,
        workspaceId: workspace.id,
        sessionId,
        idempotencyKey,
        payload: {
          kind: "turn.submit.request",
          scope: "workspace",
          payload: { sessionId, prompt: "Send once" },
        },
        createdAt: now,
      });
      expect(command.idempotencyKey).toBe(idempotencyKey);
    } finally {
      db.close();
    }
  });
});
