import type { Project, ProjectRoadmap, RoadmapItem } from "@zendev-lab/pi-extension-api";

/** Read-only project roadmap excerpt for status/active context. Not a planning input. */
export function renderProjectRoadmapContext(project: Project): string {
  const { roadmap } = project;
  const activeItem = activeRoadmapItem(roadmap);
  if (!activeItem && roadmap.items.length === 0) return "";

  const lines = ["Project roadmap (project-owned; tasks own task.plan):"];
  if (activeItem) {
    const title = activeItem.title?.trim() || activeItem.objective.trim() || activeItem.ref;
    lines.push(`- Active item: ${title} (${activeItem.ref})`);
    lines.push(`- Item intent: ${activeItem.objective}`);
  } else {
    lines.push(`- Items: ${roadmap.items.length} (no active item selected)`);
  }
  return `\n\n${lines.join("\n")}`;
}

function activeRoadmapItem(roadmap: ProjectRoadmap): RoadmapItem | undefined {
  if (roadmap.activeItemRef) {
    const active = roadmap.items.find((item) => item.ref === roadmap.activeItemRef);
    if (active) return active;
  }
  return roadmap.items.find((item) => item.status === "active");
}
