import { listBuiltinWorkflows } from "@zendev-lab/spark-workflows";
import { parseWorkflowCommandArgs } from "./spark-command-parser-utils.ts";
import type { SparkWorkflowNavigatorAction } from "./spark-workflow-driver-entry.ts";
import type { SparkCommandApi, SparkCommandContext } from "./spark-command-types.ts";

export interface SparkWorkflowCommandHandlers {
  handleSparkWorkflowCommand: (
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    parsed: { selector?: string; focus: string; forceNavigator?: boolean },
  ) => Promise<void>;
  handleSparkUltracodeCommand: (
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    focus: string,
  ) => Promise<void>;
  handleSparkDynamicWorkflowDashboardCommand: (
    ctx: SparkCommandContext,
    args: string,
  ) => Promise<void>;
  handleSparkDynamicWorkflowActionCommand: (
    ctx: SparkCommandContext,
    action: SparkWorkflowNavigatorAction,
    args: string,
  ) => Promise<void>;
}

export function registerSparkWorkflowCommands(
  pi: SparkCommandApi,
  handlers: SparkWorkflowCommandHandlers,
): void {
  pi.registerCommand("workflow", {
    description:
      "Enter Spark workflow execution mode; accepts optional selector like builtin:foo, workspace:foo, or user:foo. Empty /workflow opens the blocking workflow navigator.",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "cockpit",
      resource: "workflow",
      verbs: ["start", "list"],
      canonicalCliTarget: "spark cockpit workflow list",
    },
    async handler(args, ctx) {
      const parsed = parseWorkflowCommandArgs(args);
      await handlers.handleSparkWorkflowCommand(pi, ctx, parsed);
    },
  });

  pi.registerCommand("workflows", {
    description:
      "Open the Spark workflow dashboard/navigator without requiring project state; shows dynamic runs and explicit controls.",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "cockpit",
      resource: "workflow",
      verbs: ["list"],
      canonicalCliTarget: "spark cockpit workflow list",
      deprecatedAliasFor: "/workflow list",
    },
    async handler(args, ctx) {
      await handlers.handleSparkWorkflowCommand(pi, ctx, {
        focus: args.trim(),
        forceNavigator: true,
      });
    },
  });

  pi.registerCommand("workflow-runs", {
    description: "Show the live dynamic workflow run dashboard. Usage: /workflow-runs [runRef].",
    argumentHint: "[runRef]",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "cockpit",
      resource: "workflow",
      verbs: ["list"],
      canonicalCliTarget: "spark cockpit workflow list",
      deprecatedAliasFor: "/workflow list",
    },
    async handler(args, ctx) {
      await handlers.handleSparkDynamicWorkflowDashboardCommand(ctx, args.trim());
    },
  });

  for (const action of ["inspect", "pause", "resume", "stop", "restart", "save", "ack"] as const) {
    pi.registerCommand(`workflow-${action}`, {
      description: `Dynamic workflow ${action}. Usage: /workflow-${action} <runRef>.`,
      argumentHint: "<runRef>",
      metadata: {
        source: "extension",
        extensionId: "spark-workflow",
        plane: "cockpit",
        resource: "workflow",
        verbs: [action],
        canonicalCliTarget: `spark cockpit workflow ${action} <run>`,
        deprecatedAliasFor: `/workflow ${action} <run>`,
      },
      async handler(args, ctx) {
        await handlers.handleSparkDynamicWorkflowActionCommand(ctx, action, args.trim());
      },
    });
  }

  pi.registerCommand("ultracode", {
    description:
      "Opt into high-effort dynamic workflow generation and execution through workflow_run.",
    async handler(args, ctx) {
      await handlers.handleSparkUltracodeCommand(pi, ctx, args.trim());
    },
  });

  for (const workflow of listBuiltinWorkflows()) {
    pi.registerCommand("workflow:" + workflow.id, {
      description: `Enter Spark builtin workflow ${workflow.id}.`,
      async handler(args, ctx) {
        await handlers.handleSparkWorkflowCommand(pi, ctx, {
          selector: "builtin:" + workflow.id,
          focus: args.trim(),
        });
      },
    });
  }
}
