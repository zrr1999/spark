import { Type } from "typebox";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultSparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import type { Project, ProjectRef, Task } from "@zendev-lab/spark-core";
import { reconcileSparkWorkflowRunsWithActiveProcesses } from "./background-runs.ts";
import { collectRecentRoleRunCompletions } from "./role-run-completions.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionKey,
} from "./session-state.ts";
import {
  DEFAULT_SPARK_STATUS_ACTIVE_LIMIT,
  DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
  renderSparkStatus,
} from "./spark-status-rendering.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { deriveSparkDriveMode } from "./spark-drive-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { loadSessionLoop } from "./spark-session-loops.ts";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusScope,
  normalizeSparkStatusView,
} from "./spark-status.ts";
import { sparkStateSessionScopes } from "./spark-state-tool-registration.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import { collectSparkStateHousekeeping } from "./state-housekeeping.ts";

interface SparkStatusToolDeps {
  ensureSparkStateForActiveWorkspace: (cwd: string, ctx?: SparkToolContext) => Promise<unknown>;
}

export function registerSparkStatusTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkStatusToolDeps,
): void {
  registerSparkTool({
    name: "impl_status",
    label: "Spark Status",
    description:
      "Internal implementation for task_read scoped status actions: workspace_status, project_status, and task_status. Defaults to an active view focused on unfinished work and current session state; use bounded selectors/limits for drill-down.",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.String({
          default: "workspace",
          description:
            "workspace | project | task. task_read sets this internally from task_status/project_status/workspace_status.",
        }),
      ),
      project: Type.Optional(Type.String({ description: "Project selector/ref/title." })),
      projectRef: Type.Optional(Type.String({ description: "Project ref/title selector." })),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(Type.String({ description: "Task ref/name/title selector." })),
      includeWorkspaceSummary: Type.Optional(
        Type.Boolean({
          default: false,
          description: "For project/task scopes, include broad workspace summary fields.",
        }),
      ),
      includeStateSummary: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Include Spark state/cache summary regardless of view.",
        }),
      ),
      view: Type.Optional(
        Type.String({
          default: "active",
          description:
            "active | summary. active shows unfinished work for the current project/session, summary shows project counts only; use selectors/limits for bounded drill-down.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of task rows per project. Defaults to 8 in active view; omitted in summary unless provided.",
        }),
      ),
      format: Type.Optional(
        Type.String({
          default: "text",
          description:
            "text | json. text returns the human-readable status; json returns the structured status payload as JSON text for tool/LLM callers.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      await deps.ensureSparkStateForActiveWorkspace(cwd, ctx);
      const format = normalizeSparkStatusFormat(params);
      const scope = normalizeSparkStatusScope(params);
      const view = normalizeSparkStatusView(params);
      const explicitLimit = normalizeSparkStatusLimit(params);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        const details = { found: false, active: false, format, scope, view };
        return {
          content: [
            {
              type: "text",
              text:
                format === "json" ? JSON.stringify(details, null, 2) : NO_SPARK_PROJECT_FOUND_HINT,
            },
          ],
          details,
        };
      }
      if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
      const taskLimit =
        view === "summary"
          ? undefined
          : (explicitLimit ?? (view === "active" ? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT : undefined));
      const projectLimit =
        scope === "workspace"
          ? (explicitLimit ?? (view === "summary" ? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT : undefined))
          : undefined;
      const runStore = defaultSparkWorkflowRunStore(cwd);
      await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
      const workflowRunStatus = await runStore.status();
      const dynamicWorkflowRuns = await defaultSparkDynamicWorkflowEventStore(cwd)
        .listRuns()
        .catch(() => []);
      const runControl = await runStore.loadControl();
      const sessionKey = sparkSessionKey(ctx);
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const scoped = resolveSparkStatusScope(graph, currentProject, params, scope);
      if (!scoped.ok)
        return {
          content: [{ type: "text", text: scoped.message }],
          details: {
            found: false,
            scope,
            error: scoped.error,
            selector: scoped.selector,
            format,
          },
        };
      const includeWorkspaceSummary = normalizeSparkStatusBoolean(
        params.includeWorkspaceSummary,
        false,
        "includeWorkspaceSummary",
      );
      const includeStateSummary = normalizeSparkStatusBoolean(
        params.includeStateSummary,
        false,
        "includeStateSummary",
      );
      const sessionGoal = await loadSessionGoal(cwd, ctx);
      const sessionLoop = await loadSessionLoop(cwd, ctx);
      const driveMode = deriveSparkDriveMode({
        activeLens: ctx.sparkActiveLens,
        goal: sessionGoal,
        loop: sessionLoop,
      });
      const recentRoleRunCompletions =
        view === "summary"
          ? []
          : collectRecentRoleRunCompletions({
              graph,
              projectRef: scoped.project?.ref ?? currentProject?.ref,
              limit: DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
            });
      const state = includeStateSummary
        ? await collectSparkStateHousekeeping(cwd, sparkStateSessionScopes(ctx), graph)
        : undefined;
      const rendered = renderSparkStatus({
        graph,
        scope,
        view,
        taskLimit,
        projectLimit,
        targetProjectRef: scoped.project?.ref,
        targetTaskRef: scoped.task?.ref,
        includeWorkspaceSummary,
        sessionKey,
        currentProject,
        workflowRunStatus,
        dynamicWorkflowRuns,
        runControl,
        driveMode,
        sessionGoal,
        sessionLoop,
        recentRoleRunCompletions,
        state,
      });
      const jsonPayload = rendered.compactDetails;
      const details = {
        ...(format === "json" ? jsonPayload : rendered.details),
        format,
      };
      return {
        content: [
          {
            type: "text",
            text:
              format === "json"
                ? JSON.stringify(details, null, 2)
                : renderStatusText(rendered.lines),
          },
        ],
        details,
      };
    },
  });
}

