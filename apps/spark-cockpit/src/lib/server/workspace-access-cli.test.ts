import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "vitest";

import { migrate, openDatabase } from "@zendev-lab/spark-db";

import { handleWorkspaceAccessCliCommand } from "./workspace-access-cli.ts";

const roots: string[] = [];
const workspaceId = "ws_11111111111141111111111111111111";
const createdAt = "2026-07-21T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("creates a workspace access key once and lists only metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-workspace-access-cli-"));
  roots.push(root);
  const databasePath = join(root, "cockpit.sqlite");
  const db = openDatabase({ path: databasePath });
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, 'spore', 'Spore', 'active', '{}', ?, ?)`,
  ).run(workspaceId, createdAt, createdAt);
  db.close();

  const created = await handleWorkspaceAccessCliCommand({
    operation: "create",
    databasePath,
    workspaceRef: "spore",
    label: "Remote browser",
  });
  assert.equal(created.operation, "create");
  assert.equal(created.status, "created");
  if (created.operation !== "create") throw new Error("expected create");
  assert.match(created.token, /^spark_workspace_auth_/);
  assert.equal(created.loginPath, "/spore/login");
  assert.match(created.text, /shown once/);

  const listed = await handleWorkspaceAccessCliCommand({
    operation: "list",
    databasePath,
    workspaceRef: workspaceId,
  });
  assert.equal(listed.operation, "list");
  if (listed.operation !== "list") throw new Error("expected list");
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0]?.id, created.tokenId);
  assert.doesNotMatch(JSON.stringify(listed.tokens), /spark_workspace_auth_/);

  const revoked = await handleWorkspaceAccessCliCommand({
    operation: "revoke",
    databasePath,
    workspaceRef: "Spore",
    tokenId: created.tokenId,
  });
  assert.equal(revoked.status, "revoked");
});
