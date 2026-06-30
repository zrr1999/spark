import { describe, expect, it } from "vitest";
import { buildCockpitProjectTaskDisplay } from "./project-task-display";

describe("project task display model", () => {
  it("uses pi-tasks-style project and task status lines", () => {
    const display = buildCockpitProjectTaskDisplay({
      project: { name: "MVP" },
      projectKind: { badge: "Generic" },
      taskSummary: { total: 2, byStatus: { done: 1, ready: 1 } },
      tasks: [
        {
          runtimeTaskId: "task-plan",
          name: "plan",
          title: "Plan",
          status: "done",
          statusGroup: "done",
          kind: "plan",
          agentRef: null,
          readyFrontier: false,
        },
        {
          runtimeTaskId: "task-build",
          name: "build",
          title: "Build",
          status: "ready",
          statusGroup: "ready",
          kind: "implement",
          agentRef: null,
          readyFrontier: true,
        },
      ],
    });

    expect(display.projectLine).toBe("Project MVP [Generic]");
    expect(display.taskCountsLine).toBe(
      "Tasks: 2 total | 0 claimed | 0 current_session_claimed | ready_frontier=1 | ready=1 done=1",
    );
    expect(display.tasksByRuntimeId["task-build"]?.title).toBe("@build: Build");
    expect(display.tasksByRuntimeId["task-build"]?.statusLine).toBe(
      "- [ready] @build: Build owner=@unassigned ready_frontier=yes",
    );
  });
});
