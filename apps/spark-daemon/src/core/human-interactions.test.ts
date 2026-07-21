import { DatabaseSync } from "node:sqlite";
import {
  humanRequestCreatedEnvelopeSchema,
  parseSparkInteractionRequest,
  type SparkInteractionRequest,
} from "@zendev-lab/spark-protocol";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  SparkDaemonHumanInteractionBroker,
  type SparkDaemonHumanInteractionOpened,
  type SparkDaemonHumanInteractionRoute,
} from "./human-interactions.ts";
import { SparkDaemonHumanWaitRegistry } from "./human-waits.ts";

const RUNTIME_ID = `rt_${"1".repeat(32)}`;
const WORKSPACE_BINDING_ID = `rtwb_${"2".repeat(32)}`;
const LOCAL_WORKSPACE_BINDING_ID = `rtwb_${"3".repeat(32)}`;
const WORKSPACE_ID = `ws_${"4".repeat(32)}`;
const PROJECT_ID = `proj_${"5".repeat(32)}`;
const WORKSPACE_PATH = "/workspace/spark";
const NOW = "2026-07-14T00:00:00.000Z";
const SERVER_URL = "http://127.0.0.1:5173/";

interface SeedHumanRouteOptions {
  serverId?: string;
  serverUrl?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  workspacePath?: string;
  localWorkspaceKey?: string;
  displayName?: string;
  slug?: string;
}

