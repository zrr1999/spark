import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveManagedSessionForCockpit: vi.fn(),
  createManagedSessionForCockpit: vi.fn(),
  getCurrentUserIdBySessionToken: vi.fn(),
  getManagedSessionForCockpit: vi.fn(),
  getDatabase: vi.fn(),
  listManagedSessionsForCockpit: vi.fn(),
  submitServerCommand: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  archiveManagedSessionForCockpit: mocks.archiveManagedSessionForCockpit,
  createManagedSessionForCockpit: mocks.createManagedSessionForCockpit,
  getManagedSessionForCockpit: mocks.getManagedSessionForCockpit,
  listManagedSessionsForCockpit: mocks.listManagedSessionsForCockpit,
}));

vi.mock("$lib/i18n", () => ({
  localeCookieName: "spark_cockpit_locale",
  getRequestDictionary: () => ({
    sessions: {
      archiveFailed: "Could not archive the session.",
      archiveSessionRequired: "Select a session to archive.",
      assignArchived: "This session is archived and cannot accept more work.",
      assignFailed: "Could not queue the assignment.",
      assignGoalRequired: "Enter a goal for the assignment.",
      assignQueued: "Assignment queued for the owning Spark daemon.",
      assignSessionRequired: "Select a session before assigning.",
      createFailed: "Could not create the session.",
      createWorkspaceRequired: "Choose a workspace.",
    },
  }),
}));

vi.mock("$lib/server/agents-product", () => ({
  titleFromPrompt: (prompt: string) => {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
  },
}));

vi.mock("$lib/server/command-submission", () => ({
  submitServerCommand: mocks.submitServerCommand,
}));

vi.mock("$lib/server/db", () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock("$lib/server/form-data", () => ({
  formText: (formData: FormData, key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  },
}));

vi.mock("@zendev-lab/spark-server/cockpit-queries", () => ({
  getCurrentUserIdBySessionToken: mocks.getCurrentUserIdBySessionToken,
}));

import { actions } from "../../routes/(workbench)/sessions/+page.server";

const database = { kind: "test-database" };
const session = {
  sessionId: "sess_conversation",
  workspaceId: "ws_demo",
  title: "Initial message",
  status: "ready",
  bindings: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createManagedSessionForCockpit.mockResolvedValue(session);
  mocks.getManagedSessionForCockpit.mockResolvedValue(session);
  mocks.archiveManagedSessionForCockpit.mockResolvedValue({
    ...session,
    status: "archived",
  });
  mocks.getDatabase.mockReturnValue(database);
  mocks.getCurrentUserIdBySessionToken.mockReturnValue("usr_demo");
  mocks.submitServerCommand.mockReturnValue({ id: "cmd_conversation" });
});

describe("session conversation actions", () => {
  it("creates a titled session from the first message, queues it, and redirects", async () => {
    const action = requireAction("startConversation");

    await expect(
      action(actionEvent({ workspaceId: "ws_demo", message: "  Inspect the daemon path.  " })),
    ).rejects.toMatchObject({
      status: 303,
      location: "/sessions/sess_conversation",
    });

    expect(mocks.createManagedSessionForCockpit).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      title: "Inspect the daemon path.",
    });
    expect(mocks.submitServerCommand).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        workspaceId: "ws_demo",
        requestedByUserId: "usr_demo",
        idempotencyKey: expect.stringMatching(/^idem_/),
        payload: {
          kind: "assignment.create.request",
          title: "Inspect the daemon path.",
          payload: {
            goal: "Inspect the daemon path.",
            title: "Inspect the daemon path.",
            target: {
              sessionId: "sess_conversation",
              workspaceId: "ws_demo",
            },
            constraints: [],
            evidence: [],
            source: { kind: "cockpit" },
          },
        },
      }),
    );
    expect(mocks.archiveManagedSessionForCockpit).not.toHaveBeenCalled();
  });

  it("preserves the first message and archives the new session when queueing fails", async () => {
    mocks.submitServerCommand.mockImplementation(() => {
      throw new Error("workspace owner is offline");
    });

    const result = await requireAction("startConversation")(
      actionEvent({ workspaceId: "ws_demo", message: "Keep this text" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        success: false,
        error: "workspace owner is offline",
        values: { workspaceId: "ws_demo", message: "Keep this text" },
      },
    });
    expect(mocks.archiveManagedSessionForCockpit).toHaveBeenCalledWith("sess_conversation");
  });

  it("does not create a session before both workspace and first message are present", async () => {
    const result = await requireAction("startConversation")(
      actionEvent({ workspaceId: "ws_demo", message: "   " }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "startConversation",
        success: false,
        values: { workspaceId: "ws_demo", message: "" },
      },
    });
    expect(mocks.createManagedSessionForCockpit).not.toHaveBeenCalled();
    expect(mocks.submitServerCommand).not.toHaveBeenCalled();
  });

  it("queues each later message against the existing session", async () => {
    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "Now run the focused tests." }),
    );

    expect(result).toEqual({
      intent: "sendMessage",
      success: true,
      message: "Assignment queued for the owning Spark daemon.",
      queuedCommandId: "cmd_conversation",
      values: { sessionId: "sess_conversation", message: "" },
    });
    expect(mocks.submitServerCommand).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        workspaceId: "ws_demo",
        payload: expect.objectContaining({
          kind: "assignment.create.request",
          payload: expect.objectContaining({
            goal: "Now run the focused tests.",
            target: {
              sessionId: "sess_conversation",
              workspaceId: "ws_demo",
            },
          }),
        }),
      }),
    );
  });

  it("preserves a later message when submission fails", async () => {
    mocks.submitServerCommand.mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "Please retry this" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "sendMessage",
        success: false,
        error: "queue unavailable",
        values: { sessionId: "sess_conversation", message: "Please retry this" },
      },
    });
  });
});

function requireAction(name: keyof typeof actions) {
  const action = actions[name];
  if (!action) throw new Error(`Missing action: ${name}`);
  return action;
}

function actionEvent(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return {
    cookies: { get: () => undefined },
    locals: { sessionToken: "session-token" },
    request: new Request("http://localhost/sessions", {
      method: "POST",
      body: formData,
    }),
  } as never;
}
