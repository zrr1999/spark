import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelRoleRun,
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  defaultProjectRoleStore,
  defaultUserRoleModelSettingsStore,
  hydrateDefaultRoleRegistry,
  listActiveRoleRuns,
  normalizeRoleRef,
  normalizeRoleLaunchMode,
  normalizeRoleSource,
  parsePiJsonlEvents,
  parseRoleSpecMarkdown,
  ROLE_RUN_DEPTH_ENV,
  RoleRegistry,
  resolveRoleModelSetting,
  RoleModelSettingsStoreFormatError,
  RoleRunCancelledError,
  RoleRunTimeoutError,
  runRole,
  validateRoleModel,
} from "@zendev-lab/pi-roles";
import { buildRoleRunArgs, runRoleInstructionOnly } from "@zendev-lab/spark-runtime";

void test("pi-roles builds fresh JSON Pi role args without accidental fork session reuse", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:project-svg-assembler",
    launch: "fresh",
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
  assert.equal(args.at(-1)?.includes("Spark role-run interaction policy:"), true);
  assert.equal(args.at(-1)?.includes("Spark naming quality policy:"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\n\nImplement the task."), true);
});

void test("pi-roles includes resolved user model in JSON Pi role args", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-worker",
    launch: "fresh",
    systemPrompt: "You are a worker.",
    model: "openai/gpt-5.5",
    instruction: "Implement.",
  });

  assert.deepEqual(args.slice(0, 5), ["--print", "--mode", "json", "--model", "openai/gpt-5.5"]);
});

void test("pi-roles can pass a child Pi tool allowlist", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-worker",
    launch: "fresh",
    systemPrompt: "You are a worker.",
    instruction: "Create a patch.",
    allowedTools: ["graft_read", " graft_write ", "", "graft_validate"],
  });

  const index = args.indexOf("--tools");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "graft_read,graft_write,graft_validate");
});

