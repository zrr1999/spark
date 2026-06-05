import { Type } from "typebox";
import { defaultTaskGraphStore } from "spark-tasks";
import { clarifyProjectIntentIfNeeded } from "../flows/project-intent-flow.ts";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  loadCurrentProjectRef,
  loadSparkGraph,
  saveCurrentProjectRef,
} from "./session-state.ts";
import { sparkAskUi } from "./spark-ask-ui.ts";
import {
  collectSparkProjectSummaries,
  hasSparkProjectPatch,
  normalizeSparkNewProjectInput,
  normalizeSparkProjectPatch,
  normalizeSparkProjectOptionalString,
  resolveSparkProject,
  saveProjectIntentTrace,
} from "./spark-project-tools.ts";
import { normalizeSparkProjectListStatus } from "./spark-status.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkProjectToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkProjectTools(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkProjectToolDependencies,
): void {
  registerSparkTool({
    name: "spark_list_projects",
    label: "Spark List Projects",
    description:
      "List Spark projects as structured JSON without parsing spark_status text. Parameters: status=active|done|all (default active). Example output item: { ref, title, status, taskCounts: { total, active, done, cancelled }, currentForSession }.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          default: "active",
          description: "active | done | all. Defaults to active.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      const status = normalizeSparkProjectListStatus(params);
      if (!graph) {
        const details = { found: false, status, projects: [] };
        return { content: [{ type: "text", text: JSON.stringify([], null, 2) }], details };
      }
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const projects = collectSparkProjectSummaries({
        graph,
        status,
        currentProjectRef: currentProject?.ref,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
        details: { found: true, status, projects },
      };
    },
  });

  registerSparkTool({
    name: "spark_rename_project",
    label: "Spark Rename Project",
    description:
      "Rename or update metadata for an existing Spark project without changing task refs. Defaults to this session's current project.",
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({
          description: "Existing project ref or title/title prefix. Defaults to current project.",
        }),
      ),
      title: Type.Optional(Type.String({ description: "New project title." })),
      description: Type.Optional(Type.String({ description: "New project description." })),
      status: Type.Optional(Type.String({ description: "active | done" })),
      outputLanguage: Type.Optional(Type.String({ description: "zh | en" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const projectSelector = normalizeSparkProjectOptionalString(params.project, "project");
      const patch = normalizeSparkProjectPatch(params);
      if (!hasSparkProjectPatch(patch))
        return {
          content: [
            {
              type: "text",
              text: "Provide title, description, status, or outputLanguage to update the Spark project.",
            },
          ],
          details: { found: true, error: "missing_project_patch" },
        };

      const store = defaultTaskGraphStore(cwd);
      const updated = await store.update(
        async (graph) => {
          const project = projectSelector?.trim()
            ? resolveSparkProject(graph, projectSelector)
            : await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const renamed = graph.updateProject(project.ref, patch);
          return { project: renamed };
        },
        { createIfMissing: false },
      );
      if (!updated.graph || updated.result.error === "no_project")
        return {
          content: [{ type: "text", text: "No matching Spark project found." }],
          details: { found: false, error: "no_project" },
        };
      const currentProjectRef = await loadCurrentProjectRef(cwd, ctx);
      if (
        updated.result.project.status === "done" &&
        currentProjectRef === updated.result.project.ref
      )
        await clearCurrentProjectRef(cwd, ctx);
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Renamed Spark project: ${updated.result.project.title} (${updated.result.project.ref})`,
          },
        ],
        details: { project: updated.result.project as unknown as Record<string, unknown> },
      };
    },
  });

  registerSparkTool({
    name: "spark_use_project",
    label: "Spark Use Project",
    description:
      'Compatibility surface for task({ action: "project_use" }): set or create this Pi session\'s current Spark project. Other sessions keep their own current project selection. Use task({ action: "project_update" }) to rename an existing project.',
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Existing project ref or title/title prefix to use." }),
      ),
      title: Type.Optional(
        Type.String({ description: "Title for a new project if project is omitted." }),
      ),
      description: Type.Optional(
        Type.String({ description: "Description for a newly created project." }),
      ),
      outputLanguage: Type.Optional(
        Type.String({ description: "zh | en for a newly created project." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
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
        const clarification = await clarifyProjectIntentIfNeeded({
          cwd,
          title: input.title,
          description,
          explicitProject: input.project,
          ui: sparkAskUi(ctx),
        });
        project = graph.createProject({
          title: input.title,
          description,
          outputLanguage: input.outputLanguage,
        });
        created = true;
        await store.save(graph);
        await saveProjectIntentTrace(cwd, project.ref, clarification);
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
