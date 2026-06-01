import { Type } from "typebox";
import { defaultSparkDagRunStore } from "spark-orchestrator";
import { defaultTaskGraphStore } from "spark-tasks";
import { reconcileSparkDagRunsWithActiveProcesses } from "./background-runs.ts";
import { collectRecentRoleRunCompletions } from "./role-run-completions.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  loadSparkRunMode,
  sparkSessionKey,
  sparkTodoStore,
} from "./session-state.ts";
import { loadIndependentTodos } from "./session-todos.ts";
import {
  DEFAULT_SPARK_STATUS_ACTIVE_LIMIT,
  DEFAULT_SPARK_STATUS_RECENT_COMPLETIONS_LIMIT,
  renderSparkStatus,
} from "./spark-status-rendering.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusShowFinished,
  normalizeSparkStatusView,
} from "./spark-status.ts";
import { sparkStateSessionScopes } from "./spark-state-tool-registration.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
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
      "Show Spark project/task status. Defaults to an active view focused on unfinished work and current session state; use view=full for all history.",
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
            "Maximum number of task rows per project. Defaults to 20 in active view; omitted in summary/full unless provided.",
        }),
      ),
      format: Type.Optional(
        Type.String({
          default: "text",
          description:
            "text | json. text returns the human-readable status; json returns the structured status payload as JSON text for tool/LLM callers.",
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
                format === "json" ? JSON.stringify(details, null, 2) : "No Spark project found.",
            },
          ],
          details,
        };
      }
      if (ensureSparkGraphInvariants(graph)) {
        await store.save(graph);
        await sparkTodoStore(cwd, ctx).save(graph);
      }
      const view = normalizeSparkStatusShowFinished(params)
        ? "full"
        : normalizeSparkStatusView(params);
      const explicitLimit = normalizeSparkStatusLimit(params);
      const taskLimit =
        view === "summary"
          ? undefined
          : (explicitLimit ?? (view === "active" ? DEFAULT_SPARK_STATUS_ACTIVE_LIMIT : undefined));
      const dagRunStore = defaultSparkDagRunStore(cwd);
      await reconcileSparkDagRunsWithActiveProcesses(dagRunStore, graph, cwd);
      const dagStatus = await dagRunStore.status();
      const runMode = await loadSparkRunMode(cwd, ctx);
      const sessionKey = sparkSessionKey(ctx);
      const independentTodos = await loadIndependentTodos(cwd, ctx);
      const currentProject = await currentSparkProject(cwd, ctx, graph);
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
        dagStatus,
        runMode,
        independentTodos,
        recentRoleRunCompletions,
        state,
      });
      const details = {
        ...rendered.details,
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
