import { registerSparkAskAutoAnswerProvider } from "@zendev-lab/spark-ask";
import { registerSparkContextTool } from "@zendev-lab/spark-host/context";
import {
  registerSparkTaskTool,
  registerSparkTodoTool,
  type SparkTaskActionHandler,
  type SparkTaskToolHandlers,
} from "@zendev-lab/spark-tasks/extension";
import { renderSparkToolCall } from "./tool-rendering.ts";
import { registerSparkAskTools } from "./spark-ask-tool-registration.ts";
import { registerSparkWorkflowRunsTool } from "./spark-workflow-runs-tool-registration.ts";
import { registerSparkWorkflowRunTool } from "./spark-workflow-run-tool-registration.ts";
import { registerSparkStateTool } from "./spark-state-tool-registration.ts";
import { registerSparkTodoTools } from "./spark-todo-tool-registration.ts";
import { registerSparkFinishTaskTool } from "./spark-finish-task-tool-registration.ts";
import { registerSparkClaimTaskTool } from "./spark-claim-task-tool-registration.ts";
import { registerSparkRecoverTaskClaimTool } from "./spark-recover-task-claim-tool-registration.ts";
import { registerSparkRunReadyTasksTool } from "./spark-run-ready-tasks-tool-registration.ts";
import { registerSparkGoalTool } from "./spark-goal-tool-registration.ts";
import { registerSparkLoopTool } from "./spark-loop-tool-registration.ts";
import { registerSparkReproTool } from "./spark-repro-tool-registration.ts";
import { registerSparkDriveTool } from "./spark-drive-tool-registration.ts";
import { registerSparkDriverTool } from "./spark-driver-tool-registration.ts";
import { registerSparkWorkflowDriverTool } from "./spark-workflow-driver-tool-registration.ts";
import { registerSparkStatusTool } from "./spark-status-tool-registration.ts";
import { registerSparkPlanTasksTool } from "./spark-plan-tasks-tool-registration.ts";
import { registerSparkProjectTools } from "./spark-project-tool-registration.ts";
import { registerSparkCommands, type SparkCommandApi } from "./spark-command-registration.ts";
import {
  ensureSparkStateForActiveWorkspace,
  renderActiveSparkContextSummary,
} from "./spark-active-injection.ts";
import { registerSparkExtensionEvents } from "./spark-extension-events.ts";
import {
  sparkExtensionContextProviderStrings,
  sparkExtensionToolCopy,
} from "@zendev-lab/spark-i18n/extension";
import { sessionModelName } from "./session-model.ts";
import { withSparkToolOperationalNotes } from "./spark-tool-operational-notes.ts";
import { SparkWorkflowRunManagerController } from "./spark-workflow-run-manager.ts";
import { registerSparkModeCycleShortcut } from "./spark-mode-shortcut.ts";
import { registerSparkPhaseTool } from "./mode/index.ts";
import { sparkSessionKey } from "./session-state.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";
import { SparkWidgetController } from "./spark-widget-controller.ts";
import { SparkRoleRunTuiController } from "./spark-role-run-tui-controller.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import {
  SparkRolesReviewerRunner,
  capReviewerThinkingLevel,
  type ReviewerRunner,
} from "./reviewer-runner.ts";
import { registerSparkReflectionCommands } from "./reflection-in-session-scheduler.ts";
import { sparkActiveLensPhase } from "./spark-drive-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import {
  sparkDaemonDriverControl,
  type SparkDaemonDriverControl,
} from "./spark-daemon-driver-client.ts";

interface SparkProductFacadeApi extends SparkCommandApi {
  /** Host/test override; production defaults to the daemon local RPC client. */
  driverControl?: SparkDaemonDriverControl;
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
  getThinkingLevel?(): unknown;
  getPiCommand?(): string | undefined;
  registerMessageRenderer?(
    customType: string,
    renderer: (
      message: { content: unknown; details?: unknown },
      options: { expanded?: boolean },
      theme: { fg?(color: string, text: string): string; bold?(text: string): string },
    ) => { render(width: number): string[]; invalidate(): void },
  ): void;
}

