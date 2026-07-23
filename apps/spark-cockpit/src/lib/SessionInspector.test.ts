import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionInspector from "./SessionInspector.svelte";
import {
  sessionInspectorLabels as labels,
  sessionWorkbenchView,
} from "./SessionInspector.test-fixtures";
import type { SessionInspectorTab, SessionWorkbenchView } from "./session-workbench";

function renderInspector(
  view: SessionWorkbenchView,
  options: {
    instanceId?: string;
    initialTab?: SessionInspectorTab;
    statusLabel?: (status: string) => string;
  } = {},
): string {
  return render(SessionInspector, {
    props: {
      view,
      labels,
      instanceId: options.instanceId ?? "inspector-test",
      initialTab: options.initialTab,
      statusLabel: options.statusLabel,
    },
  }).body;
}

describe("SessionInspector rendered contract", () => {
  it("renders the canonical five tabs and instance-scoped summary relationships", () => {
    const body = renderInspector(
      sessionWorkbenchView({
        context: {
          sessionId: "sess-summary",
          title: "Summary",
          status: "running",
          cwd: "/workspace/spark",
          model: {
            providerName: "fixture",
            providerLabel: "Fixture",
            modelId: "model",
            modelLabel: "Model",
            displayLabel: "Fixture / Model",
          },
          createdAt: "2026-07-23T08:04:00.000Z",
          updatedAt: "2026-07-23T09:05:00.000Z",
        },
      }),
      {
        instanceId: "inspector-summary",
        statusLabel: (status) => `STATUS_${status}`,
      },
    );

    expect(body.match(/role="tab"/gu)).toHaveLength(5);
    for (const label of Object.values(labels.tabs)) expect(body).toContain(label);
    expect(body).toContain('id="inspector-summary-summary-tab"');
    expect(body).toContain('aria-controls="inspector-summary-summary-panel"');
    expect(body).toContain('id="inspector-summary-summary-panel"');
    expect(body).toContain('aria-labelledby="inspector-summary-summary-tab"');
    expect(body).toContain('aria-selected="true"');
    expect(body).toContain("SUMMARY_HEADING");
    expect(body).toContain("STATUS_running");
    expect(body).toContain("/workspace/spark");
    expect(body).toContain("Fixture / Model");
    expect(body).toContain("sess-summary");
    expect(body).toContain("2026-07-23 08:04");
    expect(body).toContain("2026-07-23 09:05");
  });

  it.each([
    ["artifacts", "NO_ARTIFACTS", "NO_ARTIFACTS_BODY"],
    ["changes", "NO_CHANGES", "NO_CHANGES_BODY"],
    ["tasks", "NO_TASKS", "NO_TASKS_BODY"],
    ["messages", "NO_MESSAGES", "NO_MESSAGES_BODY"],
  ] as const)(
    "renders the %s empty state selected by the initial tab",
    (initialTab, title, body) => {
      const html = renderInspector(sessionWorkbenchView(), {
        initialTab,
        instanceId: `inspector-${initialTab}`,
      });

      expect(html).toContain(`id="inspector-${initialTab}-${initialTab}-panel"`);
      expect(html).toContain(title);
      expect(html).toContain(body);
      expect(html).not.toContain("SUMMARY_HEADING");
    },
  );

  it("renders the latest session TODO above the selected inspector tab", () => {
    const body = renderInspector(
      sessionWorkbenchView({
        sessionTodo: {
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
        },
      }),
      {
        instanceId: "inspector-todo",
        initialTab: "tasks",
        statusLabel: (status) => `STATUS_${status}`,
      },
    );

    expect(body).toContain('aria-labelledby="inspector-todo-session-todo-heading"');
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
    const body = renderInspector(sessionWorkbenchView(), {
      instanceId: "inspector-empty",
    });

    expect(body).toContain("NO_SESSION_TODO");
    expect(body).toContain("NO_SESSION_TODO_BODY");
    expect(body).not.toContain("OPEN_SESSION_TODO");
    expect(body).not.toContain('href="#message:');
  });

  it("groups tasks by canonical project reference and renders real TODO progress", () => {
    const body = renderInspector(
      sessionWorkbenchView({
        tasks: [
          {
            id: "task-project",
            ref: "task:project",
            projectRef: "project:alpha",
            source: "session",
            title: "Project task",
            description: "Owned by a canonical project ref",
            status: "in_progress",
            owner: "session:worker",
            todoDone: 1,
            todoTotal: 2,
            todos: [
              { id: "todo-1", content: "Completed item", status: "done", notes: [] },
              { id: "todo-2", content: "Active item", status: "in_progress", notes: [] },
            ],
            runRefs: [],
            artifactRefs: [],
          },
          {
            id: "task-unassigned",
            ref: null,
            projectRef: null,
            source: "activity",
            title: "Unassigned task",
            description: null,
            status: "pending",
            owner: null,
            todoDone: 0,
            todoTotal: 0,
            todos: [],
            runRefs: [],
            artifactRefs: [],
          },
        ],
      }),
      {
        initialTab: "tasks",
        statusLabel: (status) => `STATUS_${status}`,
      },
    );

    expect(body).toContain("project:alpha");
    expect(body).toContain("Project task");
    expect(body).toContain("session:worker");
    expect(body).toContain("Completed item");
    expect(body).toContain("Active item");
    expect(body).toContain('max="2"');
    expect(body).toContain('value="1"');
    expect(body).toContain("1/2");
    expect(body).toContain("UNASSIGNED_PROJECT");
    expect(body).toContain("Unassigned task");
  });

  it("keeps product artifacts, canonical changes, and internal evidence on separate surfaces", () => {
    const view = sessionWorkbenchView({
      artifacts: [
        {
          id: "artifact-pr",
          ref: "artifact:pr",
          source: "session",
          title: "Pull request",
          kind: "pr",
          format: "markdown",
          status: "ready",
          producer: "session:worker",
          createdAt: null,
          updatedAt: null,
          preview: "PR preview",
          canonicalChange: false,
        },
      ],
      changes: [
        {
          id: "artifact-diff",
          ref: "artifact:diff",
          source: "session",
          title: "Working tree",
          kind: "change",
          format: "diff",
          status: null,
          producer: "session:worker",
          createdAt: null,
          updatedAt: null,
          preview: "+behavioral assertion",
          canonicalChange: true,
        },
      ],
      evidence: [
        {
          id: "evidence-internal",
          ref: "evidence:internal",
          source: "session",
          title: "INTERNAL_EVIDENCE",
          kind: "log",
          format: "text",
          status: null,
          producer: "session:worker",
          createdAt: null,
          updatedAt: null,
          preview: "must remain internal",
          canonicalChange: false,
        },
      ],
    });

    const artifacts = renderInspector(view, { initialTab: "artifacts" });
    expect(artifacts).toContain("Pull request");
    expect(artifacts).toContain("artifact:pr");
    expect(artifacts).toContain("PR preview");
    expect(artifacts).not.toContain("Working tree");
    expect(artifacts).not.toContain("INTERNAL_EVIDENCE");

    const changes = renderInspector(view, { initialTab: "changes" });
    expect(changes).toContain("Working tree");
    expect(changes).toContain("artifact:diff");
    expect(changes).toContain("+behavioral assertion");
    expect(changes).not.toContain("Pull request");
    expect(changes).not.toContain("INTERNAL_EVIDENCE");
  });

  it("renders channel delivery separately from message read state and counts unread messages", () => {
    const body = renderInspector(
      sessionWorkbenchView({
        messages: [
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
        ],
      }),
      {
        instanceId: "inspector-mail",
        initialTab: "messages",
      },
    );

    expect(body).toContain("Research result");
    expect(body).toContain("NOTIFICATION");
    expect(body).toContain("FROM");
    expect(body).toContain("sess-worker");
    expect(body).toContain("DELIVERY_UNCERTAIN");
    expect(body).toContain("UNREAD");
    expect(body).toContain("message-delivery-status uncertain");
    expect(body).toContain("message-read-status unread");
    expect(body).toContain('aria-label="1 UNREAD"');
  });
});