void test("pi-roles builds forked JSON Pi role args only when forked launch is explicit", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-reviewer",
    launch: "forked",
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

void test("pi-roles requires fork source for forked launch", () => {
  assert.throws(
    () =>
      buildRoleRunArgs({
        roleRef: "role:builtin-worker",
        launch: "forked",
        systemPrompt: "You are a worker.",
        instruction: "Implement.",
      }),
    /forked role launch requires forkFromSession/,
  );
});

void test("pi-roles default registry ignores legacy agent-shaped role stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-no-legacy-stores-"));
  try {
    const currentRole = createRoleSpec({
      id: "current-worker",
      description: "Current project role.",
      systemPrompt: "You are the current worker.",
      rationale: "Exercise default role registry boundaries.",
      expectedUses: ["registry boundary test"],
    });
    await defaultProjectRoleStore(dir).save(currentRole);

    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "agents", "legacy-worker.md"),
      '---\nid: "legacy-worker"\ndescription: "Legacy role"\nsource: "project"\n---\n\nYou are legacy.\n',
      "utf8",
    );
    await mkdir(join(dir, ".spark", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "agents", "legacy-json.json"),
      `${JSON.stringify({ id: "legacy-json", description: "Legacy JSON role" })}\n`,
      "utf8",
    );

    const registry = new RoleRegistry();
    await hydrateDefaultRoleRegistry(registry, dir);

    assert.equal(registry.select("current-worker").ref, currentRole.ref);
    assert.throws(() => registry.select("legacy-worker"), /no role matches/);
    assert.throws(() => registry.select("legacy-json"), /no role matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles validates model names before saving settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-model-validation-"));
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

    await validateRoleModel({ piCommand: fakePi, model: "openai/gpt-5.5", cwd: dir });
    await assert.rejects(
      validateRoleModel({ piCommand: fakePi, model: "missing/model", cwd: dir }),
      /model validation failed/,
    );
    await assert.rejects(
      validateRoleModel({ piCommand: fakePi, model: "missing-zero/model", cwd: dir }),
      /No models matching missing-zero\/model/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles resolves role model settings with project and user precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-model-settings-"));
  try {
    const userHome = join(dir, "home");
    const projectStore = defaultProjectRoleModelSettingsStore(dir);
    const userStore = defaultUserRoleModelSettingsStore(userHome);

    await userStore.save("role:builtin-worker", "user-model");
    await userStore.save("reviewer", "user-reviewer-model");
    await projectStore.save("builtin-worker", "project-model");

    assert.deepEqual(
      await resolveRoleModelSetting({
        roleRef: "role:builtin-worker",
        projectStore,
        userStore,
      }),
      { model: "project-model", source: "project", selector: "builtin-worker" },
    );
    assert.deepEqual(
      await resolveRoleModelSetting({
        roleRef: "role:builtin-reviewer",
        roleName: "reviewer",
        projectStore,
        userStore,
      }),
      { model: "user-reviewer-model", source: "user", selector: "reviewer" },
    );
    assert.equal(
      await resolveRoleModelSetting({
        roleRef: "role:builtin-scout",
        projectStore,
        userStore,
      }),
      undefined,
    );
    assert.deepEqual(
      await resolveRoleModelSetting({
        explicitModel: "explicit-model",
        roleRef: "role:builtin-worker",
        projectStore,
        userStore,
      }),
      { model: "explicit-model", source: "explicit" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark runtime role dispatch fails loudly without model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-runtime-missing-model-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    const registry = new RoleRegistry();
    await assert.rejects(
      () =>
        runRoleInstructionOnly(
          registry,
          { roleRef: "role:builtin-worker", instruction: "Run without a model setting." },
          { dryRun: false, cwd: dir, piCommand: "pi", timeoutMs: 5_000 },
        ),
      /role model unavailable for role:builtin-worker/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark runtime role dispatch inherits session model when no role model is saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-runtime-session-model-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--print')) process.exit(10);",
        "if (!args.includes('--model') || args[args.indexOf('--model') + 1] !== 'test/model') process.exit(11);",
        "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Runtime session model result.' }] }, args }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const registry = new RoleRegistry();
    const result = await runRoleInstructionOnly(
      registry,
      { roleRef: "role:builtin-worker", instruction: "Run with the session model." },
      {
        dryRun: false,
        cwd: dir,
        piCommand: fakePi,
        timeoutMs: 5_000,
        sessionModel: "test/model",
      },
    );

    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.model, "test/model");
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles rejects malformed role model settings stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-model-settings-invalid-"));
  try {
    const store = defaultProjectRoleModelSettingsStore(dir);
    assert.deepEqual(await store.loadAll(), []);
    await mkdir(join(dir, ".spark"), { recursive: true });

    await writeFile(store.filePath, "{not-json", "utf8");
    await assert.rejects(
      () => store.loadAll(),
      (error) =>
        error instanceof RoleModelSettingsStoreFormatError &&
        error.filePath === store.filePath &&
        /not valid JSON/.test(error.message),
    );

    await writeFile(store.filePath, `${JSON.stringify({ version: 1, roleModels: [] })}\n`, "utf8");
    await assert.rejects(
      () => store.loadAll(),
      (error) =>
        error instanceof RoleModelSettingsStoreFormatError &&
        error.filePath === store.filePath &&
        /roleModels must be an object/.test(error.message),
    );

    await writeFile(
      store.filePath,
      `${JSON.stringify({ version: 1, roleModels: { worker: "" } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => store.loadAll(),
      (error) =>
        error instanceof RoleModelSettingsStoreFormatError &&
        error.filePath === store.filePath &&
        /roleModels\.worker must be a non-empty string/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles rejects role spec model frontmatter", () => {
  assert.throws(
    () =>
      parseRoleSpecMarkdown(
        "---\nid: model-role\ndescription: Invalid model field\ndefaultModel: test/model\n---\n\nYou are invalid.",
        { source: "project", id: "model-role" },
      ),
    /role spec model fields are not supported; use role model settings/,
  );
  assert.throws(
    () =>
      parseRoleSpecMarkdown(
        "---\nid: model-role\ndescription: Invalid model field\nmodel: test/model\n---\n\nYou are invalid.",
        { source: "project", id: "model-role" },
      ),
    /role spec model fields are not supported; use role model settings/,
  );
});

function roleDepthTestEnv(depth?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[ROLE_RUN_DEPTH_ENV];
  if (depth !== undefined) env[ROLE_RUN_DEPTH_ENV] = depth;
  return env;
}

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
    assert.equal(result.record.launch, "fresh");
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

void test("pi-roles decrements role run depth for child Pi processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-depth-env-"));
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(JSON.stringify({ type: 'depth', depth: process.env.${ROLE_RUN_DEPTH_ENV} }) + '\\n');`,
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const defaultDepth = await runRole({
      runRef: "run:default-depth-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Report depth.",
      piCommand: fakePi,
      cwd: dir,
      env: roleDepthTestEnv(),
    });
    assert.deepEqual(defaultDepth.jsonEvents.at(-1), { type: "depth", depth: "3" });

    const explicitDepth = await runRole({
      runRef: "run:explicit-depth-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Report depth.",
      piCommand: fakePi,
      cwd: dir,
      env: roleDepthTestEnv("2"),
    });
    assert.deepEqual(explicitDepth.jsonEvents.at(-1), { type: "depth", depth: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles refuses to spawn when role run depth is exhausted", async () => {
  let spawned = false;
  await assert.rejects(
    runRole({
      runRef: "run:depth-exhausted-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Should not spawn.",
      piCommand: "pi",
      cwd: process.cwd(),
      env: roleDepthTestEnv("0"),
      onChildProcess: () => {
        spawned = true;
      },
    }),
    /PI_ROLE_DEPTH exhausted/,
  );
  assert.equal(spawned, false);

  await assert.rejects(
    runRole({
      runRef: "run:negative-depth-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Should not spawn.",
      piCommand: "pi",
      cwd: process.cwd(),
      env: roleDepthTestEnv("-1"),
    }),
    /PI_ROLE_DEPTH exhausted/,
  );
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

void test("pi-roles defaults omitted role launch but rejects unknown launches", () => {
  assert.equal(normalizeRoleLaunchMode(undefined), "fresh");
  assert.equal(normalizeRoleLaunchMode("fresh"), "fresh");
  assert.equal(normalizeRoleLaunchMode("forked"), "forked");
  assert.throws(() => normalizeRoleLaunchMode("legacy-mode"), /unsupported role launch mode/);
});

void test("pi-roles parses JSONL tolerantly", () => {
  assert.deepEqual(parsePiJsonlEvents('{"type":"start"}\nnot-json\n{"type":"stop"}\n'), [
    { type: "start" },
    { type: "stop" },
  ]);
});

void test("pi-roles rejects legacy role aliases instead of normalizing them", () => {
  assert.throws(
    () => normalizeRoleRef("agent:builtin-worker"),
    /legacy agent refs are not supported/,
  );
  assert.equal(normalizeRoleSource("extension"), "extension");
  assert.equal(normalizeRoleSource("predefined"), undefined);
  assert.equal(normalizeRoleSource("managed"), undefined);
  assert.equal(normalizeRoleSource("workspace"), undefined);
});

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met in time");
}
