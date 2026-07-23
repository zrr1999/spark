import { Type } from "typebox";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { clarifyProjectPurposeIfNeeded } from "../flows/project-purpose-flow.ts";
import { currentSparkProject, loadSparkGraph, saveCurrentProjectRef } from "./session-state.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
import { requireKnownSparkProjectKind } from "./project-kind-registry.ts"; // deprecated no-op
import {
  collectSparkProjectSummaries,
  findDuplicateSparkProjects,
  normalizeSparkNewProjectInput,
  normalizeSparkProjectPatch,
  normalizeSparkProjectOptionalString,
  resolveSparkProject,
  saveProjectPurposeTrace,
} from "./spark-project-tools.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkProjectToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkProjectTools(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkProjectToolDependencies,
): void {
  registerSparkTool({
    name: "impl_list_projects",
    label: "Spark List Projects",
    description:
      "List Spark projects as a compact text summary with full structured rows in details.projects. Projects are permanent; status filters are not supported. Example details item: { ref, title, taskCounts: { total, active, done, cancelled }, currentForSession }.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: "Maximum project rows to show. Default: 20." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      const limit = normalizeProjectListLimit(params.limit);
      if (!graph) {
        const details = { found: false, count: 0, shown: 0, projects: [] };
        return { content: [{ type: "text", text: renderProjectListSummary([], 0) }], details };
      }
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const projects = collectSparkProjectSummaries({
        graph,
        currentProjectRef: currentProject?.ref,
      });
      const visible = projects.slice(0, limit);
      return {
        content: [{ type: "text", text: renderProjectListSummary(visible, projects.length) }],
        details: { found: true, count: projects.length, shown: visible.length, projects: visible },
      };
    },
  });

  registerSparkTool({
    name: "impl_project_mutation",
    label: "Spark Project Mutation",
    description:
      "Internal implementation for task_write project_rename/project_metadata_update. Defaults to this session's current project.",
    parameters: Type.Object({
      intent: Type.String({
        description: "rename | metadata_update. Internal facade selector.",
      }),
      project: Type.Optional(
        Type.String({
          description: "Existing project ref or title/title prefix. Defaults to current project.",
        }),
      ),
      projectRef: Type.Optional(Type.String({ description: "Existing project ref/title." })),
      title: Type.Optional(Type.String({ description: "New project title for project_rename." })),
      description: Type.Optional(
        Type.String({ description: "New project description for project_metadata_update." }),
      ),
      purpose: Type.Optional(
        Type.String({ description: "Durable project purpose for project_metadata_update." }),
      ),
      outputLanguage: Type.Optional(Type.String({ description: "zh | en" })),
      kind: Type.Optional(
        Type.String({ description: "Deprecated: project kinds are no longer used. Ignored." }),
      ),
      kindState: Type.Optional(
        Type.Any({ description: "Deprecated: project kind state is no longer used. Ignored." }),
      ),
      text: Type.Optional(Type.String({ description: "Reason/details for metadata updates." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const intent = normalizeSparkProjectMutationIntent(params.intent);
      const projectSelector = normalizeSparkProjectOptionalString(
        params.projectRef ?? params.project,
        "project",
      );
      const patchResult = normalizeSparkProjectIntentPatch(params, intent);
      if (patchResult.ok && patchResult.patch.kind)
        requireKnownSparkProjectKind(patchResult.patch.kind);
      if (!patchResult.ok)
        return {
          content: [{ type: "text", text: patchResult.message }],
          details: { found: true, error: patchResult.error, intent },
          isError: true,
        };

      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          const project = projectSelector?.trim()
            ? resolveSparkProject(graph, projectSelector)
            : await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const before = project;
          const after = graph.updateProject(project.ref, patchResult.patch);
          return {
            before,
            project: after,
          };
        },
        { createIfMissing: false },
      );
      if (!updated.graph || updated.result.error === "no_project")
        return {
          content: [{ type: "text", text: "No matching Spark project found." }],
          details: { found: false, error: "no_project", intent },
          isError: true,
        };
      await deps.refreshSparkWidget(cwd, ctx);
      const details = renderProjectMutationDetails({
        intent,
        before: updated.result.before,
        project: updated.result.project,
        reason: normalizeSparkProjectOptionalString(params.text, "text"),
      });
      return {
        content: [{ type: "text", text: renderProjectMutationText(details) }],
        details: details as unknown as Record<string, unknown>,
      };
    },
  });

  registerSparkTool({
    name: "impl_use_project",
    label: "Spark Use Project",
    description:
      'Implementation for task_write({ action: "project_use" }): set or create this Pi session\'s current Spark project. Other sessions keep their own current project selection. Use task_write({ action: "project_rename" }) to rename an existing project.',
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Existing project ref or title/title prefix to use." }),
      ),
      title: Type.Optional(
        Type.String({
          description: "Title to use when creating/selecting a project if project is omitted.",
        }),
      ),
      description: Type.Optional(
        Type.String({ description: "Description for a newly created project." }),
      ),
      purpose: Type.Optional(Type.String({ description: "Purpose for a newly created project." })),
      outputLanguage: Type.Optional(
        Type.String({ description: "zh | en for a newly created project." }),
      ),
      kind: Type.Optional(
        Type.String({ description: "Deprecated: project kinds are no longer used. Ignored." }),
      ),
      kindState: Type.Optional(
        Type.Any({ description: "Deprecated: project kind state is no longer used. Ignored." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      await ensureLocalSparkDirectory(cwd);
      const store = defaultTaskGraphStore(cwd);
      let graph = await loadSparkGraph(cwd, ctx);
      graph ??= new TaskGraph();
      const input = normalizeSparkNewProjectInput(params);
      if (input.kind) requireKnownSparkProjectKind(input.kind);
      let project = resolveSparkProject(graph, input.project);
      let created = false;
      let mutated = false;
      if (!project) {
        if (!input.title)
          return {
            content: [
              {
                type: "text",
                text: "Provide an existing project ref/title, or provide title to create a new current project for this session.",
              },
            ],
            details: { found: true, error: "missing_project_or_title" },
          };
        const description = input.description || input.title;
        const duplicateGate = findDuplicateSparkProjects({
          graph,
          title: input.title,
          description,
        });
        if (duplicateGate.blocked)
          return {
            content: [
              {
                type: "text",
                text: renderDuplicateProjectBlockedMessage(duplicateGate.candidates),
              },
            ],
            details: {
              found: true,
              error: "duplicate_project",
              duplicateProject: true,
              candidates: duplicateGate.candidates,
              guidance: duplicateGate.guidance,
            },
          };
        const clarification = await clarifyProjectPurposeIfNeeded({
          cwd,
          title: input.title,
          description,
          explicitProject: input.project,
          ui: sparkAskUi(ctx),
        });
        project = graph.createProject({
          title: input.title,
          description,
          purpose: input.purpose,
          outputLanguage: input.outputLanguage,
          kind: input.kind,
          kindState: input.kindState,
        });
        created = true;
        await saveProjectPurposeTrace(cwd, project.ref, clarification);
      } else if (input.kind && input.kind !== (project.kind ?? "generic")) {
        project = graph.updateProject(project.ref, {
          kind: input.kind,
          kindState: input.kindState,
        });
        mutated = true;
      } else if (input.kindState !== undefined) {
        project = graph.updateProject(project.ref, { kindState: input.kindState });
        mutated = true;
      }
      if (created || mutated) await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref);
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created new" : "Selected existing"} Spark project for this session: ${project.title} (${project.ref})`,
          },
        ],
        details: {
          created,
          kindChanged: mutated,
          project: project as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

type SparkProjectMutationIntent = "rename" | "metadata_update";

type SparkProjectIntentPatchResult =
  | { ok: true; patch: ReturnType<typeof normalizeSparkProjectPatch> }
  | { ok: false; error: string; message: string };

interface ProjectMutationDetails {
  found: true;
  intent: SparkProjectMutationIntent;
  projectRef: string;
  title: string;
  project: Record<string, unknown>;
  titleBefore?: string;
  titleAfter?: string;
  reason?: string;
  changedFields?: string[];
}

function normalizeSparkProjectMutationIntent(value: unknown): SparkProjectMutationIntent {
  if (value === "rename" || value === "metadata_update") return value;
  throw new Error("project mutation intent must be rename or metadata_update");
}

function normalizeSparkProjectIntentPatch(
  params: Record<string, unknown>,
  intent: SparkProjectMutationIntent,
): SparkProjectIntentPatchResult {
  const patch = normalizeSparkProjectPatch(params);
  if (params.status !== undefined && params.status !== null)
    return {
      ok: false,
      error: "project_status_removed",
      message: "Project.status lifecycle has been removed; Projects are permanent records.",
    };
  if (intent === "rename") {
    if (!patch.title)
      return {
        ok: false,
        error: "missing_project_title",
        message: "project_rename requires title.",
      };
    const invalid = ["description", "purpose", "outputLanguage", "kind", "kindState"].filter(
      (field) => params[field] !== undefined && params[field] !== null,
    );
    if (invalid.length > 0)
      return {
        ok: false,
        error: "invalid_project_rename_patch",
        message: `project_rename only accepts title; use project_metadata_update for ${invalid.join(", ")}.`,
      };
    return { ok: true, patch: { title: patch.title } };
  }
  const invalid = ["title", "status"].filter(
    (field) => params[field] !== undefined && params[field] !== null,
  );
  if (invalid.length > 0)
    return {
      ok: false,
      error: "invalid_project_metadata_patch",
      message: `project_metadata_update does not accept ${invalid.join(", ")}; use project_rename for title changes.`,
    };
  if (
    !patch.description &&
    !patch.purpose &&
    !patch.outputLanguage &&
    !patch.kind &&
    patch.kindState === undefined
  )
    return {
      ok: false,
      error: "missing_project_metadata_patch",
      message: "Provide description, purpose, outputLanguage, or kind to update project metadata.",
    };
  return {
    ok: true,
    patch: {
      description: patch.description,
      purpose: patch.purpose,
      outputLanguage: patch.outputLanguage,
      kind: patch.kind,
      kindState: patch.kindState,
    },
  };
}

function renderProjectMutationDetails(input: {
  intent: SparkProjectMutationIntent;
  before: NonNullable<ReturnType<TaskGraph["projects"]>[number]>;
  project: NonNullable<ReturnType<TaskGraph["projects"]>[number]>;
  reason?: string;
}): ProjectMutationDetails {
  const changedFields = projectChangedFields(input.before, input.project);
  return {
    found: true,
    intent: input.intent,
    projectRef: input.project.ref,
    title: input.project.title,
    project: input.project as unknown as Record<string, unknown>,
    ...(input.intent === "rename"
      ? { titleBefore: input.before.title, titleAfter: input.project.title }
      : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(changedFields.length > 0 ? { changedFields } : {}),
  };
}

function projectChangedFields(
  before: NonNullable<ReturnType<TaskGraph["projects"]>[number]>,
  after: NonNullable<ReturnType<TaskGraph["projects"]>[number]>,
): string[] {
  const fields = ["title", "description", "purpose", "outputLanguage", "kind"] as const;
  const changed: string[] = fields.filter((field) => before[field] !== after[field]);
  if (JSON.stringify(before.kindState) !== JSON.stringify(after.kindState))
    changed.push("kindState");
  return changed;
}

function renderProjectListSummary(projects: Array<Record<string, unknown>>, total: number): string {
  const lines = [
    `Spark projects: ${total}${projects.length < total ? ` (showing ${projects.length})` : ""}`,
  ];
  if (projects.length === 0) {
    lines.push("- No projects.");
    return lines.join("\n");
  }
  for (const project of projects) {
    const counts = isProjectTaskCounts(project.taskCounts) ? project.taskCounts : undefined;
    const ref = typeof project.ref === "string" ? project.ref : "proj:?";
    const title = typeof project.title === "string" ? project.title : "Untitled project";
    const countText = counts
      ? ` total=${counts.total ?? 0} active=${counts.active ?? 0} done=${counts.done ?? 0} cancelled=${counts.cancelled ?? 0}`
      : "";
    lines.push(`- ${project.currentForSession === true ? "*" : " "} ${ref} ${title}${countText}`);
  }
  if (projects.length < total) lines.push(`- … ${total - projects.length} more project(s)`);
  return lines.join("\n");
}

function isProjectTaskCounts(
  value: unknown,
): value is { total?: number; active?: number; done?: number; cancelled?: number } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProjectListLimit(value: unknown): number {
  if (value === undefined || value === null) return 20;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error("project_list limit must be a positive integer");
  return value;
}

function renderProjectMutationText(details: ProjectMutationDetails): string {
  switch (details.intent) {
    case "rename":
      return `Renamed Spark project: ${details.titleBefore} -> ${details.titleAfter} (${details.projectRef})`;
    case "metadata_update":
      return `Updated Spark project metadata: ${details.title} (${details.projectRef}) fields=${details.changedFields?.join(",") || "none"}`;
  }
}

function renderDuplicateProjectBlockedMessage(
  candidates: Array<{ ref: string; title: string; reason: string }>,
): string {
  const candidateLines = candidates.length
    ? candidates
        .map(
          (candidate, index) =>
            `${index + 1}. ${candidate.title} (${candidate.ref}, ${candidate.reason})`,
        )
        .join("\n")
    : "No candidate details available.";
  return [
    "Duplicate Spark project creation blocked: the requested Project is too similar to an existing Project.",
    "Candidates:",
    candidateLines,
    "Next steps:",
    '- Select the existing Project with task_write({ action: "project_use", project: <candidate ref or title> }) when it is the same work.',
    "- Ask the user which Project to use when the match is ambiguous.",
    "- Retry creation only with a clearer differentiated title/description for genuinely new work.",
    "- No destructive merge/task move/artifact relink is performed; selecting an existing Project is the merge-like action in this slice.",
  ].join("\n");
}
