import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SparkSessionRegistry, SparkSessionRegistryError } from "./registry.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRegistry(): Promise<SparkSessionRegistry> {
  const root = await mkdtemp(join(tmpdir(), "spark-session-registry-"));
  roots.push(root);
  return new SparkSessionRegistry({ rootDir: root });
}

describe("SparkSessionRegistry", () => {
  it("reads v1 workspace records as canonical workspace ownership", async () => {
    const registry = await tempRegistry();
    await writeFile(
      registry.filePath,
      `${JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "sess_legacy",
            workspaceId: "legacy-workspace",
            status: "ready",
            bindings: [],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(registry.get("sess_legacy")).resolves.toMatchObject({
      scope: { kind: "workspace", workspaceId: "legacy-workspace" },
      workspaceId: "legacy-workspace",
    });

    await registry.create({ workspaceId: "ws_new" });
    expect(JSON.parse(await readFile(registry.filePath, "utf8"))).toMatchObject({
      version: 3,
      sessions: [
        { sessionId: "sess_legacy", scope: { kind: "workspace" } },
        { scope: { kind: "workspace", workspaceId: "ws_new" } },
      ],
    });
  });

  it("stores and filters daemon-global sessions without a workspace alias", async () => {
    const registry = await tempRegistry();
    const global = await registry.create({
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "install-test" },
      cwd: "/daemon/base",
    });
    await registry.create({ workspaceId: "ws_other" });

    expect(global).toMatchObject({
      scope: { kind: "daemon", daemonId: "install-test" },
      cwd: "/daemon/base",
    });
    expect(global).not.toHaveProperty("workspaceId");
    await expect(
      registry.list({ scope: { kind: "daemon", daemonId: "install-test" } }),
    ).resolves.toEqual([global]);
  });

  it("creates, binds, lists, and archives sessions after channel unbind", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      workspaceId: "ws_demo",
      title: "Ops",
      role: "coordinator",
    });
    expect(created).toMatchObject({
      status: "ready",
      role: "coordinator",
      title: "coordinator",
    });
    expect(created.sessionId).toMatch(/^sess_/);

    const bound = await registry.bind({
      sessionId: created.sessionId,
      externalKey: "feishu:chat:oc_demo",
    });
    expect(bound.bindings).toHaveLength(1);
    expect(bound.bindings[0]?.externalKey).toBe("feishu:chat:oc_demo");
    expect(bound.bindings[0]?.adapter).toBe("feishu");

    const listed = await registry.list({ workspaceId: "ws_demo" });
    expect(listed.map((session) => session.sessionId)).toEqual([created.sessionId]);

    const resolved = await registry.resolveBinding({
      externalKey: "feishu:chat:oc_demo",
    });
    expect(resolved.sessionId).toBe(created.sessionId);

    await expect(registry.archive(created.sessionId)).rejects.toMatchObject({
      code: "session_channel_bound",
    } satisfies Partial<SparkSessionRegistryError>);
    await expect(registry.get(created.sessionId)).resolves.toMatchObject({
      status: "ready",
      bindings: [{ kind: "channel", externalKey: "feishu:chat:oc_demo" }],
    });

    const unbound = await registry.unbind(created.sessionId, "feishu:chat:oc_demo");
    expect(unbound.bindings).toEqual([]);

    const archived = await registry.archive(created.sessionId);
    expect(archived.status).toBe("archived");
    expect(await registry.list()).toEqual([]);
    expect(await registry.list({ includeArchived: true })).toHaveLength(1);
  });

  it("rejects binding conflicts and unbound resolve by default", async () => {
    const registry = await tempRegistry();
    const first = await registry.create({ workspaceId: "ws_a", title: "A" });
    const second = await registry.create({ workspaceId: "ws_a", title: "B" });
    await registry.bind({
      sessionId: first.sessionId,
      externalKey: "infoflow:user:u1",
    });

    await expect(
      registry.bind({
        sessionId: second.sessionId,
        externalKey: "infoflow:user:u1",
      }),
    ).rejects.toMatchObject({
      code: "binding_conflict",
    } satisfies Partial<SparkSessionRegistryError>);

    await expect(
      registry.resolveBinding({ externalKey: "feishu:chat:missing" }),
    ).rejects.toMatchObject({
      code: "binding_unbound",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("can create+bind on unbound when policy is create", async () => {
    const registry = await tempRegistry();
    const resolved = await registry.resolveBinding({
      externalKey: "conv:feishu:oc_auto",
      onUnbound: "create",
      create: { workspaceId: "ws_auto", title: "Auto" },
    });
    expect(resolved.bindings[0]?.externalKey).toBe("conv:feishu:oc_auto");
    expect(resolved.title).toBe("Auto");
  });

  it("upgrades a legacy binding and follows one provider account across an adapter rename", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_adapter", title: "Adapter" });
    await registry.bind({
      sessionId: created.sessionId,
      externalKey: "infoflow:user:u1",
    });

    const upgraded = await registry.resolveBinding({
      externalKey: "infoflow:user:u1",
      adapterId: "info-main",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      allowLegacyAccountClaim: true,
    });
    expect(upgraded.bindings).toEqual([
      expect.objectContaining({
        adapter: "infoflow",
        adapterId: "info-main",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ]);

    const renamed = await registry.resolveBinding({
      externalKey: "infoflow:user:u1",
      adapterId: "info-renamed",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
    });
    expect(renamed.bindings).toEqual([
      expect.objectContaining({
        adapterId: "info-renamed",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ]);
  });

  it("separates one external key across provider accounts", async () => {
    const registry = await tempRegistry();
    const first = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-main",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      onUnbound: "create",
      create: { workspaceId: "ws_accounts", title: "Account A" },
    });
    const second = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-backup",
      adapterAccountIdentity: "channel-account:infoflow:account-b",
      onUnbound: "create",
      create: { workspaceId: "ws_accounts", title: "Account B" },
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(
      registry.resolveBinding({
        externalKey: "infoflow:user:shared-user",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).resolves.toMatchObject({ sessionId: first.sessionId });
    await expect(
      registry.resolveBinding({
        externalKey: "infoflow:user:shared-user",
        adapterAccountIdentity: "channel-account:infoflow:account-b",
      }),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
    await expect(
      registry.resolveBinding({ externalKey: "infoflow:user:shared-user" }),
    ).rejects.toMatchObject({ code: "binding_ambiguous" });
  });

  it("does not guess which configured account owns an unscoped legacy binding", async () => {
    const registry = await tempRegistry();
    const legacy = await registry.create({ workspaceId: "ws_legacy", title: "Legacy" });
    await registry.bind({
      sessionId: legacy.sessionId,
      externalKey: "infoflow:user:shared-user",
    });

    const modern = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-secondary",
      adapterAccountIdentity: "channel-account:infoflow:secondary",
      onUnbound: "create",
      create: { workspaceId: "ws_legacy", title: "Secondary account" },
    });

    expect(modern.sessionId).not.toBe(legacy.sessionId);
    const unchangedLegacy = await registry.get(legacy.sessionId);
    expect(unchangedLegacy?.bindings).toEqual([
      expect.objectContaining({ externalKey: "infoflow:user:shared-user" }),
    ]);
    expect(unchangedLegacy?.bindings[0]).not.toHaveProperty("adapterId");
    expect(unchangedLegacy?.bindings[0]).not.toHaveProperty("adapterAccountIdentity");
  });

  it("unbinds an exact provider account and refuses an ambiguous legacy unbind", async () => {
    const registry = await tempRegistry();
    const session = await registry.create({ workspaceId: "ws_unbind_accounts" });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "qqbot:c2c:shared-user",
      adapterId: "qq-main",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
    });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "qqbot:c2c:shared-user",
      adapterId: "qq-backup",
      adapterAccountIdentity: "channel-account:qqbot:account-b",
    });

    await expect(registry.unbind(session.sessionId, "qqbot:c2c:shared-user")).rejects.toMatchObject(
      { code: "binding_ambiguous" },
    );
    const updated = await registry.unbind(
      session.sessionId,
      "qqbot:c2c:shared-user",
      "channel-account:qqbot:account-a",
    );
    expect(updated.bindings).toEqual([
      expect.objectContaining({
        adapterId: "qq-backup",
        adapterAccountIdentity: "channel-account:qqbot:account-b",
      }),
    ]);
  });

  it("persists a session-owned model selection", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_model", title: "Model" });
    const now = new Date("2026-07-10T06:00:00.000Z");

    const updated = await registry.setModel(
      created.sessionId,
      {
        providerName: "openai",
        modelId: "gpt-5-codex",
        providerLabel: "OpenAI",
        modelLabel: "GPT-5 Codex",
      },
      now,
    );

    expect(updated.model).toEqual({
      providerName: "openai",
      modelId: "gpt-5-codex",
      providerLabel: "OpenAI",
      modelLabel: "GPT-5 Codex",
    });
    expect(updated.updatedAt).toBe(now.toISOString());
    await expect(registry.get(created.sessionId)).resolves.toMatchObject({ model: updated.model });
  });

  it("rejects model changes for unknown and archived sessions", async () => {
    const registry = await tempRegistry();
    const model = { providerName: "openai", modelId: "gpt-5-codex" };

    await expect(registry.setModel("sess_missing", model)).rejects.toMatchObject({
      code: "session_not_found",
    } satisfies Partial<SparkSessionRegistryError>);

    const created = await registry.create({ workspaceId: "ws_model" });
    await registry.archive(created.sessionId);
    await expect(registry.setModel(created.sessionId, model)).rejects.toMatchObject({
      code: "session_archived",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("sets a generated role once and mirrors it to the compatibility title", async () => {
    const registry = await tempRegistry();
    const untitled = await registry.create({
      sessionId: "sess_untitled",
      workspaceId: "ws_title",
      now: new Date("2026-07-10T07:00:00.000Z"),
    });

    const titled = await registry.setRoleIfMissing(
      untitled.sessionId,
      "  Runtime Operations  ",
      new Date("2026-07-10T07:01:00.000Z"),
    );
    expect(titled).toMatchObject({
      role: "Runtime Operations",
      title: "Runtime Operations",
      updatedAt: "2026-07-10T07:01:00.000Z",
    });
    await expect(
      registry.setRoleIfMissing(
        untitled.sessionId,
        "Do not replace the first role",
        new Date("2026-07-10T07:02:00.000Z"),
      ),
    ).resolves.toEqual(titled);

    const channel = await registry.create({
      sessionId: "sess_channel_title",
      workspaceId: "ws_title",
    });
    const bound = await registry.bind({
      sessionId: channel.sessionId,
      externalKey: "infoflow:user:alice",
    });
    await expect(
      registry.setRoleIfMissing(channel.sessionId, "Do not name channels"),
    ).resolves.toEqual(bound);

    const archived = await registry.create({
      sessionId: "sess_archived_title",
      workspaceId: "ws_title",
    });
    const archivedRecord = await registry.archive(archived.sessionId);
    await expect(
      registry.setRoleIfMissing(archived.sessionId, "Do not name archives"),
    ).resolves.toEqual(archivedRecord);
  });

  it("keeps an explicit legacy or platform title outside role ownership", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_legacy_title", title: "Verifier" });

    expect(created).toMatchObject({ title: "Verifier" });
    expect(created.role).toBeUndefined();
  });

  it("records a completed native transcript idempotently without moving updatedAt backwards", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_recorded",
      workspaceId: "ws_recorded",
      now: new Date("2026-07-10T08:00:00.000Z"),
    });
    const first = await registry.recordRun({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_recorded.jsonl",
      now: new Date("2026-07-10T08:05:00.000Z"),
    });
    const replayed = await registry.recordRun({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_recorded.jsonl",
      now: new Date("2026-07-10T08:04:00.000Z"),
    });

    expect(first.sessionPath).toBe("/tmp/sessions/sess_recorded.jsonl");
    expect(first.status).toBe("ready");
    expect(replayed.updatedAt).toBe("2026-07-10T08:05:00.000Z");
    await expect(registry.get(created.sessionId)).resolves.toEqual(replayed);
  });

  it("binds a transcript without settling the turn and rejects implicit relocation", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_bound",
      workspaceId: "ws_bound",
      status: "running",
    });
    const bound = await registry.bindTranscriptPath({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_bound.jsonl",
    });

    expect(bound).toMatchObject({
      status: "running",
      sessionPath: "/tmp/sessions/sess_bound.jsonl",
    });
    await expect(
      registry.recordRun({
        sessionId: created.sessionId,
        sessionPath: "/tmp/sessions/another.jsonl",
      }),
    ).rejects.toMatchObject({
      code: "session_transcript_conflict",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("relocates an ordinary transcript only through an explicit path CAS", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_relocated",
      workspaceId: "ws_relocated",
    });
    await registry.bindTranscriptPath({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/before.jsonl",
    });

    await expect(
      registry.relocateTranscriptPath({
        sessionId: created.sessionId,
        expectedSessionPath: "/tmp/sessions/stale.jsonl",
        sessionPath: "/tmp/sessions/after.jsonl",
      }),
    ).rejects.toMatchObject({
      code: "session_transcript_cas_failed",
    } satisfies Partial<SparkSessionRegistryError>);
    await expect(
      registry.relocateTranscriptPath({
        sessionId: created.sessionId,
        expectedSessionPath: "/tmp/sessions/before.jsonl",
        sessionPath: "/tmp/sessions/after.jsonl",
      }),
    ).resolves.toMatchObject({
      sessionPath: "/tmp/sessions/after.jsonl",
    });
  });

  it("tracks queued and settled turns for rail ordering", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_turn",
      workspaceId: "ws_turn",
      now: new Date("2026-07-10T08:00:00.000Z"),
    });
    const running = await registry.recordTurnQueued(
      created.sessionId,
      new Date("2026-07-10T08:01:00.000Z"),
    );
    expect(running).toMatchObject({
      status: "running",
      updatedAt: "2026-07-10T08:01:00.000Z",
    });
    const ready = await registry.recordTurnSettled(
      created.sessionId,
      new Date("2026-07-10T08:02:00.000Z"),
    );
    expect(ready).toMatchObject({ status: "ready", updatedAt: "2026-07-10T08:02:00.000Z" });
  });

  it("hides side threads by default, fences generations, and archives them with their parent", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({
      sessionId: "parent",
      workspaceId: "ws_side",
      cwd: "/work",
    });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "child",
      mode: "contextual",
      sessionPath: "/tmp/child-1.jsonl",
    });
    expect(await registry.list()).toEqual([parent]);
    expect(await registry.list({ includeSideThreads: true })).toHaveLength(2);
    await expect(
      registry.resetSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 2,
        sessionPath: "/tmp/child-2.jsonl",
      }),
    ).rejects.toMatchObject({ code: "side_thread_generation_conflict" });
    const reset = await registry.resetSideThread({
      sessionId: child.sessionId,
      expectedGeneration: 1,
      sessionPath: "/tmp/child-2.jsonl",
    });
    expect(reset.relation).toMatchObject({ generation: 2 });
    await registry.archive(parent.sessionId);
    await expect(registry.get(child.sessionId)).resolves.toMatchObject({ status: "archived" });
  });

  it("inherits parent scope and refuses nested side-thread relations", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({ sessionId: "parent", workspaceId: "ws_a" });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      mode: "tangent",
    });
    expect(child.scope).toEqual(parent.scope);
    await expect(
      registry.ensureSideThread({ parentSessionId: child.sessionId, mode: "tangent" }),
    ).rejects.toMatchObject({ code: "side_thread_nesting_forbidden" });
  });

  it("keeps child configuration behind the Side Thread surface", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({ sessionId: "parent", workspaceId: "ws_side" });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "child",
      mode: "contextual",
    });

    await expect(
      registry.setModel(child.sessionId, { providerName: "provider", modelId: "model" }),
    ).rejects.toMatchObject({ code: "side_thread_mutation_forbidden" });
    await expect(registry.setThinkingLevel(child.sessionId, "high")).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });
    await expect(registry.archive(child.sessionId)).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });
    await expect(registry.unbind(child.sessionId, "qqbot:c2c:user")).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });

    const configured = await registry.configureSideThread({
      sessionId: child.sessionId,
      expectedGeneration: 1,
      model: { providerName: "provider", modelId: "model" },
      thinkingLevel: "high",
    });
    expect(configured).toMatchObject({
      model: { providerName: "provider", modelId: "model" },
      thinkingLevel: "high",
    });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 2,
        model: null,
      }),
    ).rejects.toMatchObject({ code: "side_thread_generation_conflict" });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "side_thread_config_empty" });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 1,
        model: null,
        thinkingLevel: null,
      }),
    ).resolves.not.toHaveProperty("model");
  });
});
