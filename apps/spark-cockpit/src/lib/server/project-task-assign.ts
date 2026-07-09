import type { ServerCommandPayload } from "@zendev-lab/spark-protocol";

export interface AssignableProjectTask {
  runtimeTaskId: string;
  name: string | null;
  title: string;
  description: string | null;
}

export function buildProjectTaskAssignCommandPayload(
  task: AssignableProjectTask,
): ServerCommandPayload {
  return {
    kind: "task.start.request",
    title: `Assign ${task.title}`,
    payload: {
      runtimeTaskId: task.runtimeTaskId,
      taskName: task.name,
      prompt: task.description ?? task.title,
      source: "project-cockpit-board",
    },
  };
}
