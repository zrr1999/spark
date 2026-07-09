import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionRoleRunner } from "@zendev-lab/spark-extension-api";
import { TaskGraph } from "@zendev-lab/spark-tasks";

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
} from "@zendev-lab/spark-roles";
import {
  buildRoleRunArgs,
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runRoleInstructionOnly,
  runSparkTask,
} from "@zendev-lab/spark-runtime";

void test("spark-roles builds fresh JSON Pi role args without accidental fork session reuse", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:project-svg-assembler",
    launch: "fresh",
    systemPrompt: "You are a worker.",
    instruction: "Implement the task.",
    sessionDir: "/Users/example/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 6), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/Users/example/sessions",
    "--append-system-prompt",
  ]);
  assert.equal(args.includes("--fork"), false);
  assert.equal(args.includes("session-parent.json"), false);
  assert.equal(args.at(-2), "You are a worker.");
  assert.equal(args.at(-1)?.includes("Spark role-run interaction policy:"), true);
  assert.equal(args.at(-1)?.includes("Spark naming quality policy:"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\n\nImplement the task."), true);
});

void test("spark-roles includes resolved user model in JSON Pi role args", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-worker",
    launch: "fresh",
    systemPrompt: "You are a worker.",
    model: "openai/gpt-5.5",
    instruction: "Implement.",
  });

  assert.deepEqual(args.slice(0, 5), ["--print", "--mode", "json", "--model", "openai/gpt-5.5"]);
});

void test("spark-roles can pass a child Pi tool allowlist", () => {
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

void test("spark-roles can launch ephemeral no-session role runs", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-reviewer",
    launch: "fresh",
    systemPrompt: "You are a reviewer.",
    instruction: "Review without saving child session state.",
    noSession: true,
    sessionDir: "/Users/example/sessions",
  });

  assert.deepEqual(args.slice(0, 7), [
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--session-dir",
    "/Users/example/sessions",
    "--append-system-prompt",
  ]);
  assert.throws(
    () =>
      buildRoleRunArgs({
        roleRef: "role:builtin-reviewer",
        launch: "forked",
        systemPrompt: "You are a reviewer.",
        instruction: "Invalid forked no-session run.",
        noSession: true,
        forkFromSession: "session-parent.json",
      }),
    /noSession role runs cannot use forked launch/,
  );
});

void test("spark-roles builds forked JSON Pi role args only when forked launch is explicit", () => {
  const args = buildRoleRunArgs({
    roleRef: "role:builtin-reviewer",
    launch: "forked",
    systemPrompt: "You are a reviewer.",
    instruction: "Review the task.",
    sessionDir: "/Users/example/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 8), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/Users/example/sessions",
    "--fork",
    "session-parent.json",
    "--append-system-prompt",
  ]);
});

void test("spark-roles requires fork source for forked launch", () => {
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

void test("spark-roles default registry ignores legacy agent-shaped role stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-no-legacy-stores-"));
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

void test("spark-roles validates model names before saving settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-model-validation-"));
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

void test("spark-roles resolves role model settings with project and user precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-model-settings-"));
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

void test("spark runtime role dispatch can run native roles without model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-runtime-missing-model-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    const registry = new RoleRegistry();
    let capturedModel: string | undefined;
    const result = await runRoleInstructionOnly(
      registry,
      { roleRef: "role:builtin-worker", instruction: "Run without a model setting." },
      {
        dryRun: false,
        cwd: dir,
        piCommand: "pi",
        timeoutMs: 5_000,
        roleExecutor: async (input) => {
          capturedModel = input.model;
          return {
            record: { ...input.record, status: "succeeded" as const },
            stdout: "native role ok",
            stderr: "",
            jsonEvents: [],
          };
        },
      },
    );

    assert.equal(result.record.status, "succeeded");
    assert.equal(capturedModel, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark runtime role dispatch times out hanging native executors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-runtime-timeout-cleanup-"));
  const runName = "timeout-cleanup-test";
  try {
    await assert.rejects(
      () =>
        runRoleInstructionOnly(
          new RoleRegistry(),
          { roleRef: "role:builtin-worker", instruction: "Hang until timeout." },
          {
            dryRun: false,
            cwd: dir,
            piCommand: "pi",
            timeoutMs: 25,
            sessionModel: "test/model",
            runName,
            roleExecutor: async () => await new Promise<never>(() => undefined),
          },
        ),
      /timed out after 25ms/,
    );

    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runName === runName),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ runName, forceAfterMs: 0 }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runSparkTask records native timeout failure and leaves no active child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-task-runtime-timeout-cleanup-"));
  const runName = "task-timeout-cleanup-test";
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Timeout cleanup", description: "timeout" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Timeout child",
      description: "Run a child that must be timed out.",
      roleRef: "role:builtin-worker",
      plan: {
        objective: "Verify runtime timeout cleanup for a nonresponsive child role-run.",
        contextRefs: [],
        constraints: [],
        nonGoals: [],
        successCriteria: [
          "Test assertion verifies the task run is failed with runtime_timeout.",
          "Test assertion verifies the active role-run registry has no child for the timed-out run name.",
        ],
        evidenceRequired: ["Focused test assertions cover task status and active child cleanup."],
        steps: ["Run a fake Pi child that ignores SIGTERM and assert cleanup after timeout."],
        riskLevel: "normal",
        openQuestions: [],
        askRefs: [],
      },
    });

    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: "pi",
      timeoutMs: 25,
      sessionModel: "test/model",
      roleExecutor: async () => await new Promise<never>(() => undefined),
      claim: { sessionId: "spark:test", runName },
    });

    assert.equal(run.status, "failed");
    assert.equal(run.failureKind, "runtime_timeout");
    assert.equal(graph.getTask(task.ref).status, "failed");
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runName === runName),
      false,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ runName, forceAfterMs: 0 }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark runtime role dispatch inherits session model when no role model is saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-runtime-session-model-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    const registry = new RoleRegistry();
    const result = await runRoleInstructionOnly(
      registry,
      { roleRef: "role:builtin-worker", instruction: "Run with the session model." },
      {
        dryRun: false,
        cwd: dir,
        timeoutMs: 15_000,
        sessionModel: "test/model",
        roleExecutor: async (input) => ({
          record: { ...input.record, status: "succeeded", finishedAt: "2026-06-22T00:00:00.000Z" },
          stdout: "Runtime session model result.",
          stderr: "",
          jsonEvents: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Runtime session model result." }],
              },
            },
          ],
        }),
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

