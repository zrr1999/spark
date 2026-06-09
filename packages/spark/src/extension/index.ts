import { registerPiContextTool } from "pi-context/extension";
import { registerPiLearningTool, type PiLearningToolHandlers } from "pi-learnings/extension";
import { registerPiTaskTool, type PiTaskToolHandlers } from "pi-tasks/extension";
import { renderSparkToolCall } from "./tool-rendering.ts";
import { registerSparkAskTools } from "./spark-ask-tool-registration.ts";
import { registerSparkDagManagerTool } from "./spark-dag-manager-tool-registration.ts";
import { registerSparkBackgroundRunsTool } from "./spark-background-runs-tool-registration.ts";
import { registerSparkLearningTools } from "./learning-tool-registration.ts";
import { registerSparkStateTool } from "./spark-state-tool-registration.ts";
import { registerSparkTodoTools } from "./spark-todo-tool-registration.ts";
import { registerSparkFinishTaskTool } from "./spark-finish-task-tool-registration.ts";
import { registerSparkClaimTaskTool } from "./spark-claim-task-tool-registration.ts";
import { registerSparkRunReadyTasksTool } from "./spark-run-ready-tasks-tool-registration.ts";
import { registerSparkGoalTool } from "./spark-goal-tool-registration.ts";
import { registerSparkStatusTool } from "./spark-status-tool-registration.ts";
import { registerSparkPlanTasksTool } from "./spark-plan-tasks-tool-registration.ts";
import { registerSparkProjectTools } from "./spark-project-tool-registration.ts";
import { registerSparkCommands, type SparkCommandApi } from "./spark-command-registration.ts";
import {
  ensureSparkStateForActiveWorkspace,
  renderActiveSparkContextSummary,
} from "./spark-active-injection.ts";
import { registerSparkExtensionEvents } from "./spark-extension-events.ts";
import { withSparkToolOperationalNotes } from "./spark-tool-operational-notes.ts";
import { SparkDagManagerController } from "./spark-dag-manager.ts";
import { registerSparkModeCycleShortcut } from "./spark-mode-shortcut.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";
import { SparkWidgetController } from "./spark-widget-controller.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { PiRolesReviewerRunner, type ReviewerRunner } from "./reviewer-runner.ts";

interface SparkExtensionAPI extends SparkCommandApi {
  registerTool?(config: SparkRegisteredToolConfig): void;
  registerInternalTool?(config: SparkRegisteredToolConfig): void;
  registerShortcut?(
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: SparkToolContext) => unknown;
      isActive?: (ctx: SparkToolContext) => boolean;
    },
  ): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  createReviewerRunner?(
    cwd: string,
    ctx: SparkToolContext,
  ): ReviewerRunner | Promise<ReviewerRunner>;
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  const widgetController = new SparkWidgetController();

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    await widgetController.refresh(cwd, ctx);
  }

  const dagManagerController = new SparkDagManagerController({
    refreshSparkWidget,
  });

  const eventHandlers = registerSparkExtensionEvents(pi, {
    refreshSparkWidget,
    ensureDagManager: (cwd, ctx) => dagManagerController.ensure(cwd, ctx),
  });

  const registeredSparkTools = new Map<string, SparkRegisteredToolConfig>();
  const registerSparkTool = (config: SparkRegisteredToolConfig): void => {
    registeredSparkTools.set(config.name, config);
    pi.registerTool?.({
      ...config,
      description: withSparkToolOperationalNotes(config.name, config.description),
      renderCall: (args, theme, context) => renderSparkToolCall(config.name, args, theme, context),
    });
  };
  const registerSparkCompatTool = (config: SparkRegisteredToolConfig): void => {
    registeredSparkTools.set(config.name, config);
    pi.registerInternalTool?.(config);
  };

  async function createReviewerRunner(cwd: string, ctx: SparkToolContext): Promise<ReviewerRunner> {
    const provided = await pi.createReviewerRunner?.(cwd, ctx);
    if (provided) return provided;
    return new PiRolesReviewerRunner({
      registry: await createSparkRoleRegistry(cwd),
      cwd,
    });
  }

  registerSparkCommands(pi, {
    queueSparkAgentInstruction: (ctx, instruction, options) =>
      eventHandlers.queueSparkAgentInstruction(ctx, instruction, options),
    refreshSparkWidget,
    ensureDagManager: (cwd, ctx) => dagManagerController.ensure(cwd, ctx),
    createReviewerRunner,
  });

  registerSparkModeCycleShortcut(pi, { refreshSparkWidget });

  registerSparkStatusTool(registerSparkCompatTool, { ensureSparkStateForActiveWorkspace });

  registerSparkStateTool(registerSparkCompatTool, { ensureSparkStateForActiveWorkspace });

  registerSparkTodoTools(registerSparkCompatTool, { refreshSparkWidget });

  registerSparkFinishTaskTool(registerSparkCompatTool, {
    refreshSparkWidget,
    createReviewerRunner,
  });

  registerSparkProjectTools(registerSparkCompatTool, { refreshSparkWidget });

  registerSparkClaimTaskTool(registerSparkCompatTool, { refreshSparkWidget });

  registerSparkPlanTasksTool(registerSparkCompatTool, { refreshSparkWidget });

  registerSparkGoalTool(registerSparkTool, { refreshSparkWidget, createReviewerRunner });

  registerSparkRunReadyTasksTool(registerSparkCompatTool, {
    ensureDagManager: (cwd, ctx) => dagManagerController.ensure(cwd, ctx),
  });

  registerSparkBackgroundRunsTool(registerSparkCompatTool);

  registerSparkDagManagerTool(registerSparkCompatTool);

  registerSparkAskTools(registerSparkCompatTool);

  registerSparkLearningTools(registerSparkCompatTool);

  if (pi.registerTool) {
    const genericToolRegistrar = {
      registerTool: (config: unknown) => pi.registerTool?.(config as SparkRegisteredToolConfig),
    };
    registerPiTaskTool(genericToolRegistrar, {
      handlers: createSparkTaskHandlers((name) => registeredSparkTools.get(name)),
    });
    registerPiLearningTool(genericToolRegistrar, {
      handlers: createSparkLearningHandlers((name) => registeredSparkTools.get(name)),
    });
    registerPiContextTool(genericToolRegistrar, {
      providers: [
        {
          id: "spark.active",
          label: "Spark active state",
          description: "Bounded active Spark project/task/TODO/SPARK.md context.",
          defaultBudgetChars: 4_000,
          priority: 100,
          async render(ctx) {
            const toolCtx = ctx as SparkToolContext;
            const content = await renderActiveSparkContextSummary(toolCtx.cwd, toolCtx);
            if (!content) return undefined;
            return { content, refs: ["SPARK.md", ".spark/projects.json"] };
          },
        },
      ],
    });
  }
}

