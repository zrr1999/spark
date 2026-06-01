import { registerPiCueTools, type PiCueExtensionApi, type PiCueToolConfig } from "pi-cue";
import { renderSparkToolCall } from "./tool-rendering.ts";
import { registerSparkArtifactTools } from "./artifact-tool-registration.ts";
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
import { ensureSparkStateForActiveWorkspace } from "./spark-active-injection.ts";
import { registerSparkExtensionEvents } from "./spark-extension-events.ts";
import { withSparkToolOperationalNotes } from "./spark-tool-operational-notes.ts";
import { SparkDagManagerController } from "./spark-dag-manager.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";
import { SparkWidgetController } from "./spark-widget-controller.ts";

interface SparkExtensionAPI extends SparkCommandApi {
  registerTool?(config: SparkRegisteredToolConfig): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  getAllTools?: PiCueExtensionApi["getAllTools"];
  setActiveTools?: PiCueExtensionApi["setActiveTools"];
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  registerEmbeddedPiCueTools(pi);

  const widgetController = new SparkWidgetController();

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    await widgetController.refresh(cwd, ctx);
  }

  const eventHandlers = registerSparkExtensionEvents(pi, { refreshSparkWidget });

  const dagManagerController = new SparkDagManagerController({
    refreshSparkWidget,
  });

  const registerSparkTool = (config: SparkRegisteredToolConfig): void => {
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

  registerSparkArtifactTools(registerSparkTool);
}

function registerEmbeddedPiCueTools(pi: SparkExtensionAPI): void {
  if (!pi.registerTool) return;
  registerPiCueTools({
    registerTool: (config) => pi.registerTool?.(toSparkRegisteredToolConfig(config)),
    on: pi.on
      ? (event, handler) => {
          pi.on?.(event, (payload, ctx) => handler(payload, ctx));
        }
      : undefined,
    getAllTools: pi.getAllTools ? () => pi.getAllTools!() : undefined,
    setActiveTools: pi.setActiveTools ? (names) => pi.setActiveTools!(names) : undefined,
  });
}

function toSparkRegisteredToolConfig(config: PiCueToolConfig): SparkRegisteredToolConfig {
  const renderCall = config.renderCall;
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    renderCall: renderCall ? (args, theme, context) => renderCall(args, theme, context) : undefined,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      config.execute(toolCallId, params, signal, onUpdate, ctx),
  };
}