void test("spark runtime role dispatch passes per-run env and tool policy to injected executor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-runtime-env-tools-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenAllowedTools: string[] | undefined;
    const result = await runRoleInstructionOnly(
      new RoleRegistry(),
      { roleRef: "role:builtin-worker", instruction: "Run with env/tool policy." },
      {
        dryRun: false,
        cwd: dir,
        timeoutMs: 15_000,
        sessionModel: "test/model",
        env: { GRAFT_BASE_REF: "tree:native-base" },
        allowedTools: ["graft_read", "graft_write"],
        roleExecutor: async (input) => {
          seenEnv = input.env;
          seenAllowedTools = input.role.allowedTools;
          return {
            record: {
              ...input.record,
              status: "succeeded",
              finishedAt: "2026-06-22T00:00:00.000Z",
            },
            stdout: "env tools ok",
            stderr: "",
            jsonEvents: [
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "env tools ok" }] },
              },
            ],
          };
        },
      },
    );

    assert.equal(result.record.status, "succeeded");
    assert.equal(seenEnv?.GRAFT_BASE_REF, "tree:native-base");
    assert.deepEqual(seenAllowedTools, ["graft_read", "graft_write"]);
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark runtime role dispatch passes per-run env and tool policy to injected executor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-runtime-injected-env-tools-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = join(dir, "home");
  try {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenAllowedTools: string[] | undefined;
    const result = await runRoleInstructionOnly(
      new RoleRegistry(),
      { roleRef: "role:builtin-worker", instruction: "Run injected with env/tool policy." },
      {
        dryRun: false,
        cwd: dir,
        timeoutMs: 15_000,
        sessionModel: "test/model",
        env: { GRAFT_BASE_REF: "tree:injected-base" },
        allowedTools: ["graft_read", "graft_candidate_from_scratch"],
        roleExecutor: async (input) => {
          seenEnv = input.env;
          seenAllowedTools = input.role.allowedTools;
          return {
            record: {
              ...input.record,
              status: "succeeded",
              finishedAt: "2026-06-22T00:00:00.000Z",
            },
            stdout: "injected ok",
            stderr: "",
            jsonEvents: [
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "injected ok" }] },
              },
            ],
          };
        },
      },
    );

    assert.equal(result.record.status, "succeeded");
    assert.equal(seenEnv?.GRAFT_BASE_REF, "tree:injected-base");
    assert.deepEqual(seenAllowedTools, ["graft_read", "graft_candidate_from_scratch"]);
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-roles rejects malformed role model settings stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-model-settings-invalid-"));
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

