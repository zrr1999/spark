import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  sparkSessionSnapshotPageSchema,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { channelReplyDeliveryForCompletion } from "./spark/session-run.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

describe("daemon session control admission", () => {
  it("freezes an originating QQ binding into the durable child invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-origin-binding-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "origin-binding-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-worker", scope: { kind: "daemon" } });
    try {
      const originBinding = {
        workspaceId: "workspace-original",
        adapter: "qqbot" as const,
        adapterId: "qq-account-original",
        adapterAccountIdentity: "channel-account:qqbot:original",
        externalKey: "qqbot:c2c:user-original",
        recipient: "c2c:user-original",
      };
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-worker",
          payload: {
            sessionId: "session-worker",
            prompt: "complete the delegated work",
            idempotencyKey: "origin-binding-request",
            originBinding,
          },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      expect(invocation.task).toMatchObject({
        channelReply: {
          workspaceId: "workspace-original",
          adapter: "qqbot",
          adapterId: "qq-account-original",
          adapterAccountIdentity: "channel-account:qqbot:original",
          recipient: "c2c:user-original",
        },
        channelContext: { externalKey: "qqbot:c2c:user-original" },
      });
      expect(
        channelReplyDeliveryForCompletion(
          invocation.task as never,
          invocation.invocationId,
          "final",
          { assistantText: "delegated result" },
        ),
      ).toMatchObject({
        workspaceId: "workspace-original",
        adapterId: "qq-account-original",
        adapterAccountIdentity: "channel-account:qqbot:original",
        externalKey: "qqbot:c2c:user-original",
        target: { recipient: "c2c:user-original" },
        text: "delegated result",
      });

      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            kind: "turn.submit.request",
            scope: "any",
            sessionId: "session-worker",
            payload: {
              sessionId: "session-worker",
              prompt: "complete the delegated work",
              idempotencyKey: "origin-binding-request",
              originBinding: { ...originBinding, adapterId: "qq-account-drifted" },
            },
          },
        ),
      ).rejects.toThrow(/idempotency conflict/u);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local-origin turn submission compatible without a channel binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-local-origin-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "local-origin-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-local", scope: { kind: "daemon" } });
    try {
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-local",
          payload: { sessionId: "session-local", prompt: "local work" },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      expect(invocation.task).not.toHaveProperty("channelReply");
      expect(invocation.task).not.toHaveProperty("channelContext");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("converges concurrent lease claimants on one semantic turn despite dynamic model drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-admission-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "admission-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({ sessionId: "session-race", scope: { kind: "daemon" } });

    const firstModel = deferred<{ providerName: string; modelId: string }>();
    let modelReadCount = 0;
    const effectiveModel = vi.fn(async () => {
      modelReadCount += 1;
      return modelReadCount === 1
        ? await firstModel.promise
        : { providerName: "provider-b", modelId: "model-b" };
    });
    const modelControl = {
      effectiveModel,
      prepareModel: vi.fn(async () => undefined),
      effectiveThinkingLevel: vi.fn(async () => undefined),
    } as unknown as SparkDaemonModelControl;
    const request = {
      kind: "turn.submit.request" as const,
      scope: "daemon" as const,
      sessionId: "session-race",
      idempotencyKey: "idem_10000000000000000000000000000000",
      payload: { sessionId: "session-race", prompt: "admit exactly once" },
    };
    const options = {
      paths,
      db,
      sessionRegistry,
      modelControl,
      actor: "spark-daemon-runtime-ws" as const,
    };

    try {
      const slowClaimant = executeSparkDaemonSessionControl(options, request);
      await vi.waitFor(() => expect(effectiveModel).toHaveBeenCalledTimes(1));
      const winningClaimant = await executeSparkDaemonSessionControl(options, request);
      firstModel.resolve({ providerName: "provider-a", modelId: "model-a" });
      const reclaimedClaimant = await slowClaimant;

      expect(reclaimedClaimant).toEqual(winningClaimant);
      expect(
        new SparkInvocationStore(db).findByIdempotencyKey(request.idempotencyKey),
      ).toMatchObject({
        invocationId: winningClaimant.invocationId,
        task: { model: "provider-b/model-b" },
      });
      expect(await sessionRegistry.get(request.sessionId)).toMatchObject({ status: "running" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects authoritative running and queued turns in session snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-pending-truth-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "pending-truth-test",
      daemonCwd: root,
    });
    const sessionId = "session-pending-truth";

    try {
      await sessionRegistry.create({ sessionId, scope: { kind: "daemon" } });
      const store = new SparkInvocationStore(db);
      const running = store.submit({
        sessionId,
        prompt: "currently running",
        task: { type: "session.run", sessionId, prompt: "currently running" },
        now: "2026-07-17T07:46:14.348Z",
      });
      await sessionRegistry.recordTurnQueued(sessionId);
      const queuedOnlySession = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.get.request",
          scope: "any",
          sessionId,
          payload: { sessionId },
        },
      );
      expect(queuedOnlySession.result.session).toMatchObject({ status: "ready" });
      const queuedOnlyResponse = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      const queuedOnlyPage = sparkSessionSnapshotPageSchema.parse(queuedOnlyResponse.result);
      expect(queuedOnlyPage.snapshot.status).toBe("queued");
      expect(queuedOnlyPage.snapshot.pendingTurns).toMatchObject([
        { invocationId: running.invocationId, status: "queued" },
      ]);

      store.claimNext("worker-pending-truth", "2026-07-17T07:46:14.589Z");
      const queued = store.submit({
        sessionId,
        prompt: "actual follow-up",
        task: { type: "session.run", sessionId, prompt: "actual follow-up" },
        now: "2026-07-17T07:47:00.000Z",
      });

      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      const page = sparkSessionSnapshotPageSchema.parse(response.result);

      expect(page.snapshot.status).toBe("running");
      expect(page.snapshot.pendingTurns).toEqual([
        {
          invocationId: running.invocationId,
          prompt: "currently running",
          status: "running",
          createdAt: "2026-07-17T07:46:14.348Z",
          startedAt: "2026-07-17T07:46:14.589Z",
        },
        {
          invocationId: queued.invocationId,
          prompt: "actual follow-up",
          status: "queued",
          createdAt: "2026-07-17T07:47:00.000Z",
        },
      ]);
      expect(page.snapshot.messages.map((message) => message.metadata.invocationStatus)).toEqual([
        "running",
        "queued",
      ]);

      store.complete(running.invocationId, {
        status: "succeeded",
        now: "2026-07-17T07:48:00.000Z",
      });
      const queuedFollowerSession = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.get.request",
          scope: "any",
          sessionId,
          payload: { sessionId },
        },
      );
      expect(queuedFollowerSession.result.session).toMatchObject({ status: "ready" });

      const queuedFollowerSnapshot = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      expect(
        sparkSessionSnapshotPageSchema.parse(queuedFollowerSnapshot.result).snapshot,
      ).toMatchObject({
        status: "queued",
        pendingTurns: [{ invocationId: queued.invocationId, status: "queued" }],
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes the runtime workspace binding onto submitted turns for lifecycle delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-binding-route-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const workspaceId = "ws_binding_route";
    const bindingId = "rtwb_binding_route";
    const workspace = registerWorkspace(db, {
      serverUrl: "https://cockpit.example",
      serverBindingId: bindingId,
      serverWorkspaceId: workspaceId,
      localWorkspaceKey: "binding-route",
      displayName: "Binding route",
      localPath: root,
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "binding-route-test",
      daemonCwd: root,
    });
    const sessionId = "session-binding-route";

    try {
      await sessionRegistry.create({
        sessionId,
        workspaceId,
        scope: { kind: "workspace", workspaceId },
      });
      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "turn.submit.request",
          scope: "workspace",
          workspaceId,
          workspaceBindingId: bindingId,
          sessionId,
          idempotencyKey: "idem_binding_route_00000000000000000000",
          payload: { sessionId, prompt: "keep lifecycle on this uplink" },
        },
      );
      const invocation = new SparkInvocationStore(db).require(response.invocationId!);

      expect(workspace.id).toBe(bindingId);
      expect(invocation).toMatchObject({
        workspaceBindingId: bindingId,
        task: { workspaceBindingId: bindingId, workspaceId },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects workspace aliases without merging same-path workspace identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-workspace-alias-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const localWorkspace = registerWorkspace(db, {
      localPath: root,
      localWorkspaceKey: "spark",
      displayName: "Spark",
    });
    const cockpitWorkspaceId = "ws_cockpit_workspace";
    const cockpitBindingId = "rtwb_cockpit_workspace";
    registerWorkspace(db, {
      serverUrl: "https://cockpit.example",
      serverBindingId: cockpitBindingId,
      serverWorkspaceId: cockpitWorkspaceId,
      localPath: root,
      localWorkspaceKey: "spore",
      displayName: "Spore",
    });
    const otherWorkspaceId = "ws_other_cockpit";
    registerWorkspace(db, {
      serverUrl: "https://other-cockpit.example",
      serverBindingId: "rtwb_other_cockpit",
      serverWorkspaceId: otherWorkspaceId,
      localPath: root,
      localWorkspaceKey: "spore",
      displayName: "Other Spore",
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "workspace-alias-test",
      daemonCwd: root,
    });
    await sessionRegistry.create({
      sessionId: "session-local-tui",
      scope: { kind: "workspace", workspaceId: localWorkspace.id },
      workspaceId: localWorkspace.id,
      cwd: root,
    });
    await sessionRegistry.create({
      sessionId: "session-cockpit",
      scope: { kind: "workspace", workspaceId: cockpitWorkspaceId },
      workspaceId: cockpitWorkspaceId,
      cwd: root,
    });
    await sessionRegistry.create({
      sessionId: "session-other-cockpit",
      scope: { kind: "workspace", workspaceId: otherWorkspaceId },
      workspaceId: otherWorkspaceId,
      cwd: root,
    });

    try {
      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.list.request",
          scope: "workspace",
          workspaceId: cockpitWorkspaceId,
          workspaceBindingId: cockpitBindingId,
          payload: { scope: { kind: "workspace", workspaceId: cockpitWorkspaceId } },
        },
      );

      expect(response.result.sessions).toEqual([
        expect.objectContaining({
          sessionId: "session-cockpit",
          scope: { kind: "workspace", workspaceId: cockpitWorkspaceId },
          workspaceId: cockpitWorkspaceId,
        }),
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks a byte-capped transcript with a strictly advancing exclusive cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-pages-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "pagination-test",
      daemonCwd: root,
    });
    const sessionId = "session-byte-capped-pages";
    const transcriptPath = join(root, "session.jsonl");
    const expectedIds = Array.from({ length: 18 }, (_, index) => `msg_${index}`);
    const entries = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-07-17T00:00:00.000Z",
        cwd: root,
      },
      ...expectedIds.map((id, index) => ({
        type: "message",
        id,
        parentId: index === 0 ? null : expectedIds[index - 1],
        timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, index + 1)).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${id}:${"large-message".repeat(500)}`,
        },
      })),
    ];
    writeFileSync(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    try {
      await sessionRegistry.create({ sessionId, scope: { kind: "daemon" } });
      await sessionRegistry.recordRun({ sessionId, sessionPath: transcriptPath });
      const requestPage = async (beforeMessageId?: string): Promise<SparkSessionSnapshotPage> => {
        const response = await executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
          {
            kind: "session.snapshot.request",
            scope: "any",
            sessionId,
            payload: {
              sessionId,
              messageLimit: 32,
              ...(beforeMessageId ? { beforeMessageId } : {}),
            },
          },
        );
        return sparkSessionSnapshotPageSchema.parse(response.result);
      };

      const chronologicalPages: string[][] = [];
      let cursor: string | undefined;
      let laterMessages = 0;
      let firstPageSize = 0;
      while (true) {
        const page = await requestPage(cursor);
        if (firstPageSize === 0) firstPageSize = page.history.loadedMessages;
        expect(page.history.totalMessages).toBe(expectedIds.length);
        expect(page.history.laterMessages).toBe(laterMessages);
        expect(page.snapshot.messages.length).toBeGreaterThan(0);
        chronologicalPages.unshift(page.snapshot.messages.map(({ id }) => id));
        laterMessages += page.history.loadedMessages;
        if (!page.history.hasEarlierMessages) break;
        expect(page.history.nextBeforeMessageId).toBe(page.snapshot.messages[0]?.id);
        expect(page.history.nextBeforeMessageId).not.toBe(cursor);
        cursor = page.history.nextBeforeMessageId;
      }

      expect(firstPageSize).toBeLessThan(expectedIds.length);
      expect(chronologicalPages.flat()).toEqual(expectedIds);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
