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
      version: 2,
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

  it("creates, binds, lists, and archives sessions", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      workspaceId: "ws_demo",
      title: "Ops",
      role: "coordinator",
    });
    expect(created.status).toBe("ready");
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
});