void test("spark-roles rejects role spec model frontmatter", () => {
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

void test("spark-roles runs daemon-native executor and records run metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-launcher-"));
  try {
    const result = await runRole({
      runRef: "run:launcher-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Implement.",
      piCommand: "ignored-pi",
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      now: () => "2026-05-21T00:00:00.000Z",
      nativeExecutor: async (input) => ({
        record: { ...input.record, status: "succeeded", finishedAt: "2026-05-21T00:00:00.000Z" },
        stdout: 'not-json\n{"type":"done"}\n',
        stderr: "diagnostic\n",
        jsonEvents: [{ type: "start" }, { type: "done" }],
      }),
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

void test("runRole forwards noSession to native executor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-no-session-native-"));
  try {
    let seenNoSession: boolean | undefined;
    let seenSessionPersistence: string | undefined;
    const result = await runRole({
      runRef: "run:no-session-native",
      roleRef: "role:builtin-reviewer",
      systemPrompt: "You are a reviewer.",
      instruction: "Review anonymously.",
      piCommand: "ignored-pi",
      cwd: dir,
      sessionDir: join(dir, "sessions"),
      noSession: true,
      nativeExecutor: async (input) => {
        seenNoSession = input.noSession;
        seenSessionPersistence = input.sessionPersistence;
        return {
          record: {
            ...input.record,
            status: "succeeded",
            finishedAt: "2026-05-21T00:00:00.000Z",
            sessionPersistence: input.sessionPersistence,
          },
          stdout: "approved",
          stderr: "",
          jsonEvents: [],
        };
      },
    });

    assert.equal(seenNoSession, true);
    assert.equal(seenSessionPersistence, "anonymous");
    assert.equal(result.record.noSession, true);
    assert.equal(result.record.sessionPersistence, "anonymous");
    assert.equal(result.record.sessionDir, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-roles daemon-native runs do not depend on child stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-ignore-stdin-"));
  try {
    const result = await runRole({
      runRef: "run:ignore-stdin-test",
      roleRef: "role:builtin-reviewer",
      systemPrompt: "You are a reviewer.",
      instruction: "Review.",
      piCommand: "ignored-pi",
      cwd: dir,
      timeoutMs: 15_000,
      stdinMode: "ignore",
      nativeExecutor: async (input) => ({
        record: { ...input.record, status: "succeeded", finishedAt: new Date().toISOString() },
        stdout: "",
        stderr: "",
        jsonEvents: [{ type: "stdin", ended: true }],
      }),
    });

    assert.equal(result.record.status, "succeeded");
    assert.deepEqual(result.jsonEvents.at(-1), { type: "stdin", ended: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-roles preserves daemon-native stdout and JSONL results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-tail-capture-"));
  try {
    const result = await runRole({
      runRef: "run:tail-capture-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Report after large output.",
      piCommand: "ignored-pi",
      cwd: dir,
      nativeExecutor: async (input) => ({
        record: { ...input.record, status: "succeeded", finishedAt: new Date().toISOString() },
        stdout: `${"A".repeat(1024)}\ntail result delivered`,
        stderr: "",
        jsonEvents: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "tail result delivered" }],
            },
          },
        ],
      }),
    });

    assert.match(result.stdout, /tail result delivered/);
    assert.deepEqual(result.jsonEvents.at(-1), {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "tail result delivered" }],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-roles decrements role run depth for daemon-native runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-depth-env-"));
  try {
    const depthExecutor: ExtensionRoleRunner = async (input) => ({
      record: { ...input.record, status: "succeeded", finishedAt: new Date().toISOString() },
      stdout: "",
      stderr: "",
      jsonEvents: [{ type: "depth", depth: input.env?.[ROLE_RUN_DEPTH_ENV] }],
    });

    const defaultDepth = await runRole({
      runRef: "run:default-depth-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Report depth.",
      piCommand: "ignored-pi",
      cwd: dir,
      env: roleDepthTestEnv(),
      nativeExecutor: depthExecutor,
    });
    assert.deepEqual(defaultDepth.jsonEvents.at(-1), { type: "depth", depth: "3" });

    const explicitDepth = await runRole({
      runRef: "run:explicit-depth-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Report depth.",
      piCommand: "ignored-pi",
      cwd: dir,
      env: roleDepthTestEnv("2"),
      nativeExecutor: depthExecutor,
    });
    assert.deepEqual(explicitDepth.jsonEvents.at(-1), { type: "depth", depth: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-roles refuses to spawn when role run depth is exhausted", async () => {
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

void test("spark-roles tracks and cancels active daemon-native runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-cancel-"));
  try {
    const run = runRole({
      runRef: "run:cancel-test",
      roleRef: "role:builtin-worker",
      systemPrompt: "You are a worker.",
      instruction: "Wait.",
      piCommand: "ignored-pi",
      cwd: dir,
      timeoutMs: 15_000,
      nativeExecutor: async (input) =>
        await new Promise((resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("native aborted")), {
            once: true,
          });
        }),
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

void test("spark-roles enforces timeout control for daemon-native runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-timeout-"));
  try {
    await assert.rejects(
      runRole({
        runRef: "run:timeout-test",
        roleRef: "role:builtin-worker",
        systemPrompt: "You are a worker.",
        instruction: "Wait.",
        piCommand: "ignored-pi",
        cwd: dir,
        timeoutMs: 10,
        nativeExecutor: async () => await new Promise(() => undefined),
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

void test("spark-roles defaults omitted role launch but rejects unknown launches", () => {
  assert.equal(normalizeRoleLaunchMode(undefined), "fresh");
  assert.equal(normalizeRoleLaunchMode("fresh"), "fresh");
  assert.equal(normalizeRoleLaunchMode("forked"), "forked");
  assert.throws(() => normalizeRoleLaunchMode("legacy-mode"), /unsupported role launch mode/);
});

void test("spark-roles parses JSONL tolerantly", () => {
  assert.deepEqual(parsePiJsonlEvents('{"type":"start"}\nnot-json\n{"type":"stop"}\n'), [
    { type: "start" },
    { type: "stop" },
  ]);
});

void test("spark-roles rejects legacy role aliases instead of normalizing them", () => {
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
