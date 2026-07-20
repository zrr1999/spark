import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  consumeWorkspaceAccessToken,
  createWorkspaceAccessToken,
  hasActiveWorkspaceAccessTokens,
  listWorkspaceAccessTokens,
  revokeWorkspaceAccessToken,
  WorkspaceAccessTokenError,
} from "./workspace-access";

const workspaceId = "ws_11111111111141111111111111111111";
const createdAt = "2026-07-20T00:00:00.000Z";

describe("workspace browser access", () => {
  it("stores only a hash and consumes a key exactly once", () => {
    const db = createDatabase();
    const created = createWorkspaceAccessToken(db, {
      workspaceId,
      label: "Alice browser",
      createdAt,
      ttlMs: 60_000,
    });

    const stored = db
      .prepare("SELECT token_hash AS tokenHash FROM workspace_access_tokens WHERE id = ?")
      .get(created.id) as { tokenHash: string };
    expect(created.token).toMatch(/^spark_workspace_auth_/);
    expect(stored.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(listWorkspaceAccessTokens(db, workspaceId))).not.toContain(created.token);
    expect(hasActiveWorkspaceAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(true);

    expect(
      consumeWorkspaceAccessToken(db, created.token, "2026-07-20T00:00:30.000Z"),
    ).toMatchObject({
      tokenId: created.id,
      workspaceId,
      workspaceSlug: "spore",
      workspaceName: "Spore",
    });
    expect(hasActiveWorkspaceAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(false);
    expectWorkspaceAccessError(
      () => consumeWorkspaceAccessToken(db, created.token, "2026-07-20T00:00:31.000Z"),
      "WORKSPACE_ACCESS_TOKEN_USED",
    );
    db.close();
  });

  it("rejects revoked and expired keys", () => {
    const db = createDatabase();
    const revoked = createWorkspaceAccessToken(db, {
      workspaceId,
      createdAt,
      ttlMs: 60_000,
    });
    expect(
      revokeWorkspaceAccessToken(db, {
        workspaceId,
        tokenId: revoked.id,
        revokedAt: "2026-07-20T00:00:10.000Z",
      }),
    ).toBe(true);
    expectWorkspaceAccessError(
      () => consumeWorkspaceAccessToken(db, revoked.token, "2026-07-20T00:00:20.000Z"),
      "WORKSPACE_ACCESS_TOKEN_REVOKED",
    );

    const expired = createWorkspaceAccessToken(db, {
      workspaceId,
      createdAt,
      ttlMs: 1_000,
    });
    expectWorkspaceAccessError(
      () => consumeWorkspaceAccessToken(db, expired.token, "2026-07-20T00:00:01.000Z"),
      "WORKSPACE_ACCESS_TOKEN_EXPIRED",
    );
    db.close();
  });
});

function createDatabase() {
  const db = openMemoryDatabase();
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, 'spore', 'Spore', 'active', '{}', ?, ?)`,
  ).run(workspaceId, createdAt, createdAt);
  return db;
}

function expectWorkspaceAccessError(action: () => unknown, reasonCode: string) {
  try {
    action();
    throw new Error("Expected workspace access error.");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceAccessTokenError);
    expect(error).toMatchObject({ reasonCode });
  }
}
