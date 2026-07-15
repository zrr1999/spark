import { DatabaseSync } from "node:sqlite";
import {
  humanRequestCreatedEnvelopeSchema,
  parseSparkInteractionRequest,
  type SparkInteractionRequest,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  SparkDaemonHumanInteractionBroker,
  type SparkDaemonHumanInteractionOpened,
} from "./human-interactions.ts";
import { SparkDaemonHumanWaitRegistry } from "./human-waits.ts";

const RUNTIME_ID = `rt_${"1".repeat(32)}`;
const WORKSPACE_BINDING_ID = `rtwb_${"2".repeat(32)}`;
const LOCAL_WORKSPACE_BINDING_ID = `rtwb_${"3".repeat(32)}`;
const WORKSPACE_ID = `ws_${"4".repeat(32)}`;
const PROJECT_ID = `proj_${"5".repeat(32)}`;
const WORKSPACE_PATH = "/workspace/spark";
const NOW = "2026-07-14T00:00:00.000Z";

function seedHumanRoute(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO daemon_servers (id, server_url, first_registered_at)
     VALUES (?, ?, ?)`,
  ).run("rnsrv-test", "http://127.0.0.1:5173/", NOW);
  db.prepare(
    `INSERT INTO workspaces
      (id, server_url, local_workspace_key, display_name, local_path, status,
       capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'available', '{}', '{}', ?, ?)`,
  ).run(
    WORKSPACE_BINDING_ID,
    "http://127.0.0.1:5173/",
    "server-spark",
    "Spark",
    WORKSPACE_PATH,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO daemon_workspaces
      (id, server_id, server_workspace_id, name, slug, local_path, registered_at,
       last_known_status, last_status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
  ).run(
    WORKSPACE_BINDING_ID,
    "rnsrv-test",
    WORKSPACE_ID,
    "Spark",
    "spark",
    WORKSPACE_PATH,
    NOW,
    NOW,
  );
}

function askRequest(requestId: string, delivery: "blocking" | "async"): SparkInteractionRequest {
  return parseSparkInteractionRequest({
    requestId,
    kind: "askFlow",
    title: "Choose a direction",
    prompt: "How should Spark continue?",
    delivery,
    mode: "decision",
    source: "daemon",
    questions: [
      {
        id: "decision",
        prompt: "Continue?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Continue", description: "Resume execution" },
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
      getRuntimeId: () => RUNTIME_ID,
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
      getRuntimeId: () => RUNTIME_ID,
    });

    try {
      let settled = false;
      const pendingResponse = broker.interact(
        askRequest("interaction-blocking", "blocking"),
        interactionContext(),
      );
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

      expect(
        waits.deliver({
          humanRequestId: wait!.humanRequestId,
          humanResponseId: "response-blocking",
          status: "answered",
          answers: {
            decision: {
              values: ["yes"],
              labels: ["Continue"],
            },
          },
        }),
      ).toMatchObject({
        outcome: "accepted",
        returnedToTool: true,
        winnerResponseId: "response-blocking",
      });

      await expect(pendingResponse).resolves.toMatchObject({
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
          humanResponseId: "response-blocking",
        },
      });
      expect(waits.hasActive(wait!.humanRequestId)).toBe(false);
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
      getRuntimeId: () => RUNTIME_ID,
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
      getRuntimeId: () => RUNTIME_ID,
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
});
