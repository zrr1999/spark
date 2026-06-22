import { Type } from "typebox";
import type { Task } from "@zendev-lab/pi-extension-api";
import { defaultTaskGraphStore } from "@zendev-lab/pi-tasks";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import { currentSparkProject, sparkSessionKey } from "./session-state.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { taskClaimSummary } from "./task-display.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
import {
  evaluateSparkTaskClaimRecovery,
  recordSparkTaskClaimRecoveryArtifact,
  type SparkTaskClaimRecoveryDecision,
} from "./task-claim-recovery.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkRecoverTaskClaimToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

interface NormalizedSparkRecoverTaskClaimInput {
  projectSelector?: string;
  taskSelector?: string;
}

export function registerSparkRecoverTaskClaimTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkRecoverTaskClaimToolDependencies,
): void {
  registerSparkTool({
    name: "impl_recover_task_claim",
    label: "Spark Recover Task Claim",
    description:
      'Implementation for task_write({ action: "recover" }): safely release a stale other-session Spark task claim after evidence checks, leaving the task pending/ready and unclaimed. It never marks the task done and refuses active/recent owners or active background work.',
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Optional project selector/ref/title." })),
      projectRef: Type.Optional(
        Type.String({ description: "Optional project ref/selector; alias for project." }),
      ),
      task: Type.Optional(Type.String({ description: "Task selector/ref/name/title." })),
      taskRef: Type.Optional(
        Type.String({ description: "Task ref/name/title selector; alias for task." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const input = normalizeSparkRecoverTaskClaimInput(params);
      const store = defaultTaskGraphStore(cwd);
      const workflowRunStatus = await defaultSparkWorkflowRunStore(cwd).status();
      const activeRoleRunProcesses = activeSparkRoleRunProcessesForCwd(cwd);
      const sessionKey = sparkSessionKey(ctx);
      const recovered = await store.update(
        async (graph) => {
          const project = input.projectSelector
            ? resolveRecoverProject(graph.projects(), input.projectSelector)
            : await currentSparkProject(cwd, ctx, graph);
          if (!project) return { error: "no_project" as const };
          const task = resolveRecoverTask(graph.tasks(project.ref), input.taskSelector);
          if (!task) return { error: "no_task" as const };
          const decision = await evaluateSparkTaskClaimRecovery({
            cwd,
            task,
            projectRef: project.ref,
            currentSessionKey: sessionKey,
            workflowRunStatus,
            activeRoleRunProcesses,
          });
          if (!decision.recoverable) return { error: "not_recoverable" as const, task, decision };
          const artifact = await recordSparkTaskClaimRecoveryArtifact({
            cwd,
            task,
            projectRef: project.ref,
            decision,
            recoveredBy: sessionKey,
          });
          graph.releaseTaskClaim(task.ref);
          return { task: graph.getTask(task.ref), decision, artifactRef: artifact.ref };
        },
        { createIfMissing: false },
      );
      if (!recovered.graph || recovered.result.error === "no_project")
        return {
          content: [{ type: "text", text: "No current Spark project selected for recovery." }],
          details: { found: false, error: "no_project" },
        };
      if (recovered.result.error === "no_task")
        return {
          content: [{ type: "text", text: "No matching task found for claim recovery." }],
          details: { found: true, error: "no_task" },
        };
      if (recovered.result.error === "not_recoverable") {
        return renderRecoveryRefusal(recovered.result.task, recovered.result.decision);
      }
      await deps.refreshSparkWidget(cwd, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Recovered Spark task claim: @${recovered.result.task.name}: ${recovered.result.task.title} (${recovered.result.task.ref})\n` +
              `Reason: ${recovered.result.decision.reason}\n` +
              `Recovery evidence: ${recovered.result.artifactRef}\n` +
              "Task is now unclaimed and can re-enter the ready frontier; it was not marked done.",
          },
        ],
        details: {
          task: recovered.result.task as unknown as Record<string, unknown>,
          claimRecovery: recovered.result.decision,
          recoveredClaimArtifactRef: recovered.result.artifactRef,
        },
      };
    },
  });
}

function normalizeSparkRecoverTaskClaimInput(
  params: Record<string, unknown>,
): NormalizedSparkRecoverTaskClaimInput {
  return {
    projectSelector: normalizeOptionalToolString(params.projectRef ?? params.project, "project"),
    taskSelector: normalizeOptionalToolString(params.taskRef ?? params.task, "task"),
  };
}

function resolveRecoverProject(
  projects: ReturnType<import("@zendev-lab/pi-tasks").TaskGraph["projects"]>,
  selector: string,
) {
  return projects.find((project) => project.ref === selector || project.title === selector);
}

function resolveRecoverTask(
  tasks: readonly Task[],
  selector: string | undefined,
): Task | undefined {
  if (!selector) return tasks.find((task) => task.claim);
  const needle = selector.trim();
  const normalized = needle.startsWith("@") ? needle.slice(1) : needle;
  return tasks.find(
    (task) =>
      task.ref === needle ||
      task.ref === normalized ||
      task.name === normalized ||
      task.title === needle ||
      task.title === normalized,
  );
}

function renderRecoveryRefusal(task: Task, decision: SparkTaskClaimRecoveryDecision) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Cannot recover task claim for @${task.name}: ${task.title} (${task.ref}).\n` +
          `Claim: ${taskClaimSummary(task)}\n` +
          `Recovery refused: ${decision.reason}. ${decision.guidance}`,
      },
    ],
    details: {
      found: true,
      error: "not_recoverable",
      task: compactTaskDetail(task),
      claimRecovery: decision,
    },
  };
}
