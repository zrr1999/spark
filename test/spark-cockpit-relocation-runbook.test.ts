import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runbookUrl = new URL("../docs/operations/cockpit-relocation.md", import.meta.url);

void test("Cockpit relocation runbook keeps every operational stage and rollback command", async () => {
  const source = await readFile(runbookUrl, "utf8");
  for (const heading of [
    "## Stop conditions",
    "## 1. Preflight",
    "## 2. Source backup and inspect",
    "## 3. Stop, back up, and restore target",
    "## 4. Deploy HTTPS/WSS target",
    "## 5. Relocate the daemon uplink",
    "## 6. Functional and security acceptance",
    "## 7. Reverse relocation and rollback",
    "## Owner handoff is separate",
    "## Evidence record",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(heading), "u"), heading);
  }

  for (const command of [
    "spark cockpit instance status --database",
    "spark cockpit instance backup --database",
    "spark cockpit instance inspect --snapshot",
    "spark cockpit instance restore --snapshot",
    "spark daemon workspace relocate",
    "spark daemon status --json",
    "systemctl --user stop spark-cockpit",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(command), "u"), command);
  }

  for (const field of [
    "instanceId",
    "installationId",
    "runtimeId",
    "bindingId",
    "database.sha256",
    "integrityCheck",
    "foreignKeyViolations",
    "rollbackSnapshotPath",
    "workspaceBindingIds",
    "relocatedAt",
    "matchCount: 0",
    "daemonExecutionCount: 0",
    "WORKSPACE_OWNER_CONFLICT",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(field), "u"), field);
  }
});

void test("Cockpit relocation runbook preserves security, ownership, and feature-only boundaries", async () => {
  const source = await readFile(runbookUrl, "utf8");
  assert.match(source, /feature-only procedure/u);
  assert.match(source, /does not authorize an operator to upload, restore, deploy, or switch/u);
  assert.match(source, /marrow-paddle/u);
  assert.match(source, /not eligible for full cutover until an HTTPS\/WSS endpoint/u);
  assert.match(source, /different instance means independent registration, not relocation/u);
  assert.match(source, /Do not retry a partially completed secret request/u);
  assert.match(source, /Do not use ordinary workspace registration to force a new owner/u);
  assert.match(
    source,
    /Do not restore the target's old database while the daemon points at the target/u,
  );

  for (const ownerCheck of [
    "owner handoff",
    "draining",
    "borrowed",
    "active invocation",
    "pending command",
    "one-time authorization",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(ownerCheck), "u"), ownerCheck);
  }

  for (const failure of [
    "instance mismatch",
    "runtime missing",
    "token rejected",
    "runtime mismatch",
    "target unreachable",
    "target collision",
    "local transaction failure",
  ]) {
    assert.match(source, new RegExp(escapeRegExp(failure), "u"), failure);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
