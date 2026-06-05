import { Type } from "typebox";
import { defaultLearningStore, type LearningLocation, type LearningRecord } from "pi-learnings";
import type { Artifact } from "pi-artifacts";
import {
  DependencyError,
  type Task,
  type TaskCompletionReadiness,
  type ProjectRef,
} from "pi-extension-api";
import { defaultTaskGraphStore, taskCompletionReadiness } from "pi-tasks";
import {
  currentSparkProject,
  loadSparkExecutionMode,
  sparkSessionKey,
  sparkTodoStore,
} from "./session-state.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
import { compactLearningDetail } from "./learning-tools.ts";
import { truncateInline } from "./tool-rendering.ts";
import {
  renderSparkGoalContinuationPrompt,
  sparkGoalObjectiveForNextTask,
} from "./spark-goal-continuation.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

interface SparkFinishTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

interface NormalizedSparkFinishTaskInput {
  task?: string;
  status: "done" | "failed" | "cancelled";
  summary?: string;
}

export function normalizeSparkFinishTaskInput(
  params: Record<string, unknown>,
): NormalizedSparkFinishTaskInput {
  return {
    task: normalizeOptionalToolString(params.task, "task"),
    status: normalizeSparkFinishStatus(params.status),
    summary: normalizeOptionalToolString(params.summary, "summary"),
  };
}

