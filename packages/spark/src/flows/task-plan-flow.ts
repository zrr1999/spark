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

export interface TaskPlanDecisionResult {
  asked: boolean;
  accepted: boolean;
  blocked: boolean;
  artifactRef?: ArtifactRef;
  summary?: string;
  plan: TaskPlan;
  issues: TaskPlanIssue[];
}

export async function decideTaskPlanBeforeCreate(input: {
  cwd: string;
  task: Task;
  ui?: SparkAskToolUi;
}): Promise<TaskPlanDecisionResult> {
  const readiness = taskPlanReadiness(input.task);
  const plan = input.task.plan as TaskPlan;
  if (readiness.ready) {
    return { asked: false, accepted: true, blocked: false, plan, issues: [] };
  }

  const response = await runSparkAskTool(taskPlanDecisionAsk(input.task, readiness.issues), {
    cwd: input.cwd,
    ui: input.ui,
  });
  const details = response.details as {
    artifactRef?: ArtifactRef;
    blocked?: boolean;
    summary?: string;
    answers?: Record<string, { values?: string[]; customText?: string }>;
  };
  const accepted = selected(details.answers, "decision", "create-with-this-plan");
  return {
    asked: true,
    accepted,
    blocked: details.blocked === true || !accepted,
    artifactRef: details.artifactRef,
    summary: details.summary,
    plan: appendTaskPlanAskRef(plan, details.artifactRef),
    issues: readiness.issues,
  };
}

function taskPlanDecisionAsk(task: Task, issues: TaskPlanIssue[]): SparkAskToolParams {
  return {
    mode: "decision",
    flow: "task-plan-decision",
    title: `Create task plan: ${task.title}`,
    context: [
      `Task: @${task.name} ${task.title}`,
      `Description: ${task.description}`,
      `Proposed objective: ${task.plan?.objective ?? ""}`,
      `Proposed steps: ${(task.plan?.steps ?? []).join("; ")}`,
      `Plan issues to resolve before creation: ${issues.map((issue) => issue.message).join("; ")}`,
    ].join("\n"),
    questions: [
      {
        id: "decision",
        prompt: "Create this task with the proposed plan, or revise before creating it?",
        type: "single",
        required: true,
        options: [
          option(
            "create-with-this-plan",
            "Create with plan",
            "Accept the proposed task plan and create/update the task with the selected plan context attached.",
          ),
          option(
            "revise-before-create",
            "Revise first",
            "Do not create the task yet; revise the plan details or scope before creating this task.",
          ),
        ],
      },
      {
        id: "successCriteria",
        prompt: "Suggested observable success criteria for this task plan:",
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "successCriteria"),
      },
      {
        id: "evidenceRequired",
        prompt: "Suggested evidence to require before this task is considered complete:",
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "evidenceRequired"),
      },
      {
        id: "openQuestions",
        prompt: "Do any open questions remain before task creation?",
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

function selected(
  answers: Record<string, { values?: string[]; customText?: string }> | undefined,
  questionId: string,
  value: string,
): boolean {
  return answers?.[questionId]?.values?.includes(value) === true;
}

function appendTaskPlanAskRef(plan: TaskPlan, artifactRef: ArtifactRef | undefined): TaskPlan {
  if (!artifactRef || plan.askRefs.includes(artifactRef)) return plan;
  return { ...plan, askRefs: [...plan.askRefs, artifactRef] };
}
