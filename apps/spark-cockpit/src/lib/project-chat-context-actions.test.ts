import { describe, expect, it } from "vitest";
import {
  buildProjectChatContextActions,
  type ProjectChatContextMessages,
} from "./project-chat-context-actions";

const messages: ProjectChatContextMessages = {
  suggestNoTasks: "Plan first task for {projectName}",
  suggestBlockedTask: "Unblock {title}",
  suggestRecentArtifact: "Review artifact {title}",
  suggestPendingInbox: "Answer inbox {title}",
  taskContextKicker: "Task",
  artifactContextKicker: "Artifact",
  inboxContextKicker: "Pending decision",
  askAboutThis: "Ask about this",
  attachToChat: "Attach to chat",
  openArtifact: "Open artifact",
  openInbox: "Open inbox",
};

describe("project chat context actions", () => {
  it("adds an empty-state prompt when the project has no tasks", () => {
    const result = buildProjectChatContextActions({
      projectName: "Empty project",
      tasks: [],
      artifacts: [],
      inboxItems: [],
      baseSuggestions: ["Summarize"],
      workspaceUrl: "/workspaces/local",
      messages,
    });

    expect(result.suggestions[0]).toMatchObject({
      id: "no-tasks",
      label: "Plan first task for Empty project",
      prompt: "Plan first task for Empty project",
    });
    expect(result.cards).toEqual([]);
  });

  it("prioritizes blocked task prompts and task context cards", () => {
    const result = buildProjectChatContextActions({
      projectName: "Blocked project",
      tasks: [
        {
          runtimeTaskId: "task-ready",
          title: "Ready task",
          description: null,
          status: "ready",
          statusGroup: "ready",
        },
        {
          runtimeTaskId: "task-blocked",
          title: "Blocked task",
          description: "Needs a decision",
          status: "blocked",
          statusGroup: "blocked",
        },
      ],
      artifacts: [],
      inboxItems: [],
      baseSuggestions: [],
      workspaceUrl: "/workspaces/local",
      messages,
    });

    expect(result.suggestions[0]?.prompt).toBe("Unblock Blocked task");
    expect(result.cards[0]).toMatchObject({
      type: "task",
      title: "Blocked task",
      primaryLabel: "Ask about this",
    });
    expect(result.cards[0]?.prompt).toContain("task-blocked");
  });

  it("creates recent artifact prompt and link card", () => {
    const result = buildProjectChatContextActions({
      projectName: "Artifact project",
      tasks: [],
      artifacts: [
        {
          id: "art-1",
          title: "Architecture note",
          kind: "document",
          format: "markdown",
          source: "task",
        },
      ],
      inboxItems: [],
      baseSuggestions: [],
      workspaceUrl: "/workspaces/local",
      messages,
    });

    expect(
      result.suggestions.some(
        (suggestion) => suggestion.prompt === "Review artifact Architecture note",
      ),
    ).toBe(true);
    expect(result.cards).toContainEqual(
      expect.objectContaining({
        type: "artifact",
        href: "/workspaces/local/artifacts/art-1",
        primaryLabel: "Attach to chat",
        secondaryLabel: "Open artifact",
      }),
    );
  });

  it("surfaces pending inbox items before other context cards", () => {
    const result = buildProjectChatContextActions({
      projectName: "Inbox project",
      tasks: [
        {
          runtimeTaskId: "task-1",
          title: "Task",
          description: null,
          status: "ready",
          statusGroup: "ready",
        },
      ],
      artifacts: [],
      inboxItems: [
        {
          id: "inbox-done",
          title: "Already handled",
          kind: "approval",
          status: "resolved",
          urgency: "low",
        },
        {
          id: "inbox-1",
          title: "Approve plan",
          kind: "approval",
          status: "pending",
          urgency: "high",
        },
      ],
      baseSuggestions: [],
      workspaceUrl: "/workspaces/local",
      messages,
    });

    expect(
      result.suggestions.some((suggestion) => suggestion.prompt === "Answer inbox Approve plan"),
    ).toBe(true);
    expect(result.cards[0]).toMatchObject({
      type: "inbox",
      title: "Approve plan",
      href: "/workspaces/local/inbox/inbox-1",
      primaryLabel: "Ask about this",
      secondaryLabel: "Open inbox",
    });
  });
});