function renderStatusText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

type SparkStatusScopeResolution =
  | { ok: true; project?: Project; task?: Task }
  | { ok: false; error: string; message: string; selector?: string };

function resolveSparkStatusScope(
  graph: TaskGraph,
  currentProject: Project | undefined,
  params: Record<string, unknown>,
  scope: "workspace" | "project" | "task",
): SparkStatusScopeResolution {
  if (scope === "workspace") return { ok: true };
  const projectSelector = normalizeOptionalSparkStatusSelector(
    params.projectRef ?? params.project,
    "project",
  );
  const taskSelector = normalizeOptionalSparkStatusSelector(params.taskRef ?? params.task, "task");
  if (scope === "project") {
    const project = projectSelector
      ? resolveSparkStatusProject(graph, projectSelector)
      : currentProject;
    if (!project)
      return {
        ok: false,
        error: projectSelector ? "project_not_found" : "no_current_project",
        selector: projectSelector,
        message: projectSelector
          ? `No Spark project matched ${projectSelector}. Use projectRef=proj:... or inspect task_read({ action: "project_list" }).`
          : `${NO_SPARK_PROJECT_FOUND_HINT} Use task_read({ action: "workspace_status" }) or task_read({ action: "project_list" }) to inspect projects first.`,
      };
    return { ok: true, project };
  }
  if (!taskSelector)
    return {
      ok: false,
      error: "task_selector_required",
      message:
        'task_status requires task or taskRef. Use task_read({ action: "project_status" }) for a project view or pass taskRef="task:...".',
    };
  const project = projectSelector
    ? resolveSparkStatusProject(graph, projectSelector)
    : currentProject;
  if (projectSelector && !project)
    return {
      ok: false,
      error: "project_not_found",
      selector: projectSelector,
      message: `No Spark project matched ${projectSelector}. Use projectRef=proj:... or omit projectRef when taskRef is globally unique.`,
    };
  const task = resolveSparkStatusTask(graph, taskSelector, project?.ref);
  if (!task)
    return {
      ok: false,
      error: "task_not_found",
      selector: taskSelector,
      message: project
        ? `No Spark task matched ${taskSelector} in project ${project.title} (${project.ref}).`
        : `No Spark task matched ${taskSelector}. Use taskRef=task:..., @name, or exact title.`,
    };
  const ownerProject = graph.getProject(task.projectRef);
  return { ok: true, project: ownerProject, task };
}

function normalizeOptionalSparkStatusSelector(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`task_read status ${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveSparkStatusProject(graph: TaskGraph, selector: string): Project | undefined {
  const needle = selector.trim();
  return graph.projects().find((project) => project.ref === needle || project.title === needle);
}

function resolveSparkStatusTask(
  graph: TaskGraph,
  selector: string,
  projectRef?: ProjectRef,
): Task | undefined {
  const needle = selector.trim();
  const normalized = needle.startsWith("@") ? needle.slice(1) : needle;
  return graph
    .tasks(projectRef)
    .find(
      (task) =>
        task.ref === needle ||
        task.ref === normalized ||
        task.name === normalized ||
        task.title === needle ||
        task.title === normalized,
    );
}

function normalizeSparkStatusBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
