import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkSessionStore } from "@zendev-lab/spark-host/session-store";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { ensureDaemonSessionTranscript } from "./session-transcript-control.ts";
import { unifyDaemonSessionTranscripts } from "./session-transcript-unification.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon session transcript ownership", () => {
  it("preallocates and binds one stable transcript before execution", async () => {
    const harness = await createHarness("preallocate");
    const session = await harness.registry.create({
      sessionId: "sess_stable",
      workspaceId: "workspace",
    });

    const path = await ensureDaemonSessionTranscript({
      session,
      sparkHome: harness.transcriptSparkHome,
      registry: harness.registry,
    });

    expect(path).toBe(harness.store.canonicalSessionPath(session.sessionId));
    await expect(harness.store.load(path)).resolves.toMatchObject({
      header: { id: session.sessionId, cwd: harness.cwd },
      entries: [],
    });
    await expect(harness.registry.get(session.sessionId)).resolves.toMatchObject({
      sessionPath: path,
      status: "ready",
    });
  });

  it("fails closed when an unbound session already has multiple fragments", async () => {
    const harness = await createHarness("fragment-conflict");
    const session = await harness.registry.create({
      sessionId: "sess_fragmented",
      workspaceId: "workspace",
    });
    await harness.store.save(
      harness.store.createSession({
        id: session.sessionId,
        timestamp: "2026-07-20T00:00:00.000Z",
      }),
    );
    await harness.store.save(
      harness.store.createSession({
        id: session.sessionId,
        timestamp: "2026-07-21T00:00:00.000Z",
      }),
    );

    await expect(
      ensureDaemonSessionTranscript({
        session,
        sparkHome: harness.transcriptSparkHome,
        registry: harness.registry,
      }),
    ).rejects.toThrow("2 transcript fragments");
  });

  it("backs up and chains fragments before relocating the registry path", async () => {
    const harness = await createHarness("unify");
    const session = await harness.registry.create({
      sessionId: "sess_unify",
      workspaceId: "workspace",
    });
    const first = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    harness.store.appendMessage(first, { role: "user", content: "first" });
    await harness.store.save(first);
    const second = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-21T00:00:00.000Z",
    });
    harness.store.appendMessage(second, { role: "assistant", content: "second" });
    await harness.store.save(second);
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: second.path,
    });

    const backupRoot = join(harness.root, "backups");
    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });

    const targetPath = harness.store.canonicalSessionPath(session.sessionId);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        sourcePaths: [first.path, second.path],
        targetPath,
        entryCount: 2,
        changed: true,
      }),
    ]);
    const unified = await harness.store.load(targetPath);
    expect(unified.entries).toHaveLength(2);
    expect(unified.entries[1]?.parentId).toBe(unified.entries[0]?.id);
    await expect(harness.registry.get(session.sessionId)).resolves.toMatchObject({
      sessionPath: targetPath,
    });
    await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(backupRoot, session.sessionId))).toEqual([
      first.path.split("/").at(-1),
      second.path.split("/").at(-1),
    ]);

    const repeated = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot: join(harness.root, "unused-backup"),
      apply: true,
    });
    expect(repeated.sessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, changed: false }),
    ]);
  });
});

async function createHarness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `spark-transcript-${label}-`));
  roots.push(root);
  const cwd = join(root, "workspace");
  const transcriptSparkHome = join(root, "pi-agent");
  const registry = createDaemonSessionRegistry(join(root, "registry"), {
    resolveWorkspaceCwd: (workspaceId) => (workspaceId === "workspace" ? cwd : undefined),
  });
  return {
    root,
    cwd,
    transcriptSparkHome,
    registry,
    store: new SparkSessionStore({ cwd, sparkHome: transcriptSparkHome }),
  };
}
