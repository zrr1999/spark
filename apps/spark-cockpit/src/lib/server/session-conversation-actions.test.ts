import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveManagedSessionForCockpit: vi.fn(),
  createManagedSessionForCockpit: vi.fn(),
  getManagedSessionForCockpit: vi.fn(),
  listManagedSessionsForCockpit: vi.fn(),
  loadModelControlForCockpit: vi.fn(),
  setSessionModelForCockpit: vi.fn(),
  submitConversationTurnForCockpit: vi.fn(),
}));

vi.mock("$lib/server/managed-sessions", () => ({
  archiveManagedSessionForCockpit: mocks.archiveManagedSessionForCockpit,
  createManagedSessionForCockpit: mocks.createManagedSessionForCockpit,
  getManagedSessionForCockpit: mocks.getManagedSessionForCockpit,
  listManagedSessionsForCockpit: mocks.listManagedSessionsForCockpit,
}));

vi.mock("$lib/i18n", () => ({
  localeCookieName: "spark_cockpit_locale",
  resolveRequestLocale: () => "en",
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

vi.mock("$lib/server/model-control", () => ({
  loadModelControlForCockpit: mocks.loadModelControlForCockpit,
  modelValue: (model: { providerName: string; modelId: string }) =>
    `${model.providerName}/${model.modelId}`,
  parseModelValue: (value: string) => {
    const [providerName, modelId] = value.split("/", 2);
    if (!providerName || !modelId) throw new Error("invalid model");
    return { providerName, modelId };
  },
  setSessionModelForCockpit: mocks.setSessionModelForCockpit,
}));

vi.mock("$lib/server/agents-product", () => ({
  titleFromPrompt: (prompt: string) => {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
  },
}));

vi.mock("$lib/server/conversation-control", () => ({
  submitConversationTurnForCockpit: mocks.submitConversationTurnForCockpit,
}));

vi.mock("$lib/server/form-data", () => ({
  formText: (formData: FormData, key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  },
}));

import { actions } from "../../routes/(workbench)/sessions/+page.server";

const session = {
  sessionId: "sess_conversation",
  scope: { kind: "workspace" as const, workspaceId: "ws_demo" },
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
  mocks.loadModelControlForCockpit.mockResolvedValue({
    available: true,
    snapshot: { providers: [], diagnostics: [] },
  });
  mocks.setSessionModelForCockpit.mockResolvedValue(session);
  mocks.submitConversationTurnForCockpit.mockResolvedValue({ turnId: "turn_conversation" });
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
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      workspaceId: "ws_demo",
      title: "Inspect the daemon path.",
    });
    expect(mocks.submitConversationTurnForCockpit).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "Inspect the daemon path.",
      title: "Inspect the daemon path.",
    });
    expect(mocks.archiveManagedSessionForCockpit).not.toHaveBeenCalled();
  });

  it("creates and submits a daemon-global conversation without a workspace target", async () => {
    mocks.createManagedSessionForCockpit.mockResolvedValueOnce({
      ...session,
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "daemon-local" },
      workspaceId: undefined,
    });

    await expect(
      requireAction("startConversation")(
        actionEvent({ scopeKind: "daemon", message: "Inspect daemon health." }),
      ),
    ).rejects.toMatchObject({
      status: 303,
      location: "/sessions/sess_global",
    });

    expect(mocks.createManagedSessionForCockpit).toHaveBeenCalledWith({
      scope: { kind: "daemon" },
      title: "Inspect daemon health.",
    });
    expect(mocks.submitConversationTurnForCockpit).toHaveBeenCalledWith({
      sessionId: "sess_global",
      prompt: "Inspect daemon health.",
      title: "Inspect daemon health.",
    });
  });

  it("preserves the first message and archives the new session when queueing fails", async () => {
    mocks.submitConversationTurnForCockpit.mockRejectedValue(
      new Error("workspace owner is offline"),
    );

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
    expect(mocks.submitConversationTurnForCockpit).not.toHaveBeenCalled();
  });

  it("queues each later message against the existing session", async () => {
    const result = await requireAction("sendMessage")(
      actionEvent({ sessionId: "sess_conversation", message: "Now run the focused tests." }),
    );

    expect(result).toEqual({
      intent: "sendMessage",
      success: true,
      message: "Assignment queued for the owning Spark daemon.",
      queuedTurnId: "turn_conversation",
      values: { sessionId: "sess_conversation", message: "" },
    });
    expect(mocks.submitConversationTurnForCockpit).toHaveBeenCalledWith({
      workspaceId: "ws_demo",
      sessionId: "sess_conversation",
      prompt: "Now run the focused tests.",
      title: "Now run the focused tests.",
    });
  });

  it("continues a daemon-global conversation without fabricating workspace ownership", async () => {
    mocks.getManagedSessionForCockpit.mockResolvedValueOnce({
      ...session,
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "daemon-local" },
      workspaceId: undefined,
    });

    await expect(
      requireAction("sendMessage")(
        actionEvent({ sessionId: "sess_global", message: "Continue globally." }),
      ),
    ).resolves.toMatchObject({ success: true, queuedTurnId: "turn_conversation" });

    expect(mocks.submitConversationTurnForCockpit).toHaveBeenCalledWith({
      sessionId: "sess_global",
      prompt: "Continue globally.",
      title: "Continue globally.",
    });
  });

  it("persists a conversation model through the daemon control plane", async () => {
    mocks.setSessionModelForCockpit.mockResolvedValue({
      ...session,
      model: {
        providerName: "baidu-oneapi",
        modelId: "gpt-5.6-sol",
        providerLabel: "Baidu OneAPI",
        modelLabel: "GPT-5.6 Sol",
      },
    });

    const result = await requireAction("selectModel")(
      actionEvent({ sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" }),
    );

    expect(result).toEqual({
      intent: "selectModel",
      success: true,
      message:
        "Switched to baidu-oneapi/gpt-5.6-sol. This applies starting with the next message that has not yet been queued.",
      model: "baidu-oneapi/gpt-5.6-sol",
      values: { sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" },
    });
    expect(mocks.setSessionModelForCockpit).toHaveBeenCalledWith("sess_conversation", {
      providerName: "baidu-oneapi",
      modelId: "gpt-5.6-sol",
    });
  });

  it("does not report a model switch before the daemon confirms the effective model", async () => {
    const result = await requireAction("selectModel")(
      actionEvent({ sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" }),
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        intent: "selectModel",
        success: false,
        message: "The Spark daemon did not return an effective conversation model.",
        values: { sessionId: "sess_conversation", model: "baidu-oneapi/gpt-5.6-sol" },
      },
    });
  });

  it("preserves a later message when submission fails", async () => {
    mocks.submitConversationTurnForCockpit.mockRejectedValue(new Error("queue unavailable"));

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
