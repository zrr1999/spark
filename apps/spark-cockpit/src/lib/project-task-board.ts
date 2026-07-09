export interface ProjectTaskBoardTask {
  runtimeTaskId: string;
  title: string;
  statusGroup: string;
  readyFrontier: boolean;
  outputArtifactIds?: readonly string[];
  inputArtifactIds?: readonly string[];
}

export interface ProjectTaskBoardArtifact {
  id: string;
  title: string;
  kind: string;
  format: string;
}

export interface ProjectTaskBoardCard {
  task: ProjectTaskBoardTask;
  evidenceArtifacts: ProjectTaskBoardArtifact[];
  assignable: boolean;
}

export interface ProjectTaskBoardColumn {
  id: string;
  label: string;
  cards: ProjectTaskBoardCard[];
}

const columns = [
  { id: "ready", label: "Ready" },
  { id: "running", label: "Claimed" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "other", label: "Other" },
] as const;

export function buildProjectTaskBoard(input: {
  tasks: readonly ProjectTaskBoardTask[];
  artifacts: readonly ProjectTaskBoardArtifact[];
  canAssign: boolean;
}): ProjectTaskBoardColumn[] {
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const grouped = new Map<string, ProjectTaskBoardCard[]>();
  for (const task of input.tasks) {
    const columnId = columns.some((column) => column.id === task.statusGroup)
      ? task.statusGroup
      : "other";
    const evidenceArtifacts = [...(task.outputArtifactIds ?? []), ...(task.inputArtifactIds ?? [])]
      .flatMap((artifactId) => artifactById.get(artifactId) ?? [])
      .slice(0, 3);
    const cards = grouped.get(columnId) ?? [];
    cards.push({
      task,
      evidenceArtifacts,
      assignable: input.canAssign && task.readyFrontier,
    });
    grouped.set(columnId, cards);
  }

  return columns
    .map((column) => ({ ...column, cards: grouped.get(column.id) ?? [] }))
    .filter((column) => column.cards.length > 0 || column.id !== "other");
}