type SparkImplementationResolver = (name: string) => SparkRegisteredToolConfig | undefined;

function createSparkTaskHandlers(resolveTool: SparkImplementationResolver): PiTaskToolHandlers {
  const direct = (toolName: string) =>
    (({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, toolName, {
        toolCallId,
        params: stripTaskAction(params),
        signal,
        onUpdate,
        ctx,
      })) satisfies NonNullable<PiTaskToolHandlers["status"]>;

  return {
    status: direct("spark_status"),
    project_list: direct("spark_list_projects"),
    project_use: direct("spark_use_project"),
    project_update: direct("spark_rename_project"),
    claim: direct("spark_claim_task"),
    plan: direct("spark_plan_tasks"),
    finish: direct("spark_finish_task"),
    todo_update: ({ toolCallId, params, signal, onUpdate, ctx }) => {
      const scope = normalizeTaskTodoScope(params.scope);
      return executeSparkImplementationTool(
        resolveTool,
        scope === "task" ? "spark_update_task_todos" : "spark_update_todos",
        {
          toolCallId,
          params: stripTaskActionAndScope(params),
          signal,
          onUpdate,
          ctx,
        },
      );
    },
    run_ready: direct("spark_run_ready_tasks"),
    run_status: ({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "spark_background_runs", {
        toolCallId,
        params: {
          ...stripTaskAction(params),
          action: normalizeTaskRunStatusAction(params.runAction),
          runAction: undefined,
        },
        signal,
        onUpdate,
        ctx,
      }),
    run_control: ({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "spark_background_runs", {
        toolCallId,
        params: {
          ...stripTaskAction(params),
          action: normalizeTaskRunControlAction(params.control),
          control: undefined,
        },
        signal,
        onUpdate,
        ctx,
      }),
    cache_cleanup: ({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "spark_state", {
        toolCallId,
        params: { ...stripTaskAction(params), action: "cleanup" },
        signal,
        onUpdate,
        ctx,
      }),
  };
}

function createSparkLearningHandlers(
  resolveTool: SparkImplementationResolver,
): PiLearningToolHandlers {
  const direct = (toolName: string) =>
    (({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, toolName, {
        toolCallId,
        params: stripLearningAction(params),
        signal,
        onUpdate,
        ctx,
      })) satisfies NonNullable<PiLearningToolHandlers["record"]>;

  return {
    record: direct("spark_learning_record"),
    search: direct("spark_learning_search"),
    list: direct("spark_learning_list"),
    read: direct("spark_learning_read"),
    mark_stale: direct("spark_learning_mark_stale"),
    supersede: direct("spark_learning_supersede"),
    reject: direct("spark_learning_reject"),
    export_markdown: direct("spark_learning_export_markdown"),
    import_markdown: direct("spark_learning_import_markdown"),
  };
}

function executeSparkImplementationTool(
  resolveTool: SparkImplementationResolver,
  toolName: string,
  input: {
    toolCallId: string;
    params: Record<string, unknown>;
    signal: AbortSignal;
    onUpdate: Parameters<SparkRegisteredToolConfig["execute"]>[3];
    ctx: unknown;
  },
) {
  const tool = resolveTool(toolName);
  if (!tool) throw new Error(`Spark facade implementation is unavailable for ${toolName}`);
  return tool.execute(
    input.toolCallId,
    removeUndefined(input.params),
    input.signal,
    input.onUpdate,
    input.ctx as SparkToolContext,
  );
}

function normalizeTaskTodoScope(value: unknown): "session" | "task" {
  if (value === "session" || value === undefined || value === null) return "session";
  if (value === "task") return "task";
  throw new Error('task.scope must be "session" or "task" for todo_update');
}

function normalizeTaskRunStatusAction(value: unknown): "status" | "list" | "inspect" | "reconcile" {
  if (value === undefined || value === null) return "status";
  if (value === "status" || value === "list" || value === "inspect" || value === "reconcile") {
    return value;
  }
  throw new Error("task.runAction must be status, list, inspect, or reconcile for run_status");
}

function normalizeTaskRunControlAction(value: unknown): "kill" | "reconcile" | "ack" {
  if (value === "kill" || value === "reconcile" || value === "ack") return value;
  throw new Error("task.control must be kill, reconcile, or ack for run_control");
}

function stripTaskAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return removeUndefined(rest);
}

function stripTaskActionAndScope(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, scope: _scope, ...rest } = params;
  return removeUndefined(rest);
}

function stripLearningAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return removeUndefined(rest);
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
