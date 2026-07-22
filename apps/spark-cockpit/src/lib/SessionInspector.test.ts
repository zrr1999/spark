import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionInspector from "./SessionInspector.svelte";
import type {
  SessionInspectorLabels,
  SessionWorkbenchSessionTodo,
  SessionWorkbenchView,
} from "./session-workbench";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionInspector.svelte");
const workspacePath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionsWorkspace.svelte");
const artifactDetailPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(workbench)/[workspaceId]/artifacts/[artifactId]/+page.svelte",
);

const labels: SessionInspectorLabels = {
  ariaLabel: "SESSION_INSPECTOR",
  tabs: {
    summary: "SUMMARY_TAB",
    artifacts: "ARTIFACTS_TAB",
    changes: "CHANGES_TAB",
    tasks: "TASKS_TAB",
    messages: "MESSAGES_TAB",
  },
  summaryHeading: "SUMMARY_HEADING",
  artifactsHeading: "ARTIFACTS_HEADING",
  tasksHeading: "TASKS_HEADING",
  changesHeading: "CHANGES_HEADING",
  messagesHeading: "MESSAGES_HEADING",
  noTasksTitle: "NO_TASKS",
  noTasksBody: "NO_TASKS_BODY",
  noArtifactsTitle: "NO_ARTIFACTS",
  noArtifactsBody: "NO_ARTIFACTS_BODY",
  noChangesTitle: "NO_CHANGES",
  noChangesBody: "NO_CHANGES_BODY",
  noMessagesTitle: "NO_MESSAGES",
  noMessagesBody: "NO_MESSAGES_BODY",
  noSessionTodoTitle: "NO_SESSION_TODO",
  noSessionTodoBody: "NO_SESSION_TODO_BODY",
  noActiveSessionTodo: "NO_ACTIVE_SESSION_TODO",
  unassignedProject: "UNASSIGNED_PROJECT",
  progress: "PROGRESS",
  todoList: "SESSION_TODO_LIST",
  sessionTodoHeading: "SESSION_TODO_HEADING",
  openSessionTodo: "OPEN_SESSION_TODO",
  sessionTodoPending: "TODO_WAITING",
  sessionTodoInProgress: "TODO_IN_PROGRESS",
  messageFrom: "FROM",
  messageRequest: "REQUEST",
  messageQuestion: "QUESTION",
  messageNotification: "NOTIFICATION",
  messageUnread: "UNREAD",
  messageRead: "READ",
  messageAcknowledged: "ACKNOWLEDGED",
  messageDeliveryPending: "DELIVERY_PENDING",
  messageDeliveryDelivered: "DELIVERY_DELIVERED",
  messageDeliveryFailed: "DELIVERY_FAILED",
  messageDeliveryUncertain: "DELIVERY_UNCERTAIN",
  sessionId: "SESSION_ID",
  sessionStatus: "SESSION_STATUS",
  workingDirectory: "WORKING_DIRECTORY",
  model: "MODEL",
  createdAt: "CREATED_AT",
  updatedAt: "UPDATED_AT",
  unavailable: "UNAVAILABLE",
};

function workbenchView(sessionTodo: SessionWorkbenchSessionTodo | null): SessionWorkbenchView {
  return {
    runs: [],
    tasks: [],
    artifacts: [],
    changes: [],
    evidence: [],
    messages: [],
    sessionTodo,
    context: {
      sessionId: "sess-inspector",
      title: "Inspector test",
      status: "idle",
      cwd: "/workspace/spark",
      model: null,
      createdAt: null,
      updatedAt: null,
    },
  };
}

