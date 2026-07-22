import { describe, expect, it } from "vitest";
import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { buildSessionWorkbenchView } from "./session-workbench";

function session(overrides: Record<string, unknown> = {}) {
  return parseSparkSessionView({
    sessionId: "sess-workbench",
    title: "Implement inspector",
    status: "running",
    cwd: "/workspace/spark",
    model: {
      providerName: "openai-codex",
      providerLabel: "OpenAI Codex",
      modelId: "gpt-5.5-codex",
      modelLabel: "GPT-5.5 Codex",
    },
    messages: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    ...overrides,
  });
}

describe("session workbench projection", () => {
  it("maps daemon-owned runs, internal tasks, evidence, and context", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        runs: [
          {
            id: "inv-1",
            kind: "session",
            title: "Implement inspector",
            status: "running",
            progress: 0.5,
            artifactRefs: [],
            evidenceRefs: ["evidence:report-1"],
            startedAt: "2026-07-13T08:00:00.000Z",
          },
        ],
        tasks: [
          {
            ref: "task:build",
            projectRef: "project:cockpit",
            title: "Build the inspector",
            status: "running",
            owner: "worker",
            todos: [
              { id: "todo-1", content: "Project state", status: "done", notes: [] },
              { id: "todo-2", content: "Render tabs", status: "in_progress", notes: [] },
            ],
            runRefs: ["run:inv-1"],
            artifactRefs: [],
            evidenceRefs: ["evidence:report-1"],
          },
        ],
        evidence: [
          {
            ref: "evidence:report-1",
            title: "Inspector report",
            kind: "document",
            format: "markdown",
            preview: "Verified output",
          },
        ],
      }),
      activity: {
        commands: [
          {
            id: "cmd-1",
            title: "Implement inspector",
            goal: "Implement inspector",
            status: "acked",
            deliveryStatus: "acked",
            runtimeName: "spark-daemon",
            runtimeStatus: "online",
            invocationId: "inv-1",
            invocationStatus: "running",
            latestLog: "Running focused tests",
            latestLogAt: "2026-07-13T08:01:00.000Z",
            createdAt: "2026-07-13T08:00:00.000Z",
            updatedAt: "2026-07-13T08:01:00.000Z",
          },
        ],
        reports: [
          {
            id: "task-event-1",
            kind: "daemon.task.lifecycle",
            title: "session.run",
            text: "Task is running.",
            role: null,
            status: "running",
            createdAt: "2026-07-13T08:00:30.000Z",
          },
        ],
      },
    });

    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({
      id: "run:inv-1",
      commandId: "cmd-1",
      latestOutput: "Running focused tests",
      runtimeName: "spark-daemon",
    });
    expect(view.tasks).toMatchObject([
      {
        id: "task:build",
        projectRef: "project:cockpit",
        source: "session",
        todoDone: 1,
        todoTotal: 2,
        todos: [
          { id: "todo-1", content: "Project state", status: "done", notes: [] },
          { id: "todo-2", content: "Render tabs", status: "in_progress", notes: [] },
        ],
      },
    ]);
    expect(view.evidence).toMatchObject([
      { id: "report-1", title: "Inspector report", canonicalChange: false },
    ]);
    expect(view.context).toMatchObject({
      sessionId: "sess-workbench",
      cwd: "/workspace/spark",
      model: { displayLabel: "GPT-5.5 Codex · OpenAI Codex" },
    });
  });

  it("projects the latest successful session TODO snapshot and its conversation anchor", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        messages: [
          {
            id: "todo-message",
            role: "tool",
            text: "Session TODOs: 3 active.",
            status: "done",
            createdAt: "2026-07-13T08:04:00.000Z",
            parts: [
              {
                id: "part:todo",
                type: "tool-result",
                toolCallId: "call:todo",
                toolName: "todo",
                status: "complete",
                summary:
                  "Session TODOs: 3 active.\n- [done] todo-alpha Inspect projection\n- [in_progress] todo-beta Render session TODO\n- [blocked] Imported item",
                metadata: {},
              },
            ],
            metadata: {},
          },
        ],
      }),
    });

    expect(view.sessionTodo).toEqual({
      anchor: "message:todo-message",
      summary: "Session TODOs: 3 active.",
      updatedAt: "2026-07-13T08:04:00.000Z",
      items: [
        {
          id: "todo-alpha",
          content: "Inspect projection",
          status: "done",
          notes: [],
        },
        {
          id: "todo-beta",
          content: "Render session TODO",
          status: "in_progress",
          notes: [],
        },
        {
          id: "session-todo-4",
          content: "Imported item",
          status: "blocked",
          notes: [],
        },
      ],
    });
  });

  it("does not fabricate session TODO state from calls or failed results", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        messages: [
          {
            id: "todo-call",
            role: "tool",
            text: "action=list",
            status: "done",
            parts: [
              {
                id: "part:call",
                type: "tool-call",
                toolCallId: "call:todo",
                toolName: "todo",
                status: "complete",
                metadata: {},
              },
            ],
            metadata: {},
          },
          {
            id: "todo-failure",
            role: "tool",
            text: "TODO store unavailable",
            status: "done",
            parts: [
              {
                id: "part:failure",
                type: "tool-result",
                toolCallId: "call:todo",
                toolName: "todo",
                status: "failed",
                summary: "TODO store unavailable",
                metadata: {},
              },
            ],
            metadata: {},
          },
        ],
      }),
    });

    expect(view.sessionTodo).toBeNull();
  });

  it("projects session messages newest-first with durable read state", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        mailbox: [
          {
            id: "mail:older",
            fromSessionId: "sess_worker",
            kind: "request",
            intent: "review.request",
            subject: "Review the patch",
            body: "Please review the current diff.",
            createdAt: "2026-07-13T08:01:00.000Z",
            readAt: "2026-07-13T08:02:00.000Z",
            ackedAt: null,
          },
          {
            id: "mail:newer",
            fromSessionId: "sess_scout",
            kind: "notification",
            intent: "research.complete",
            subject: null,
            body: "Research is complete.",
            createdAt: "2026-07-13T08:03:00.000Z",
            readAt: null,
            ackedAt: null,
            channelDelivery: {
              status: "uncertain",
              total: 2,
              pending: 0,
              delivered: 1,
              failed: 0,
              uncertain: 1,
            },
          },
        ],
      }),
    });

    expect(view.messages).toMatchObject([
      {
        id: "mail:newer",
        status: "unread",
        channelDelivery: { status: "uncertain", total: 2, delivered: 1, uncertain: 1 },
      },
      { id: "mail:older", status: "read", channelDelivery: null },
    ]);
  });

  it("shows changes only for explicit canonical diff markers", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        evidence: [
          {
            ref: "evidence:looks-like-diff",
            title: "Changes.diff",
            kind: "document",
            format: "text",
            preview: "diff --git a/a.ts b/a.ts",
          },
          {
            ref: "evidence:canonical-diff",
            title: "Working tree patch",
            kind: "trace",
            format: "text",
            preview: "diff --git a/a.ts b/a.ts",
            metadata: { presentation: "diff" },
          },
        ],
      }),
    });

    expect(view.changes.map((artifact) => artifact.id)).toEqual(["canonical-diff"]);
    expect(view.evidence.map((artifact) => artifact.id)).toEqual(["looks-like-diff"]);
  });

  it("puts issue/pr/preview into session artifacts, not evidence", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        artifacts: [
          {
            ref: "artifact:pr-1",
            title: "Open PR",
            kind: "pr",
            format: "json",
            preview: '{"number":1}',
          },
        ],
        evidence: [
          {
            ref: "evidence:note-1",
            title: "Internal note",
            kind: "record",
            format: "json",
            preview: '{"summary":"hidden"}',
          },
        ],
      }),
    });

    expect(view.artifacts.map((artifact) => artifact.id)).toEqual(["pr-1"]);
    expect(view.evidence.map((artifact) => artifact.id)).toEqual(["note-1"]);
  });

  it("maps canonical activity artifact kinds without inferring Git state from prose", () => {
    const view = buildSessionWorkbenchView({
      session: session(),
      activity: {
        reports: [
          {
            id: "patch-1",
            kind: "artifact.patch",
            title: "Patch",
            text: "+const ready = true;",
            role: "assistant",
            status: "succeeded",
            createdAt: "2026-07-13T08:02:00.000Z",
          },
          {
            id: "report-2",
            kind: "evidence.document",
            title: "Report mentioning diff",
            text: "A diff was produced.",
            role: "assistant",
            status: "succeeded",
            createdAt: "2026-07-13T08:01:00.000Z",
          },
        ],
      },
    });

    expect(view.changes).toMatchObject([{ id: "patch-1", format: "diff" }]);
    expect(view.evidence).toMatchObject([{ id: "report-2", kind: "document" }]);
  });

  it("uses task and artifact updates as reload-safe fallbacks without lifecycle ghosts", () => {
    const view = buildSessionWorkbenchView({
      session: session(),
      activity: {
        reports: [
          {
            id: "task:reload-safe",
            kind: "task.update",
            title: "Reload-safe task",
            text: "Projected from the daemon view event.",
            role: null,
            status: "claimed",
            createdAt: "2026-07-13T08:02:00.000Z",
          },
          {
            id: "task:reload-safe",
            kind: "task.update",
            title: "Older reload-safe task",
            text: "An older duplicate projection.",
            role: null,
            status: "queued",
            createdAt: "2026-07-13T08:01:30.000Z",
          },
          {
            id: "stale-lifecycle-event",
            kind: "daemon.task.lifecycle",
            title: "session.run",
            text: "Task is running.",
            role: null,
            status: "running",
            createdAt: "2026-07-13T08:01:00.000Z",
          },
          {
            id: "artifact:reload-safe",
            kind: "evidence.update",
            title: "Reload-safe artifact",
            text: "Projected evidence.",
            role: "assistant",
            status: "completed",
            createdAt: "2026-07-13T08:03:00.000Z",
          },
        ],
      },
    });

    expect(view.tasks).toMatchObject([
      {
        id: "task:reload-safe",
        projectRef: null,
        source: "activity",
        title: "Reload-safe task",
        status: "claimed",
      },
    ]);
    expect(view.evidence).toMatchObject([
      {
        id: "reload-safe",
        source: "activity",
        kind: "evidence",
        title: "Reload-safe artifact",
      },
    ]);
  });

  it("merges the latest run update into its canonical run without duplicate cards", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        runs: [
          {
            id: "run:merge",
            kind: "session",
            title: "Initial run title",
            status: "running",
            artifactRefs: [],
            startedAt: "2026-07-13T08:00:00.000Z",
          },
        ],
      }),
      activity: {
        reports: [
          {
            id: "run:merge",
            kind: "run.update",
            title: "Completed coding run",
            text: "The latest projection wins.",
            role: null,
            status: "succeeded",
            createdAt: "2026-07-13T08:02:00.000Z",
          },
          {
            id: "run:merge",
            kind: "run.update",
            title: "Older coding run",
            text: "Still running.",
            role: null,
            status: "running",
            createdAt: "2026-07-13T08:01:00.000Z",
          },
        ],
      },
    });

    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({
      id: "run:run:merge",
      canonicalId: "run:merge",
      source: "session",
      title: "Completed coding run",
      status: "succeeded",
      summary: "The latest projection wins.",
      updatedAt: "2026-07-13T08:02:00.000Z",
    });
  });

  it("deduplicates fallback run updates when no canonical run has arrived", () => {
    const view = buildSessionWorkbenchView({
      session: session(),
      activity: {
        reports: [
          {
            id: "run:fallback",
            kind: "run.update",
            title: "Fallback run",
            text: "Latest state.",
            role: null,
            status: "running",
            createdAt: "2026-07-13T08:02:00.000Z",
          },
          {
            id: "run:fallback",
            kind: "run.update",
            title: "Fallback run",
            text: "Older state.",
            role: null,
            status: "queued",
            createdAt: "2026-07-13T08:01:00.000Z",
          },
        ],
      },
    });

    expect(view.runs).toMatchObject([
      {
        id: "report:run:fallback",
        canonicalId: "run:fallback",
        source: "report",
        status: "running",
        summary: "Latest state.",
      },
    ]);
  });

  it("prefers a canonical task over a task update fallback with the same ref", () => {
    const view = buildSessionWorkbenchView({
      session: session({
        tasks: [
          {
            ref: "task:same",
            title: "Canonical task",
            status: "done",
            todos: [],
            runRefs: [],
            artifactRefs: [],
          },
        ],
      }),
      activity: {
        reports: [
          {
            id: "task:same",
            kind: "task.update",
            title: "Fallback task",
            text: "Stale task projection.",
            role: null,
            status: "running",
            createdAt: "2026-07-13T08:02:00.000Z",
          },
        ],
      },
    });

    expect(view.tasks).toMatchObject([
      { id: "task:same", source: "session", title: "Canonical task", status: "done" },
    ]);
  });

  it("bounds output and prefers daemon snapshot artifacts over activity fallbacks", () => {
    const longOutput = "x".repeat(5_000);
    const view = buildSessionWorkbenchView({
      session: session({
        evidence: [
          {
            ref: "evidence:same",
            title: "Canonical evidence",
            kind: "document",
            format: "markdown",
            preview: "canonical",
          },
        ],
      }),
      activity: {
        commands: [
          {
            id: "cmd-long",
            title: "Long command",
            goal: null,
            status: "running",
            deliveryStatus: "acked",
            runtimeName: null,
            runtimeStatus: null,
            invocationId: null,
            invocationStatus: "running",
            latestLog: longOutput,
            latestLogAt: null,
            createdAt: "2026-07-13T08:00:00.000Z",
            updatedAt: "2026-07-13T08:00:00.000Z",
          },
        ],
        reports: [
          {
            id: "same",
            kind: "evidence.document",
            title: "Fallback evidence",
            text: "fallback",
            role: "assistant",
            status: "succeeded",
            createdAt: "2026-07-13T08:01:00.000Z",
          },
        ],
      },
    });

    expect(view.runs[0]?.latestOutput).toHaveLength(4_000);
    expect(view.runs[0]?.latestOutput?.endsWith("…")).toBe(true);
    expect(view.evidence).toMatchObject([
      { id: "same", title: "Canonical evidence", source: "session" },
    ]);
  });
});
