import { describe, expect, it } from "vitest";
import { buildProjectTaskBoard } from "./project-task-board";

describe("project task board", () => {
  it("groups ready/claimed/done/blocked tasks, marks ready-frontier assign actions, and links evidence", () => {
    const board = buildProjectTaskBoard({
      canAssign: true,
      artifacts: [
        { id: "artifact-plan", title: "Plan evidence", kind: "record", format: "json" },
        { id: "artifact-build", title: "Build output", kind: "document", format: "markdown" },
      ],
      tasks: [
        {
          runtimeTaskId: "task-plan",
          title: "Plan",
          statusGroup: "done",
          readyFrontier: false,
          outputArtifactIds: ["artifact-plan"],
        },
        {
          runtimeTaskId: "task-build",
          title: "Build",
          statusGroup: "ready",
          readyFrontier: true,
          inputArtifactIds: ["artifact-plan"],
          outputArtifactIds: ["artifact-build"],
        },
        {
          runtimeTaskId: "task-run",
          title: "Run",
          statusGroup: "running",
          readyFrontier: false,
        },
        {
          runtimeTaskId: "task-review",
          title: "Review",
          statusGroup: "blocked",
          readyFrontier: false,
        },
      ],
    });

    expect(
      board.map((column) => [column.id, column.cards.map((card) => card.task.runtimeTaskId)]),
    ).toEqual([
      ["ready", ["task-build"]],
      ["running", ["task-run"]],
      ["blocked", ["task-review"]],
      ["done", ["task-plan"]],
    ]);
    expect(board[0]?.cards[0]).toMatchObject({
      assignable: true,
      evidenceArtifacts: [
        { id: "artifact-build", title: "Build output" },
        { id: "artifact-plan", title: "Plan evidence" },
      ],
    });
  });

  it("disables assign controls when workspace mutation is unavailable", () => {
    const board = buildProjectTaskBoard({
      canAssign: false,
      artifacts: [],
      tasks: [
        { runtimeTaskId: "task-build", title: "Build", statusGroup: "ready", readyFrontier: true },
      ],
    });

    expect(board[0]?.cards[0]?.assignable).toBe(false);
  });
});