export function registerSparkFinishTaskTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkFinishTaskToolDependencies,
): void {
  registerSparkTool({
    name: "spark_finish_task",
    label: "Spark Finish Task",
    description:
      'Compatibility surface for task({ action: "finish" }): finish this session\'s claimed Spark task as done, failed, or cancelled. Defaults to the current claimed task and status=done.',
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, @name/name, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      status: Type.Optional(
        Type.String({ description: "done | failed | cancelled. Default: done." }),
      ),
      summary: Type.Optional(Type.String({ description: "Short completion/failure summary." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const input = normalizeSparkFinishTaskInput(params);
      const executionMode = await loadSparkExecutionMode(cwd, ctx);
      const store = defaultTaskGraphStore(cwd);
      let updated: Awaited<ReturnType<typeof store.update>>;
      try {
        updated = await store.update(
          async (graph) => {
            await sparkTodoStore(cwd, ctx).hydrate(graph);
            const project = await currentSparkProject(cwd, ctx, graph);
            if (!project) return { error: "no_project" as const };
            const sessionKey = sparkSessionKey(ctx);
            const task = resolveSessionClaimedTask(graph, project.ref, sessionKey, input.task);
            if (!task) return { error: "no_matching_claimed_task" as const };
            const finished = graph.setTaskStatus(task.ref, input.status);
            const completionReadiness =
              input.status === "done" ? taskCompletionReadiness(finished) : undefined;
            const nextReady =
              input.status === "done" ? graph.readyTasks(project.ref)[0] : undefined;
            await sparkTodoStore(cwd, ctx).save(graph);
            return {
              task: finished,
              completionReadiness,
              projectRef: project.ref,
              nextReady,
            };
          },
          { createIfMissing: false },
        );
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Cannot finish Spark task: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const finishResult = updated.result as
        | { error: "no_project" | "no_matching_claimed_task" }
        | {
            task: Task;
            completionReadiness?: TaskCompletionReadiness;
            projectRef: ProjectRef;
            nextReady?: Task;
          };
      if (!updated.graph || ("error" in finishResult && finishResult.error === "no_project"))
        return {
          content: [{ type: "text", text: "No Spark project found." }],
          details: { found: false },
        };
      if ("error" in finishResult && finishResult.error === "no_matching_claimed_task")
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      const finishedResult = finishResult as {
        task: Task;
        completionReadiness?: TaskCompletionReadiness;
        projectRef: ProjectRef;
        nextReady?: Task;
      };
      await deps.refreshSparkWidget(cwd, ctx);
      const learningCandidate =
        input.status === "done" && input.summary
          ? await recordTaskLearningCandidate(cwd, finishedResult.task, input.summary)
          : undefined;
      const summarySuffix = input.summary ? ` — ${truncateInline(input.summary, 160)}` : "";
      const completionIssueSuffix =
        finishedResult.completionReadiness && !finishedResult.completionReadiness.ready
          ? `\nCompletion evidence warning: ${finishedResult.completionReadiness.issues
              .map((issue) => issue.message)
              .join("; ")}`
          : "";
      const candidateSuffix = learningCandidate
        ? `\nLearning candidate: ${learningCandidate.artifact.ref}`
        : "";
      const executionSuffix = renderExecutionModeFinishSuffix(
        executionMode,
        finishedResult.projectRef,
        finishedResult.nextReady,
        input.status,
      );
      return {
        content: [
          {
            type: "text",
            text: `Finished Spark task: [${finishedResult.task.status}] @${finishedResult.task.name}: ${finishedResult.task.title}${summarySuffix}${completionIssueSuffix}${candidateSuffix}${executionSuffix}`,
          },
        ],
        details: {
          task: compactTaskDetail(finishedResult.task),
          completionReadiness: finishedResult.completionReadiness,
          nextReadyTask: finishedResult.nextReady
            ? compactTaskDetail(finishedResult.nextReady)
            : undefined,
          learningCandidate: learningCandidate
            ? compactLearningDetail(learningCandidate.artifact, learningCandidate.location)
            : undefined,
        },
      };
    },
  });
}

function renderExecutionModeFinishSuffix(
  executionMode: Awaited<ReturnType<typeof loadSparkExecutionMode>>,
  projectRef: ProjectRef,
  nextReady: Task | undefined,
  status: "done" | "failed" | "cancelled",
): string {
  if (executionMode?.projectRef !== projectRef || status !== "done") return "";
  if (executionMode.strategy === "goal") {
    const continuation = renderSparkGoalContinuationPrompt(
      sparkGoalObjectiveForNextTask({
        focus: executionMode.focus,
        nextTaskName: nextReady?.name,
        nextTaskTitle: nextReady?.title,
      }),
    );
    const modeLabel = "Goal execution mode";
    return nextReady
      ? "\n" +
          modeLabel +
          " continuing. Next ready task: @" +
          nextReady.name +
          ": " +
          nextReady.title +
          '. Continue now using the Spark goal continuation below: claim this task with task({ action: "claim" }), execute it, verify evidence, then call task({ action: "finish" }) again. Do not stop after this task unless blocked, no ready task remains, a user decision is required, validation fails, or the user interrupts.\n\n' +
          continuation
      : "\n" +
          modeLabel +
          " complete. No ready task remains; inspect blockers or finish the project.\n\n" +
          continuation;
  }
  return nextReady
    ? "\nExecution mode stopped after one task. Next ready task: @" +
        nextReady.name +
        ": " +
        nextReady.title +
        ". Run /execute to take one more step, or /goal to continue autonomously."
    : "\nExecution mode stopped after one task. No ready task remains; inspect blockers or finish the project.";
}
function normalizeSparkFinishStatus(value: unknown): "done" | "failed" | "cancelled" {
  if (value === undefined || value === null) return "done";
  if (value === "done" || value === "failed" || value === "cancelled") return value;
  throw new Error("status must be done, failed, or cancelled");
}

async function recordTaskLearningCandidate(
  cwd: string,
  task: Task,
  summary: string,
): Promise<{ artifact: Artifact<LearningRecord>; location: LearningLocation }> {
  const store = defaultLearningStore(cwd);
  const artifact = await store.record({
    title: `Candidate from @${task.name}: ${task.title}`,
    statement: summary,
    category: "workflow",
    status: "candidate",
    applicability: "Review this task-derived candidate before applying it to future Spark work.",
    evidenceRefs: [task.ref],
    tags: ["task-finish", task.kind],
    confidence: 0.4,
    sourceContent: [
      `Task: @${task.name}: ${task.title} (${task.ref})`,
      `Kind: ${task.kind}`,
      "",
      task.description,
      "",
      `Completion summary: ${summary}`,
    ].join("\n"),
  });
  return { artifact, location: store.location };
}
