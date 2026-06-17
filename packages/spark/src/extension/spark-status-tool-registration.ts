import { Type } from "typebox";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultTaskGraphStore } from "@zendev-lab/pi-tasks";
import { reconcileSparkWorkflowRunsWithActiveProcesses } from "./background-runs.ts";
import { collectRecentRoleRunCompletions } from "./role-run-completions.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionKey,
} from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import {
  DEFAULT_SPARK_STATUS_ACTIVE_LIMIT,
  DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
  renderSparkStatus,
} from "./spark-status-rendering.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusShowFinished,
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
    name: "spark_status",
    label: "Spark Status",
    description:
      'Compatibility surface for task_read({ action: "status" }): show Spark project/task status. Defaults to an active view focused on unfinished work and current session state; use view=full for all history.',
    parameters: Type.Object({
      view: Type.Optional(
        Type.String({
          default: "active",
          description:
            "active | summary | full. active shows unfinished work for the current project/session, summary shows project counts only, full includes done/cancelled history.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum number of task rows per project. Defaults to 8 in active view; omitted in summary/full unless provided.",
        }),
      ),
      format: Type.Optional(
        Type.String({
          default: "text",
          description:
            "text | json. text returns the human-readable status; json returns the structured status payload as JSON text for tool/LLM callers.",
        }),
      ),
      includeDetails: Type.Optional(
        Type.Boolean({
          default: false,
          description:
            "When format=json, return the full historical payload instead of the compact decision payload.",
        }),
      ),
      showFinished: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Deprecated alias for view=full when true.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      await deps.ensureSparkStateForActiveWorkspace(cwd, ctx);
      const format = normalizeSparkStatusFormat(params);
      const store = defaultTaskGraphStore(cwd);
      const graph = await loadSparkGraph(cwd, ctx);
      if (!graph) {
        const details = { found: false, active: false, format };
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
      const view = normalizeSparkStatusShowFinished(params)
        ? "full"
        : normalizeSparkStatusView(params);
      const explicitLimit = normalizeSparkStatusLimit(params);
      const taskLimit =
        view === "summary"
          ? undefined
          : (explicitLimit ?? (view === "active" ? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT : undefined));
      const runStore = defaultSparkWorkflowRunStore(cwd);
      await reconcileSparkWorkflowRunsWithActiveProcesses(runStore, graph, cwd);
      const workflowRunStatus = await runStore.status();
      const runControl = await runStore.loadControl();
      const sessionKey = sparkSessionKey(ctx);
      const independentTodos = await loadIndependentTodos(cwd, ctx);
      const currentProject = await currentSparkProject(cwd, ctx, graph);
      const sessionGoal = await loadSessionGoal(cwd, ctx);
      const recentRoleRunCompletions =
        view === "summary"
          ? []
          : collectRecentRoleRunCompletions({
              graph,
              projectRef: currentProject?.ref,
              limit: DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
            });
      const state =
        view === "full"
          ? await collectSparkStateHousekeeping(cwd, sparkStateSessionScopes(ctx), graph)
          : undefined;
      const rendered = renderSparkStatus({
        graph,
        view,
        taskLimit,
        sessionKey,
        currentProject,
        workflowRunStatus,
        runControl,
        sessionGoal,
        independentTodos,
        recentRoleRunCompletions,
        state,
      });
      const includeDetails = normalizeSparkStatusBoolean(
        params.includeDetails,
        false,
        "includeDetails",
      );
      const jsonPayload =
        includeDetails || view === "full" ? rendered.details : rendered.compactDetails;
      const details = {
        ...(format === "json" ? jsonPayload : rendered.details),
        format,
      };
      return {
        content: [
          {
            type: "text",
            text: format === "json" ? JSON.stringify(details, null, 2) : rendered.lines.join("\n"),
          },
        ],
        details,
      };
    },
  });
}

function normalizeSparkStatusBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