export default function sparkExtension(pi: SparkProductFacadeApi) {
  const driverControl = pi.driverControl ?? sparkDaemonDriverControl;
  const widgetController = new SparkWidgetController();
  const roleRunTuiController = new SparkRoleRunTuiController(pi);

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    await widgetController.refresh(cwd, ctx);
    await roleRunTuiController.refresh(cwd, ctx);
  }

  const workflowRunManagerController = new SparkWorkflowRunManagerController({
    refreshSparkWidget,
    piCommand: () => pi.getPiCommand?.(),
    driverControl,
  });

  registerSparkAskAutoAnswerProvider("spark-goal-reviewer", async (request, rawCtx) => {
    const askCtx = rawCtx as SparkToolContext;
    if (!askCtx.cwd) return undefined;
    if (sparkActiveLensPhase(askCtx.sparkActiveLens) === "implement")
      return {
        blocked: true,
        reason: "reviewer ask auto-answer is disabled in /implement mode",
      };
    const goal = await loadSessionGoal(askCtx.cwd, askCtx);
    if (goal?.status !== "active") return undefined;
    return answerAskWithReviewer(request, askCtx, askCtx);
  });

  const eventHandlers = registerSparkExtensionEvents(pi, {
    refreshSparkWidget,
    ensureWorkflowRunManager: (cwd, ctx) => workflowRunManagerController.ensure(cwd, ctx),
    createAskAutoAnswerResolver: (ctx) => (request, askCtx) =>
      answerAskWithReviewer(request, askCtx, ctx),
  });

  const registeredSparkTools = new Map<string, SparkRegisteredToolConfig>();
  const registerSparkTool = (config: SparkRegisteredToolConfig): void => {
    registeredSparkTools.set(config.name, config);
    const copy = sparkExtensionToolCopy(config.name, config);
    pi.registerTool?.({
      ...config,
      ...copy,
      description: withSparkToolOperationalNotes(config.name, copy.description),
      renderCall: (args, theme, context) => renderSparkToolCall(config.name, args, theme, context),
    });
  };
  const registerSparkImplementationTool = (config: SparkRegisteredToolConfig): void => {
    registeredSparkTools.set(config.name, config);
    pi.registerInternalTool?.({ ...config, ...sparkExtensionToolCopy(config.name, config) });
  };

  async function createReviewerRunner(cwd: string, ctx: SparkToolContext): Promise<ReviewerRunner> {
    const provided = await pi.createReviewerRunner?.(cwd, ctx);
    if (provided) return provided;
    return new SparkRolesReviewerRunner({
      registry: await createSparkRoleRegistry(cwd),
      cwd,
      sessionModel: sessionModelName(ctx.model),
      reviewerThinkingLevel: capReviewerThinkingLevel(pi.getThinkingLevel?.()),
      nativeExecutor: ctx.runRole,
    });
  }

  async function answerAskWithReviewer(
    request: unknown,
    askCtx: SparkToolContext,
    fallbackCtx: SparkToolContext,
  ) {
    const cwd = askCtx.cwd || fallbackCtx.cwd;
    const reviewer = await createReviewerRunner(cwd, askCtx);
    if (!reviewer.answerAsk)
      return {
        blocked: true,
        reason: "reviewer runner does not support ask auto-answer",
      };
    return reviewer.answerAsk({
      cwd,
      request,
      sessionKey: sparkSessionKey(askCtx),
      forkFromSession: askCtx.sessionManager?.getSessionFile?.(),
    });
  }

  registerSparkCommands(pi, {
    queueSparkAgentInstruction: (ctx, instruction, options) =>
      eventHandlers.queueSparkAgentInstruction(ctx, instruction, options),
    refreshSparkWidget,
    ensureWorkflowRunManager: (cwd, ctx) => workflowRunManagerController.ensure(cwd, ctx),
    driverControl,
    createReviewerRunner,
  });
  registerSparkReflectionCommands(pi);

  registerSparkModeCycleShortcut(pi, { refreshSparkWidget });

  registerSparkStatusTool(registerSparkImplementationTool, { ensureSparkStateForActiveWorkspace });

  registerSparkStateTool(registerSparkImplementationTool, { ensureSparkStateForActiveWorkspace });

  registerSparkTodoTools(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkFinishTaskTool(registerSparkImplementationTool, {
    refreshSparkWidget,
    createReviewerRunner,
  });

  registerSparkProjectTools(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkClaimTaskTool(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkRecoverTaskClaimTool(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkPlanTasksTool(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkGoalTool(registerSparkTool, {
    driverControl,
    refreshSparkWidget,
    syncAskAutoAnswerPolicy: (ctx) => eventHandlers.syncGoalAskAutoAnswerPolicy(ctx),
    createReviewerRunner,
  });

  registerSparkLoopTool(registerSparkTool, { driverControl, refreshSparkWidget });

  registerSparkReproTool(registerSparkTool, { driverControl, refreshSparkWidget });

  registerSparkDriveTool(registerSparkTool, {
    driverControl,
    ensureSparkStateForActiveWorkspace,
    refreshSparkWidget,
  });
  registerSparkDriverTool(registerSparkTool);
  registerSparkWorkflowDriverTool(registerSparkImplementationTool, {
    workflowRunManager: workflowRunManagerController,
  });

  registerSparkPhaseTool(registerSparkTool);

  registerSparkRunReadyTasksTool(registerSparkImplementationTool, {
    ensureWorkflowRunManager: (cwd, ctx) => workflowRunManagerController.ensure(cwd, ctx),
    piCommand: () => pi.getPiCommand?.(),
  });

  registerSparkWorkflowRunsTool(registerSparkImplementationTool, { refreshSparkWidget });

  registerSparkWorkflowRunTool(registerSparkTool, { refreshSparkWidget });

  registerSparkAskTools(registerSparkImplementationTool);

  if (pi.registerTool) {
    const genericToolRegistrar = {
      registerTool: (config: unknown) => pi.registerTool?.(config as SparkRegisteredToolConfig),
    };
    registerSparkTaskTool(genericToolRegistrar, {
      handlers: createSparkTaskHandlers((name) => registeredSparkTools.get(name)),
    });
    registerSparkTodoTool(genericToolRegistrar, {
      handler: createSparkTodoHandler((name) => registeredSparkTools.get(name)),
    });
    registerSparkContextTool(genericToolRegistrar, {
      providers: [
        {
          id: "spark.active",
          label: sparkExtensionContextProviderStrings.label,
          description: sparkExtensionContextProviderStrings.description,
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

function createSparkTaskHandlers(resolveTool: SparkImplementationResolver): SparkTaskToolHandlers {
  const direct = (toolName: string) =>
    (({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, toolName, {
        toolCallId,
        params: stripTaskAction(params),
        signal,
        onUpdate,
        ctx,
      })) satisfies NonNullable<SparkTaskToolHandlers["project_list"]>;

  const scopedStatus = (scope: "task" | "project" | "workspace") =>
    (({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "impl_status", {
        toolCallId,
        params: { ...stripTaskAction(params), scope },
        signal,
        onUpdate,
        ctx,
      })) satisfies NonNullable<SparkTaskToolHandlers["task_status"]>;

  const projectMutation = (intent: "rename" | "metadata_update") =>
    (({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "impl_project_mutation", {
        toolCallId,
        params: { ...stripTaskAction(params), intent },
        signal,
        onUpdate,
        ctx,
      })) satisfies NonNullable<SparkTaskToolHandlers["project_rename"]>;

  return {
    task_status: scopedStatus("task"),
    project_status: scopedStatus("project"),
    workspace_status: scopedStatus("workspace"),
    project_list: direct("impl_list_projects"),
    project_use: direct("impl_use_project"),
    project_rename: projectMutation("rename"),
    project_metadata_update: projectMutation("metadata_update"),
    claim: direct("impl_claim_task"),
    plan: direct("impl_plan_tasks"),
    finish: direct("impl_finish_task"),
    recover: direct("impl_recover_task_claim"),
    plan_update: ({ toolCallId, params, signal, onUpdate, ctx }) => {
      normalizeTaskPlanUpdateScope(params.scope);
      return executeSparkImplementationTool(resolveTool, "impl_update_task_plan_items", {
        toolCallId,
        params: stripTaskActionAndScope(params),
        signal,
        onUpdate,
        ctx,
      });
    },
    run_status: ({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "impl_workflow_runs", {
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
    assign: direct("impl_run_ready_tasks"),
    cache_cleanup: ({ toolCallId, params, signal, onUpdate, ctx }) =>
      executeSparkImplementationTool(resolveTool, "impl_state", {
        toolCallId,
        params: { ...stripTaskAction(params), action: "cache_cleanup" },
        signal,
        onUpdate,
        ctx,
      }),
  };
}

function createSparkTodoHandler(resolveTool: SparkImplementationResolver): SparkTaskActionHandler {
  return ({ toolCallId, params, signal, onUpdate, ctx }) =>
    executeSparkImplementationTool(resolveTool, "impl_todo", {
      toolCallId,
      params: removeUndefined(params),
      signal,
      onUpdate,
      ctx,
    });
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

function normalizeTaskPlanUpdateScope(value: unknown): "task" {
  if (value === undefined || value === null || value === "task") return "task";
  if (value === "session")
    throw new Error(
      'scope: "session" is not valid for task_write({ action: "plan_update" }); it updates task plan items only. Use the session-bound todo tool for standalone session TODOs.',
    );
  throw new Error('task.scope must be "task" for plan_update');
}

function normalizeTaskRunStatusAction(
  value: unknown,
):
  | "status"
  | "list"
  | "inspect"
  | "reconcile"
  | "kill"
  | "reply"
  | "steer"
  | "ack"
  | "kill_active" {
  if (value === undefined || value === null) return "status";
  if (
    value === "status" ||
    value === "list" ||
    value === "inspect" ||
    value === "reconcile" ||
    value === "kill" ||
    value === "reply" ||
    value === "steer" ||
    value === "ack" ||
    value === "kill_active"
  ) {
    return value;
  }
  throw new Error(
    "task.runAction must be status, list, inspect, reconcile, kill, reply, steer, ack, or kill_active for run_status",
  );
}

function stripTaskAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return removeUndefined(rest);
}

function stripTaskActionAndScope(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, scope: _scope, ...rest } = params;
  return removeUndefined(rest);
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
