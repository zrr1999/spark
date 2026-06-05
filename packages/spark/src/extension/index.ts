import { registerPiContextTool } from "pi-context/extension";
import {
  createPiLearningSparkCompatHandlers,
  registerPiLearningTool,
} from "pi-learnings/extension";
import { createPiTaskSparkCompatHandlers, registerPiTaskTool } from "pi-tasks/extension";
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
import { registerSparkPredefinedRoles } from "./spark-role-registry.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";
import { SparkWidgetController } from "./spark-widget-controller.ts";

interface SparkExtensionAPI extends SparkCommandApi {
  registerTool?(config: SparkRegisteredToolConfig): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  registerSparkPredefinedRoles();

  const widgetController = new SparkWidgetController();

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    await widgetController.refresh(cwd, ctx);
  }

  const eventHandlers = registerSparkExtensionEvents(pi, { refreshSparkWidget });

  const dagManagerController = new SparkDagManagerController({
    refreshSparkWidget,
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

  registerSparkCommands(pi, {
    queueSparkAgentInstruction: (ctx, instruction) =>
      eventHandlers.queueSparkAgentInstruction(ctx, instruction),
    refreshSparkWidget,
    ensureDagManager: (cwd, ctx) => dagManagerController.ensure(cwd, ctx),
  });

  registerSparkStatusTool(registerSparkTool, { ensureSparkStateForActiveWorkspace });

  registerSparkStateTool(registerSparkTool, { ensureSparkStateForActiveWorkspace });

  registerSparkTodoTools(registerSparkTool, { refreshSparkWidget });

  registerSparkFinishTaskTool(registerSparkTool, { refreshSparkWidget });

  registerSparkProjectTools(registerSparkTool, { refreshSparkWidget });

  registerSparkClaimTaskTool(registerSparkTool, { refreshSparkWidget });

  registerSparkPlanTasksTool(registerSparkTool, { refreshSparkWidget });

  registerSparkRunReadyTasksTool(registerSparkTool, {
    ensureDagManager: (cwd, ctx) => dagManagerController.ensure(cwd, ctx),
  });

  registerSparkBackgroundRunsTool(registerSparkTool);

  registerSparkDagManagerTool(registerSparkTool);

  registerSparkAskTools(registerSparkTool);

  registerSparkLearningTools(registerSparkTool);

  if (pi.registerTool) {
    const genericToolRegistrar = {
      registerTool: (config: unknown) => pi.registerTool?.(config as SparkRegisteredToolConfig),
    };
    registerPiTaskTool(genericToolRegistrar, {
      handlers: createPiTaskSparkCompatHandlers((name) => registeredSparkTools.get(name)),
    });
    registerPiLearningTool(genericToolRegistrar, {
      handlers: createPiLearningSparkCompatHandlers((name) => registeredSparkTools.get(name)),
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