function seedHumanRoute(db: DatabaseSync, options: SeedHumanRouteOptions = {}): void {
  const serverId = options.serverId ?? "rnsrv-test";
  const serverUrl = options.serverUrl ?? SERVER_URL;
  const workspaceBindingId = options.workspaceBindingId ?? WORKSPACE_BINDING_ID;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const workspacePath = options.workspacePath ?? WORKSPACE_PATH;
  const localWorkspaceKey = options.localWorkspaceKey ?? "server-spark";
  const displayName = options.displayName ?? "Spark";
  const slug = options.slug ?? "spark";
  db.prepare(
    `INSERT INTO daemon_servers (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run(serverId, serverUrl, NOW);
  db.prepare(
    `INSERT INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status,
       capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(workspaceBindingId, serverUrl, localWorkspaceKey, displayName, workspacePath, NOW, NOW);
  db.prepare(
    `INSERT INTO daemon_workspaces
      (id, server_id, server_workspace_id, name, slug, local_path, registered_at,
       last_known_status, last_status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
  ).run(workspaceBindingId, serverId, workspaceId, displayName, slug, workspacePath, NOW, NOW);
}

function primaryRuntimeId(route: SparkDaemonHumanInteractionRoute): string | undefined {
  return route.serverUrl === SERVER_URL ? RUNTIME_ID : undefined;
}

function askRequest(
  requestId: string,
  delivery: "blocking" | "async",
  timeoutMs?: number,
): SparkInteractionRequest {
  return parseSparkInteractionRequest({
    requestId,
    kind: "askFlow",
    title: "Choose a direction",
    prompt: "How should Spark continue?",
    delivery,
    ...(timeoutMs ? { timeoutMs } : {}),
    mode: "decision",
    source: "daemon",
    questions: [
      {
        id: "decision",
        prompt: "Continue?",
        type: "single",
        required: true,
        options: [
          {
            value: "yes",
            label: "Continue",
            description: "Resume execution",
            preview: "Proceed with the current plan.",
          },
          { value: "no", label: "Stop" },
        ],
      },
    ],
    metadata: { source: "test" },
  });
}

function interactionContext() {
  return {
    sessionId: "session-1",
    invocationId: "invocation-1",
    workspaceBindingId: WORKSPACE_BINDING_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    toolCallId: "tool-call-1",
    channel: {
      workspaceId: WORKSPACE_ID,
      adapterId: "qq-main",
      recipient: "c2c:user-1",
      actorId: "user-1",
      messageId: "message-1",
    },
  };
}

describe("SparkDaemonHumanInteractionBroker", () => {
  it("opens an async ask durably and immediately returns its human request handle", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const onOutboxReady = vi.fn(async () => undefined);
    const opened: SparkDaemonHumanInteractionOpened[] = [];
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
      onOutboxReady,
      onRequestOpened: async (input) => {
        opened.push(input);
      },
    });

    try {
      const response = await broker.interact(askRequest("interaction-async", "async"), {
        ...interactionContext(),
      });

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-async",
        status: "pending",
        nextAction: "resume",
        metadata: { delivery: "async" },
      });
      expect(response.kind === "askFlow" ? response.humanRequestId : undefined).toEqual(
        expect.any(String),
      );
      if (response.kind !== "askFlow" || !response.humanRequestId) {
        throw new Error("expected an async ask response with humanRequestId");
      }

      expect(waits.hasActive(response.humanRequestId)).toBe(false);
      expect(waits.get(response.humanRequestId)).toMatchObject({
        interactionRequestId: "interaction-async",
        delivery: "async",
        status: "pending",
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
      });
      expect(onOutboxReady).toHaveBeenCalledTimes(1);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({
          kind: "human.request.created",
          envelope: expect.objectContaining({
            type: "human.request.created",
            runtimeId: RUNTIME_ID,
            workspaceBindingId: WORKSPACE_BINDING_ID,
            workspaceId: WORKSPACE_ID,
            humanRequestId: response.humanRequestId,
            payload: expect.objectContaining({
              delivery: "async",
              interactionRequestId: "interaction-async",
            }),
          }),
        }),
      ]);
      const envelope = waits.listPendingOutbox()[0]?.envelope;
      expect(envelope).toBeDefined();
      const parsedEnvelope = humanRequestCreatedEnvelopeSchema.parse(envelope);
      expect(parsedEnvelope.invocationId).toMatch(/^inv_[a-f0-9]{32}$/u);
      expect(parsedEnvelope.payload.questions[0]?.options?.[0]?.preview).toBe(
        "Proceed with the current plan.",
      );

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        wait: { humanRequestId: response.humanRequestId, delivery: "async" },
        request: { requestId: "interaction-async", kind: "askFlow" },
        channel: { adapterId: "qq-main", recipient: "c2c:user-1" },
      });
      expect(opened[0]?.callbackOptions).toHaveLength(2);
      const firstCallback = opened[0]?.callbackOptions[0];
      expect(firstCallback?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(firstCallback?.token).not.toContain("interaction-async");
      expect(waits.findCallback(firstCallback?.token ?? "")).toMatchObject({
        wait: { humanRequestId: response.humanRequestId },
        questionId: "decision",
        value: "yes",
        label: "Continue",
      });
    } finally {
      db.close();
    }
  });

  it("keeps a blocking ask pending until delivery resolves its attached continuation", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      let settled = false;
      const pendingResponse = broker.interact(askRequest("interaction-blocking", "blocking", 500), {
        ...interactionContext(),
        sessionSource: "tui",
      });
      void pendingResponse.then(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      await Promise.resolve();
      expect(settled).toBe(false);
      const wait = waits.listPending()[0];
      expect(wait).toMatchObject({
        interactionRequestId: "interaction-blocking",
        delivery: "blocking",
        status: "pending",
      });
      expect(waits.hasActive(wait!.humanRequestId)).toBe(true);

      await expect(
        broker.respond(wait!, {
          status: "answered",
          answers: {
            decision: {
              values: ["yes"],
              labels: ["Continue"],
            },
          },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({
        outcome: "accepted",
        returnedToTool: true,
        winnerResponseId: expect.stringMatching(/^hres_/u),
      });

      const answeredResponse = await pendingResponse;
      expect(answeredResponse).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-blocking",
        humanRequestId: wait!.humanRequestId,
        status: "answered",
        answers: {
          decision: {
            values: ["yes"],
            labels: ["Continue"],
          },
        },
        nextAction: "resume",
        metadata: {
          delivery: "blocking",
          humanResponseId: expect.stringMatching(/^hres_/u),
        },
      });
      expect(answeredResponse.metadata.timedOut).toBeUndefined();
      expect(waits.hasActive(wait!.humanRequestId)).toBe(false);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            type: "human.response.recorded",
            runtimeId: RUNTIME_ID,
            workspaceBindingId: WORKSPACE_BINDING_ID,
            workspaceId: WORKSPACE_ID,
            payload: expect.objectContaining({
              source: "daemon",
              status: "answered",
            }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("durably closes a blocking ask when its human wait times out", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const response = await broker.interact(
        askRequest("interaction-human-timeout", "blocking", 10),
        interactionContext(),
      );

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-human-timeout",
        status: "cancelled",
        nextAction: "cancel",
        metadata: {
          delivery: "blocking",
          timedOut: true,
          humanResponseId: expect.stringMatching(/^hres_/u),
        },
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            payload: expect.objectContaining({ status: "cancelled" }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps a route-less TUI blocking ask locally answerable without a Cockpit outbox", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const onOutboxReady = vi.fn();
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
      onOutboxReady,
    });

    try {
      const pendingResponse = broker.interact(askRequest("interaction-local-tui", "blocking"), {
        sessionId: "session-local-tui",
        invocationId: "invocation-local-tui",
        sessionSource: "tui",
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      const wait = waits.listPending()[0]!;

      expect(wait.context).toMatchObject({
        sessionSource: "tui",
        cockpitProjected: false,
      });
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(onOutboxReady).not.toHaveBeenCalled();

      await expect(
        broker.respond(wait, {
          status: "answered",
          answers: { decision: "yes" },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({ outcome: "accepted", returnedToTool: true });
      await expect(pendingResponse).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-local-tui",
        status: "answered",
        answers: { decision: "yes" },
      });
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(onOutboxReady).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("settles a blocking wait from the daemon interaction event seen by the local TUI", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const request = askRequest("interaction-event-to-local-answer", "blocking");
    let observedRequests = 0;
    let localAnswer: Promise<void> | undefined;
    const runtime = new SparkHostRuntime({
      cwd: WORKSPACE_PATH,
      hasUI: true,
      sessionSource: "tui",
      invocationId: "invocation-event-to-local-answer",
      ui: {
        interaction: async (interactionRequest) =>
          await broker.interact(parseSparkInteractionRequest(interactionRequest), {
            sessionId: "session-event-to-local-answer",
            invocationId: "invocation-event-to-local-answer",
            sessionSource: "tui",
          }),
      },
    });
    runtime.setSessionId("session-event-to-local-answer");
    runtime.onDaemonEvent((event) => {
      if (event.type !== "daemon.interaction.request") return;
      observedRequests += 1;
      localAnswer = Promise.resolve().then(async () => {
        const wait = waits.requireUniquePendingInteraction({
          interactionRequestId: event.request.requestId,
          sessionId: event.sessionId,
          invocationId: event.invocationId,
        });
        await broker.respond(wait, {
          status: "answered",
          answers: { decision: "yes" },
          responseArtifactRefs: [],
        });
      });
    });

    try {
      const response = await runtime.requestInteraction(request);
      await localAnswer;
      expect(observedRequests).toBe(1);
      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-event-to-local-answer",
        status: "answered",
        answers: { decision: "yes" },
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("still blocks a route-less non-TUI ask instead of creating an unanswerable wait", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });

    try {
      await expect(
        broker.interact(askRequest("interaction-route-less-web", "blocking"), {
          sessionId: "session-route-less-web",
          invocationId: "invocation-route-less-web",
          sessionSource: "web",
        }),
      ).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-route-less-web",
        status: "blocked",
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("cancels a route-less TUI blocking ask without inventing a Cockpit settlement", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const abort = new AbortController();

    try {
      const pendingResponse = broker.interact(askRequest("interaction-local-abort", "blocking"), {
        sessionId: "session-local-abort",
        invocationId: "invocation-local-abort",
        sessionSource: "tui",
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      abort.abort();

      await expect(pendingResponse).resolves.toMatchObject({
        requestId: "interaction-local-abort",
        status: "cancelled",
        nextAction: "cancel",
      });
      expect(waits.listPending()).toEqual([]);
      expect(waits.listPendingOutbox()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("durably projects cancellation when a blocking daemon ask is aborted", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });
    const abort = new AbortController();

    try {
      const pendingResponse = broker.interact(askRequest("interaction-aborted", "blocking"), {
        ...interactionContext(),
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      abort.abort();

      await expect(pendingResponse).resolves.toMatchObject({
        kind: "askFlow",
        requestId: "interaction-aborted",
        status: "cancelled",
        nextAction: "cancel",
      });
      expect(waits.listPendingOutbox()).toEqual([
        expect.objectContaining({ kind: "human.request.created" }),
        expect.objectContaining({
          kind: "human.response.recorded",
          envelope: expect.objectContaining({
            type: "human.response.recorded",
            payload: expect.objectContaining({ source: "daemon", status: "cancelled" }),
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("maps a daemon-local workspace reference to its unique Cockpit route by local path", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    db.prepare(
      `INSERT INTO workspaces
        (id, server_url, local_workspace_key, display_name, local_path, status,
         capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, '', 'local-spark', 'Local Spark', ?, 'available', '{}', '{}', ?, ?)`,
    ).run(LOCAL_WORKSPACE_BINDING_ID, WORKSPACE_PATH, NOW, NOW);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const response = await broker.interact(askRequest("interaction-local", "async"), {
        sessionId: "session-local",
        invocationId: "queue-file.json",
        workspaceId: LOCAL_WORKSPACE_BINDING_ID,
      });

      expect(response).toMatchObject({
        kind: "askFlow",
        requestId: "interaction-local",
        status: "pending",
      });
      if (response.kind !== "askFlow" || !response.humanRequestId) {
        throw new Error("expected a mapped async ask response");
      }
      expect(waits.get(response.humanRequestId)).toMatchObject({
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
      });
      humanRequestCreatedEnvelopeSchema.parse(waits.listPendingOutbox()[0]?.envelope);
    } finally {
      db.close();
    }
  });

  it("selects the runtime identity from each workspace's Cockpit server route", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const secondRuntimeId = `rt_${"6".repeat(32)}`;
    const secondBindingId = `rtwb_${"7".repeat(32)}`;
    const secondWorkspaceId = `ws_${"8".repeat(32)}`;
    const secondServerUrl = "https://cockpit.example.test/";
    seedHumanRoute(db, {
      serverId: "rnsrv-second",
      serverUrl: secondServerUrl,
      workspaceBindingId: secondBindingId,
      workspaceId: secondWorkspaceId,
      workspacePath: "/workspace/second",
      localWorkspaceKey: "server-second",
      displayName: "Second",
      slug: "second",
    });
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const getRuntimeId = vi.fn((route: SparkDaemonHumanInteractionRoute) => {
      if (route.serverUrl === SERVER_URL) return RUNTIME_ID;
      if (route.serverUrl === secondServerUrl) return secondRuntimeId;
      return undefined;
    });
    const broker = new SparkDaemonHumanInteractionBroker({ db, waits, getRuntimeId });

    try {
      await broker.interact(askRequest("interaction-primary-server", "async"), {
        sessionId: "session-primary-server",
        invocationId: "invocation-primary-server",
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
      });
      await broker.interact(askRequest("interaction-second-server", "async"), {
        sessionId: "session-second-server",
        invocationId: "invocation-second-server",
        workspaceBindingId: secondBindingId,
        workspaceId: secondWorkspaceId,
      });

      expect(getRuntimeId).toHaveBeenNthCalledWith(1, {
        workspaceBindingId: WORKSPACE_BINDING_ID,
        workspaceId: WORKSPACE_ID,
        serverUrl: SERVER_URL,
      });
      expect(getRuntimeId).toHaveBeenNthCalledWith(2, {
        workspaceBindingId: secondBindingId,
        workspaceId: secondWorkspaceId,
        serverUrl: secondServerUrl,
      });
      expect(
        waits.listPendingOutbox().map(({ envelope }) => ({
          runtimeId: envelope.runtimeId,
          workspaceBindingId: envelope.workspaceBindingId,
          workspaceId: envelope.workspaceId,
        })),
      ).toEqual([
        {
          runtimeId: RUNTIME_ID,
          workspaceBindingId: WORKSPACE_BINDING_ID,
          workspaceId: WORKSPACE_ID,
        },
        {
          runtimeId: secondRuntimeId,
          workspaceBindingId: secondBindingId,
          workspaceId: secondWorkspaceId,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("projects toolApproval as a blocking ask and maps approve answers back", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    seedHumanRoute(db);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: primaryRuntimeId,
    });

    try {
      const pendingResponse = broker.interact(
        parseSparkInteractionRequest({
          requestId: "tool-approval-1",
          kind: "toolApproval",
          title: "Approve tool: cue_exec",
          toolName: "cue_exec",
          toolCallId: "call-1",
          reason: "Shell command requires approval",
          approveLabel: "Approve",
          rejectLabel: "Reject",
          source: "daemon",
          metadata: { source: "test" },
        }),
        {
          ...interactionContext(),
          sessionSource: "tui",
        },
      );

      await vi.waitFor(() => expect(waits.listPending()).toHaveLength(1));
      const wait = waits.listPending()[0]!;
      expect(wait).toMatchObject({
        interactionRequestId: "tool-approval-1",
        delivery: "blocking",
        kind: "ask_user",
        title: "Approve tool: cue_exec",
      });
      expect(wait.context).toMatchObject({
        interactionKind: "toolApproval",
        toolApproval: { toolName: "cue_exec", toolCallId: "call-1" },
      });

      await expect(
        broker.respond(wait, {
          status: "answered",
          answers: {
            approval: {
              values: ["approve"],
              labels: ["Approve"],
            },
          },
          responseArtifactRefs: [],
        }),
      ).resolves.toMatchObject({ outcome: "accepted", returnedToTool: true });

      await expect(pendingResponse).resolves.toMatchObject({
        kind: "toolApproval",
        requestId: "tool-approval-1",
        status: "answered",
        approved: true,
      });
    } finally {
      db.close();
    }
  });
});
