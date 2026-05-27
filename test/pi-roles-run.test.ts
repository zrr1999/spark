import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelRoleRun,
  defaultUserRoleModelBindingStore,
  listActiveRoleRuns,
  normalizeRoleRef,
  normalizeRoleRunMode,
  normalizeRoleSource,
  parsePiJsonlEvents,
  RoleRunCancelledError,
  RoleRunTimeoutError,
  runRole,
  saveValidatedRoleModelBinding,
} from "pi-roles";
import { buildRoleRunArgs } from "spark-runtime";

void test("pi-roles builds fresh JSON Pi role args without accidental fork session reuse", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:project-svg-assembler",
    mode: "fresh",
    systemPrompt: "You are a worker.",
    instruction: "Implement the task.",
    sessionDir: "/tmp/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 6), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/tmp/sessions",
    "--append-system-prompt",
  ]);
  assert.equal(args.includes("--fork"), false);
  assert.equal(args.includes("session-parent.json"), false);
  assert.equal(args.at(-2), "You are a worker.");
  assert.equal(args.at(-1)?.includes("Spark role-run ask policy:"), true);
  assert.equal(args.at(-1)?.includes("Spark naming quality policy:"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\n\nImplement the task."), true);
});

void test("pi-roles includes resolved user model in JSON Pi role args", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-worker",
    mode: "fresh",
    systemPrompt: "You are a worker.",
    model: "openai/gpt-5.5",
    instruction: "Implement.",
  });

  assert.deepEqual(args.slice(0, 5), ["--print", "--mode", "json", "--model", "openai/gpt-5.5"]);
});

void test("pi-roles builds forked JSON Pi role args only when forked mode is explicit", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-reviewer",
    mode: "forked",
    systemPrompt: "You are a reviewer.",
    instruction: "Review the task.",
    sessionDir: "/tmp/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 8), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/tmp/sessions",
    "--fork",
    "session-parent.json",
    "--append-system-prompt",
  ]);
});

void test("pi-roles requires fork source for forked mode", () => {
  assert.throws(
    () =>
      buildRoleRunArgs({
        roleRef: "role:builtin-worker",
        mode: "forked",
        systemPrompt: "You are a worker.",
        instruction: "Implement.",
      }),
    /forked role run requires forkFromSession/,
  );
});

void test("pi-roles validates and persists user role model bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-model-binding-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'openai/gpt-5.5') process.exit(0);",
        "if (args[0] === '--list-models' && args[1] === 'missing-zero/model') { process.stdout.write('No models matching missing-zero/model\\n'); process.exit(0); }",
        "process.exit(42);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    const store = defaultUserRoleModelBindingStore(dir);

    const binding = await saveValidatedRoleModelBinding({
      store,
      roleRef: "role:builtin-worker",
      model: "openai/gpt-5.5",
      piCommand: fakePi,
      cwd: dir,
      now: () => "2026-05-26T00:00:00.000Z",
    });

    assert.equal(binding.model, "openai/gpt-5.5");
    assert.equal((await store.get("role:builtin-worker"))?.model, "openai/gpt-5.5");
    await assert.rejects(
      saveValidatedRoleModelBinding({
        store,
        roleRef: "role:builtin-reviewer",
        model: "missing/model",
        piCommand: fakePi,
        cwd: dir,
      }),
      /model validation failed/,
    );
    assert.equal(await store.get("role:builtin-reviewer"), undefined);
    await assert.rejects(
      saveValidatedRoleModelBinding({
        store,
        roleRef: "role:builtin-planner",
        model: "missing-zero/model",
        piCommand: fakePi,
        cwd: dir,
      }),
      /No models matching missing-zero\/model/,
    );
    assert.equal(await store.get("role:builtin-planner"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles launches Pi, captures JSONL events, and records run metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-launcher-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--print')) process.exit(10);",
        "if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'json') process.exit(11);",
        "process.stdout.write(JSON.stringify({ type: 'start', args }) + '\\n');",
        "process.stdout.write('not-json\\n');",
        "process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');",
        "process.stderr.write('diagnostic\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const result = await runRole({
      runRef: "run:launcher-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Implement.",
      piCommand: fakePi,
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      now: () => "2026-05-21T00:00:00.000Z",
    });

    assert.equal(result.record.ref, "run:launcher-test");
    assert.equal(result.record.roleRef, "role:builtin-worker");
    assert.equal(result.record.mode, "fresh");
    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.startedAt, "2026-05-21T00:00:00.000Z");
    assert.equal(result.record.finishedAt, "2026-05-21T00:00:00.000Z");
    assert.match(result.stderr, /diagnostic/);
    assert.equal(result.jsonEvents.length, 2);
    assert.deepEqual(result.jsonEvents.at(-1), { type: "done" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles tracks and cancels active runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-cancel-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "setInterval(() => process.stdout.write(JSON.stringify({ type: 'tick' }) + '\\n'), 50);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const run = runRole({
      runRef: "run:cancel-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Wait.",
      piCommand: fakePi,
      cwd: dir,
      timeoutMs: 5_000,
    });
    await eventually(() => listActiveRoleRuns().some((entry) => entry.ref === "run:cancel-test"));
    assert.equal(cancelRoleRun("run:cancel-test", "test cancellation"), true);
    await assert.rejects(run, RoleRunCancelledError);
    assert.equal(
      listActiveRoleRuns().some((entry) => entry.ref === "run:cancel-test"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles enforces timeout control", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-timeout-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(fakePi, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", "utf8");
    await chmod(fakePi, 0o755);

    await assert.rejects(
      runRole({
        runRef: "run:timeout-test",
        roleRef: "role:builtin-worker",
        systemPrompt: "You are a worker.",
        instruction: "Wait.",
        piCommand: fakePi,
        cwd: dir,
        timeoutMs: 10,
      }),
      RoleRunTimeoutError,
    );
    assert.equal(
      listActiveRoleRuns().some((entry) => entry.ref === "run:timeout-test"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles normalizes unknown modes to fresh and parses JSONL tolerantly", () => {
  assert.equal(normalizeRoleRunMode("forked"), "forked");
  assert.equal(normalizeRoleRunMode("legacy-mode"), "fresh");
  assert.deepEqual(parsePiJsonlEvents('{"type":"start"}\nnot-json\n{"type":"stop"}\n'), [
    { type: "start" },
    { type: "stop" },
  ]);
});

void test("pi-roles keeps narrow role source and ref compatibility", () => {
  assert.equal(normalizeRoleRef("agent:builtin-worker"), "role:builtin-worker");
  assert.equal(normalizeRoleSource("predefined"), "builtin");
  assert.equal(normalizeRoleSource("managed"), "project");
  assert.equal(normalizeRoleSource("workspace"), "project");
});

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met in time");
}