describe("SessionInspector component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders the focused coding-session tabs with TODO pinned above", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('id: "summary"');
    expect(source).toContain('id: "changes"');
    expect(source).not.toContain('id: "todos"');
    expect(source).toContain('id: "tasks"');
    expect(source).toContain('id: "artifacts"');
    expect(source).toContain('id: "messages"');
    expect(source).toContain('class="session-todo-rail"');
    expect(source).not.toContain('id: "mailbox"');
    expect(source).not.toContain('id: "evidence"');
    expect(source).not.toContain('id: "context"');
    expect(source).not.toContain("view.runs");
    expect(source).not.toContain("labels.noRunsTitle");
    expect(source).not.toContain("labels.noRunsBody");
    expect(source).not.toContain("labels.runsHeading");
    expect(source).toContain("view.tasks");
    expect(source).toContain("view.changes");
    expect(source).toContain("view.sessionTodo");
    expect(source).toContain("view.artifacts");
    expect(source).toContain("view.messages");
    expect(source).toContain("view.context");
    expect(source).toContain("labels.noTasksTitle");
    expect(source).toContain("labels.noTasksBody");
    expect(source).toContain("labels.noArtifactsTitle");
    expect(source).toContain("labels.noArtifactsBody");
    expect(source).toContain("labels.noChangesTitle");
    expect(source).toContain("labels.noChangesBody");
    expect(source).toContain("labels.noMessagesTitle");
    expect(source).toContain("labels.noMessagesBody");
    expect(source).toContain("justify-content: center");
  });

  it("does not expose invented Git or terminal controls", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain("git status");
    expect(source).not.toContain("terminal.write");
    expect(source).not.toContain("<form");
  });

  it("renders product Markdown previews safely in artifact detail", () => {
    const inspectorSource = readFileSync(componentPath, "utf8");
    const detailSource = readFileSync(artifactDetailPath, "utf8");

    expect(inspectorSource).toContain('<pre class="artifact-preview">{artifact.preview}</pre>');
    expect(detailSource).toContain('import SafeMarkdown from "$lib/SafeMarkdown.svelte"');
    expect(detailSource).toContain('data.artifact.kind === "preview"');
    expect(detailSource).toContain("<SafeMarkdown source={preview.body.text} />");
  });

  it("groups only canonical task project references without inventing project metadata", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("groupTasksByProject(view.tasks)");
    expect(source).toContain("task.projectRef ??");
    expect(source).toContain("labels.unassignedProject");
    expect(source).toContain("task.todos as todo");
    expect(source).toContain("todo.content");
    expect(source).toContain("statusLabel(todo.status)");
    expect(source).not.toContain("project.title");
    expect(source).not.toContain("project.status");
  });

  it("renders the latest session TODO snapshot above the inspector tabs", () => {
    const body = render(SessionInspector, {
      props: {
        view: workbenchView({
          anchor: "message:todo-message",
          summary: "Session TODOs: 2 active.",
          items: [
            { id: "todo-a", content: "Inspect projection", status: "done", notes: [] },
            {
              id: "todo-b",
              content: "Render session TODO",
              status: "in_progress",
              notes: [],
            },
            { id: "todo-c", content: "Verify waiting copy", status: "pending", notes: [] },
          ],
          updatedAt: "2026-07-13T08:04:00.000Z",
        }),
        labels,
        instanceId: "inspector-test",
        statusLabel: (status: string) => `STATUS_${status}`,
      },
    }).body;

    expect(body).toContain('class="session-todo-rail');
    expect(body).not.toContain('id="inspector-test-todos-tab"');
    expect(body).toContain('aria-labelledby="inspector-test-session-todo-heading"');
    expect(body).toContain("SESSION_TODO_HEADING");
    expect(body).toContain("Session TODOs: 2 active.");
    expect(body).toContain("Inspect projection");
    expect(body).toContain("Render session TODO");
    expect(body).toContain("TODO_IN_PROGRESS");
    expect(body).toContain("TODO_WAITING");
    expect(body).toContain('href="#message:todo-message"');
    expect(body).not.toContain("NO_SESSION_TODO");
  });

  it("renders a restrained TODO empty state without an invented execution link", () => {
    const body = render(SessionInspector, {
      props: {
        view: workbenchView(null),
        labels,
        instanceId: "inspector-empty",
      },
    }).body;

    expect(body).toContain("NO_SESSION_TODO");
    expect(body).toContain("NO_SESSION_TODO_BODY");
    expect(body).not.toContain("OPEN_SESSION_TODO");
    expect(body).not.toContain('href="#message:');
  });

  it("renders channel delivery separately from message read state", () => {
    const view = workbenchView(null);
    view.messages = [
      {
        id: "mail:uncertain",
        fromSessionId: "sess-worker",
        kind: "notification",
        intent: "research.complete",
        subject: "Research result",
        body: "The provider did not confirm delivery.",
        createdAt: "2026-07-20T03:00:00.000Z",
        status: "unread",
        channelDelivery: {
          status: "uncertain",
          total: 1,
          pending: 0,
          delivered: 0,
          failed: 0,
          uncertain: 1,
        },
      },
    ];

    const body = render(SessionInspector, {
      props: {
        view,
        labels,
        instanceId: "inspector-mail-delivery",
        initialTab: "messages",
      },
    }).body;

    expect(body).toContain("DELIVERY_UNCERTAIN");
    expect(body).toContain("UNREAD");
    expect(body).toContain("message-delivery-status uncertain");
    expect(body).toContain("message-read-status unread");
  });

  it("names tabs, panels, and headings from the inspector instance", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("instanceId: string");
    expect(source).toContain("`${instanceId}-${tab}-tab`");
    expect(source).toContain("`${instanceId}-${tab}-panel`");
    expect(source).toContain("`${instanceId}-${section}-heading`");
    expect(source).toContain("`${instanceId}-session-todo-heading`");
    expect(source).not.toContain('id="session-inspector-runs-heading"');

    const workspace = readFileSync(workspacePath, "utf8");
    expect(workspace).toContain(
      'compact ? "session-inspector-mobile" : "session-inspector-desktop"',
    );
  });

  it("derives busy presentation from an active invocation instead of stale session flags", () => {
    const workspace = readFileSync(workspacePath, "utf8");

    expect(workspace).toContain(
      'let conversationBusy = $derived(sessionActivityState.phase === "running")',
    );
    expect(workspace).not.toContain('selected?.status === "running" ||');
    expect(workspace).toContain(
      'const effectiveStatus: "running" | "idle" = conversationBusy ? "running" : "idle"',
    );
  });
});
