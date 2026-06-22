import { Type } from "typebox";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/pi-tasks";
import { clarifyProjectPurposeIfNeeded } from "../flows/project-purpose-flow.ts";
import { currentSparkProject, loadSparkGraph, saveCurrentProjectRef } from "./session-state.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
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
      'List Spark projects as structured JSON without parsing task_read({ action: "workspace_status" }) text. Projects are permanent; status filters are not supported. Example output item: { ref, title, taskCounts: { total, active, done, cancelled }, currentForSession }.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        const details = { found: false, projects: [] };
        return { content: [{ type: "text", text: JSON.stringify([], null, 2) }], details };
      }
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const projects = collectSparkProjectSummaries({
        graph,
        currentProjectRef: currentProject?.ref,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
        details: { found: true, projects },
      };
    },
  });

  registerSparkTool({
    name: "impl_project_mutation",
    label: "Spark Project Mutation",
    description:
      "Internal implementation for task_write project_rename/project_metadata_update. Defaults to this session's current project.",
    parameters: Type.Object({
      intent: Type.Optional(
        Type.String({
          description: "rename | metadata_update. Internal facade selector.",
        }),
      ),
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      await ensureLocalSparkDirectory(cwd);
      const store = defaultTaskGraphStore(cwd);
      let graph = await loadSparkGraph(cwd, ctx);
      graph ??= new TaskGraph();
      const input = normalizeSparkNewProjectInput(params);
      let project = resolveSparkProject(graph, input.project);
      let created = false;
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
        });
        created = true;
        await store.save(graph);
        await saveProjectPurposeTrace(cwd, project.ref, clarification);
      }
      await saveCurrentProjectRef(cwd, ctx, project.ref);
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created new" : "Selected existing"} Spark project for this session: ${project.title} (${project.ref})`,
          },
        ],
        details: { created, project: project as unknown as Record<string, unknown> },
      };
    },
  });
}

type SparkProjectMutationIntent = "rename" | "metadata_update" | "legacy_update";

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
  if (value === undefined || value === null) return "legacy_update";
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
  if (intent === "legacy_update") {
    if (!hasLegacySparkProjectPatch(patch))
      return {
        ok: false,
        error: "missing_project_patch",
        message:
          "Provide title, description, purpose, or outputLanguage to update the Spark project.",
      };
    return { ok: true, patch };
  }
  if (intent === "rename") {
    if (!patch.title)
      return {
        ok: false,
        error: "missing_project_title",
        message: "project_rename requires title.",
      };
    const invalid = ["description", "purpose", "outputLanguage"].filter(
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
  if (!patch.description && !patch.purpose && !patch.outputLanguage)
    return {
      ok: false,
      error: "missing_project_metadata_patch",
      message: "Provide description, purpose, or outputLanguage to update project metadata.",
    };
  return {
    ok: true,
    patch: {
      description: patch.description,
      purpose: patch.purpose,
      outputLanguage: patch.outputLanguage,
    },
  };
}

function hasLegacySparkProjectPatch(patch: ReturnType<typeof normalizeSparkProjectPatch>): boolean {
  return Boolean(patch.title || patch.description || patch.purpose || patch.outputLanguage);
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
  const fields = ["title", "description", "purpose", "outputLanguage"] as const;
  return fields.filter((field) => before[field] !== after[field]);
}

function renderProjectMutationText(details: ProjectMutationDetails): string {
  switch (details.intent) {
    case "rename":
      return `Renamed Spark project: ${details.titleBefore} -> ${details.titleAfter} (${details.projectRef})`;
    case "metadata_update":
      return `Updated Spark project metadata: ${details.title} (${details.projectRef}) fields=${details.changedFields?.join(",") || "none"}`;
    case "legacy_update":
      return `Updated Spark project: ${details.title} (${details.projectRef}) fields=${details.changedFields?.join(",") || "none"}`;
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
