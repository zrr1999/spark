import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_ROLE_CAPABILITY_PROFILES,
  ROLE_CAPABILITY_VOCAB,
  RoleRegistry,
  MarkdownRoleStore,
  builtinRoleAllowedTools,
  createExtensionRoleSpec,
  createRoleSpec,
  createBuiltinRoles,
  builtinRoleIds,
  hydrateExtensionRoles,
  listExtensionRoles,
  registerExtensionRole,
  validateBuiltinRoleProfiles,
} from "@zendev-lab/spark-roles";

void test("builtin Pi worker is instructed to implement concrete repo behavior feedback", () => {
  const roles = createBuiltinRoles();
  const worker = roles.find((role) => role.id === "worker");
  assert.match(
    worker?.systemPrompt ?? "",
    /fix the implementation instead of only recording a preference/,
  );
});

void test("builtin Pi roles expose audited capability profiles", () => {
  const roles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.deepEqual(
    roles.map((role) => role.id),
    [...builtinRoleIds],
  );
  assert.deepEqual(
    [...ROLE_CAPABILITY_VOCAB],
    ["read", "write", "exec", "net", "interact", "spawn"],
  );
  assert.equal(ROLE_CAPABILITY_VOCAB.includes("record" as never), false);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.scout, ["read", "net"]);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.reviewer, ["read", "net", "exec"]);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.worker, ["read", "net", "exec", "write"]);

  const profileIncludes = (roleId: keyof typeof BUILTIN_ROLE_CAPABILITY_PROFILES, value: string) =>
    (BUILTIN_ROLE_CAPABILITY_PROFILES[roleId] as readonly string[]).includes(value);
  for (const roleId of builtinRoleIds) {
    assert.equal(profileIncludes(roleId, "interact"), false);
    assert.equal(profileIncludes(roleId, "spawn"), false);
    assert.equal(profileIncludes(roleId, "record"), false);
  }

  const byId = new Map(roles.map((role) => [role.id, role]));

  assert.deepEqual(byId.get("scout")?.allowedTools, [
    "read",
    "grep",
    "find",
    "ls",
    "context",
    "web_search",
    "code_search",
    "fetch_content",
    "get_search_content",
  ]);

  assert.deepEqual(byId.get("reviewer")?.allowedTools, [
    ...builtinRoleAllowedTools("scout"),
    "cue_exec",
    "cue_run",
    "cue_script",
    "script_run",
    "script_eval",
    "cue_jobs",
  ]);

  assert.deepEqual(byId.get("worker")?.allowedTools, [
    ...builtinRoleAllowedTools("reviewer"),
    "edit",
    "write",
  ]);

  const forbiddenTools = new Set([
    "ask",
    "ask_user",
    "ask_flow",
    "task",
    "task_read",
    "task_write",
    "goal",
    "role",
    "assign",
    "workflow",
    "graft_patch",
  ]);
  for (const role of roles) {
    for (const tool of role.allowedTools ?? []) assert.equal(forbiddenTools.has(tool), false);
  }
  validateBuiltinRoleProfiles(roles);
});

void test("extension role specs hydrate separately from writable project/user stores", async () => {
  const role = createExtensionRoleSpec(
    {
      id: "test-extension-patcher",
      description: "Test extension patcher role.",
      systemPrompt: "Use only extension-provided patch tools.",
      allowedTools: ["graft_read", "graft_write"],
      origin: { kind: "extension", note: "test" },
    },
    "2026-06-04T00:00:00.000Z",
  );

  registerExtensionRole(role);
  assert.equal(role.ref, "role:extension-test-extension-patcher");
  assert.equal(role.source, "extension");
  assert.ok(listExtensionRoles().some((candidate) => candidate.ref === role.ref));

  const registry = new RoleRegistry([]);
  hydrateExtensionRoles(registry);
  assert.equal(registry.select("test-extension-patcher", { source: "extension" }).ref, role.ref);

  const store = new MarkdownRoleStore({ rootDir: "/tmp/no-write-extension", source: "project" });
  await assert.rejects(() => store.save(role), /only project roles can be saved/);
});

void test("project role spec store persists and hydrates registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    const store = new MarkdownRoleStore(dir);
    const spec = createRoleSpec({
      id: "svg-assembler",
      description: "Creates SVG assembly animation plans.",
      systemPrompt: "You are a specialist in SVG animation planning.",
      rationale: "We need a narrow reusable specialist for SVG animation tasks.",
      expectedUses: ["svg assembly planning", "animation decomposition"],
    });
    await store.save(spec);

    const registry = new RoleRegistry();
    await store.hydrate(registry);
    const loaded = registry.select("svg-assembler");

    assert.equal(loaded.source, "project");
    assert.equal(loaded.id, "svg-assembler");
    assert.match(loaded.ref, /^role:project-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("markdown role store ignores foreign subagent specs in shared .agents roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    await writeFile(
      join(dir, "coder.md"),
      `---\nname: coder\ndescription: >-\n  External subagent spec.\nrole: subagent\nmodel:\n  tier: coding\ncapabilities:\n  - basic\n---\nYou are coder.\n`,
      "utf8",
    );
    const store = new MarkdownRoleStore({ rootDir: dir, source: "user" });

    assert.deepEqual(await store.loadAll(), []);
    const registry = new RoleRegistry();
    await store.hydrate(registry);
    assert.throws(() => registry.select("coder", { source: "user" }), /no role matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("markdown role store still rejects Pi role specs with model frontmatter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    await writeFile(
      join(dir, "bad.md"),
      `---\nid: bad\ndescription: Invalid Pi role.\nmodel: test/model\n---\nYou are invalid.\n`,
      "utf8",
    );
    const store = new MarkdownRoleStore(dir);

    await assert.rejects(
      () => store.loadAll(),
      /role spec model fields are not supported; use role model settings/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
