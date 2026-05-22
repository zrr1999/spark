import { type ArtifactRef, type Task, type TaskPlan, type TaskPlanIssue } from "spark-core";
import { runSparkAskTool, type SparkAskToolParams, type SparkAskToolUi } from "spark-ask";
import { taskPlanReadiness } from "spark-tasks";

export interface TaskPlanClarificationResult {
  asked: boolean;
  blocked: boolean;
  artifactRef?: ArtifactRef;
  summary?: string;
  plan: TaskPlan;
  issues: TaskPlanIssue[];
}

export async function clarifyTaskPlanIfNeeded(input: {
  cwd: string;
  task: Task;
  ui?: SparkAskToolUi;
}): Promise<TaskPlanClarificationResult> {
  const readiness = taskPlanReadiness(input.task);
  if (readiness.ready) {
    return {
      asked: false,
      blocked: false,
      plan: input.task.plan as TaskPlan,
      issues: [],
    };
  }

  const response = await runSparkAskTool(taskPlanClarificationAsk(input.task, readiness.issues), {
    cwd: input.cwd,
    ui: input.ui,
  });
  const details = response.details as {
    artifactRef?: ArtifactRef;
    blocked?: boolean;
    summary?: string;
  };
  return {
    asked: true,
    blocked: details.blocked === true,
    artifactRef: details.artifactRef,
    summary: details.summary,
    plan: appendTaskPlanAskRef(input.task.plan as TaskPlan, details.artifactRef),
    issues: readiness.issues,
  };
}

function taskPlanClarificationAsk(task: Task, issues: TaskPlanIssue[]): SparkAskToolParams {
  return {
    mode: "clarification",
    flow: "task-plan-refinement",
    title: `Refine task plan: ${task.title}`,
    context: [
      `Task: @${task.name} ${task.title}`,
      `Description: ${task.description}`,
      `Current objective: ${task.plan?.objective ?? ""}`,
      `Plan issues: ${issues.map((issue) => issue.message).join("; ")}`,
    ].join("\n"),
    questions: [
      {
        id: "successCriteria",
        prompt: "What observable success criteria should this task satisfy?",
        type: "freeform",
        required: false,
      },
      {
        id: "evidenceRequired",
        prompt: "What evidence should be produced before this task is considered complete?",
        type: "freeform",
        required: false,
      },
      {
        id: "openQuestions",
        prompt: "Which open questions remain, if any? Leave blank if resolved.",
        type: "freeform",
        required: false,
      },
    ],
  };
}

function appendTaskPlanAskRef(plan: TaskPlan, artifactRef: ArtifactRef | undefined): TaskPlan {
  if (!artifactRef || plan.askRefs.includes(artifactRef)) return plan;
  return { ...plan, askRefs: [...plan.askRefs, artifactRef] };
}
