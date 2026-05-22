import { type ArtifactRef, type Task, type TaskPlan, type TaskPlanIssue } from "spark-core";
import {
  runSparkAskTool,
  type SparkAskToolOptionParams,
  type SparkAskToolParams,
  type SparkAskToolUi,
} from "spark-ask";
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
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "successCriteria"),
      },
      {
        id: "evidenceRequired",
        prompt: "What evidence should be produced before this task is considered complete?",
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "evidenceRequired"),
      },
      {
        id: "openQuestions",
        prompt: "Which open questions remain, if any? Choose resolved if none remain.",
        type: "single",
        required: false,
        options: taskPlanSuggestionOptions(task, "openQuestions"),
      },
    ],
  };
}

type TaskPlanSuggestionKind = "successCriteria" | "evidenceRequired" | "openQuestions";

function taskPlanSuggestionOptions(
  task: Task,
  kind: TaskPlanSuggestionKind,
): SparkAskToolOptionParams[] {
  const text = `${task.title}\n${task.description}\n${task.plan?.objective ?? ""}`;
  const lower = text.toLowerCase();
  const hasRuntime =
    /runtime|heartbeat|liveness|health|alive|connection|websocket|ws|sse|event/.test(lower);
  const hasBrowser = /browser|ui|frontend|client|page|sse|eventsource/.test(lower);
  const hasApi = /api|endpoint|server|http|route/.test(lower);
  const hasDocs = /doc|readme|skill|guide/.test(lower);
  const hasTest = /test|coverage|regression|verify/.test(lower);

  if (kind === "successCriteria") {
    return compactOptions([
      hasRuntime
        ? option(
            "runtime-liveness-visible",
            "Runtime liveness visible",
            "Runtime heartbeat or liveness state is observable and distinguishes live, stale, and disconnected states.",
          )
        : undefined,
      hasBrowser
        ? option(
            "browser-updates-live",
            "Browser updates live",
            "Browser-facing UI or client state receives live updates without requiring a manual refresh.",
          )
        : undefined,
      hasApi
        ? option(
            "api-contract-works",
            "API contract works",
            "The public API or protocol returns the expected shape for success and failure paths.",
          )
        : undefined,
      option(
        "implementation-complete",
        "Implementation complete",
        "The requested behavior is implemented end-to-end in the relevant production code path.",
      ),
      option(
        "tests-pass",
        "Tests pass",
        "Focused automated tests cover the new behavior and pass together with the existing relevant suite.",
      ),
      hasDocs
        ? option(
            "docs-updated",
            "Docs updated",
            "User-facing documentation or guidance reflects the changed behavior where applicable.",
          )
        : undefined,
    ]);
  }

  if (kind === "evidenceRequired") {
    return compactOptions([
      option(
        "tests-output",
        "Test output",
        "Include focused test command output showing the behavior is covered and passing.",
      ),
      option(
        "code-refs",
        "Code refs",
        "List the changed files and key functions or modules that implement the behavior.",
      ),
      hasRuntime || hasBrowser
        ? option(
            "manual-smoke",
            "Manual smoke result",
            "Record a manual or simulated runtime/browser smoke result for the live update path.",
          )
        : undefined,
      hasApi
        ? option(
            "protocol-sample",
            "Protocol sample",
            "Attach an example response, event, or protocol payload proving the contract works.",
          )
        : undefined,
      hasTest
        ? option(
            "regression-proof",
            "Regression proof",
            "Name the regression test or fixture that would fail without this change.",
          )
        : undefined,
    ]);
  }

  return compactOptions([
    option(
      "resolved-no-open-questions",
      "Resolved / none",
      "There are no remaining open questions; the task can proceed with the selected plan details.",
    ),
    option(
      "needs-scope-choice",
      "Scope choice needed",
      "The intended scope or boundary is still unclear and must be decided before execution.",
    ),
    option(
      "needs-acceptance-choice",
      "Acceptance unclear",
      "The exact acceptance criteria or evidence requirement still needs a decision.",
    ),
  ]);
}

function option(id: string, label: string, description: string): SparkAskToolOptionParams {
  return { id, label, description };
}

function compactOptions(
  options: Array<SparkAskToolOptionParams | undefined>,
): SparkAskToolOptionParams[] {
  return options.filter((entry): entry is SparkAskToolOptionParams => Boolean(entry)).slice(0, 6);
}

function appendTaskPlanAskRef(plan: TaskPlan, artifactRef: ArtifactRef | undefined): TaskPlan {
  if (!artifactRef || plan.askRefs.includes(artifactRef)) return plan;
  return { ...plan, askRefs: [...plan.askRefs, artifactRef] };
}
