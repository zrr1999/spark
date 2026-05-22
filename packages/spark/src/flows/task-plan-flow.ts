import { type ArtifactRef, type Task, type TaskPlan, type TaskPlanIssue } from "spark-core";
import {
  runSparkAskTool,
  type SparkAskToolOptionParams,
  type SparkAskToolParams,
  type SparkAskToolUi,
} from "spark-ask";
import { taskPlanReadiness } from "spark-tasks";

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
  const copy = taskPlanAskCopy(task, issues);
  return {
    mode: "decision",
    flow: "task-plan-decision",
    title: `Create plan for ${copy.taskLabel}`,
    context: [
      `Task candidate: ${copy.taskLabel}`,
      `Requested work: ${copy.focus}`,
      `Proposed objective: ${copy.objective}`,
      `Proposed steps for ${copy.taskLabel}: ${copy.steps}`,
      `Readiness gaps for ${copy.taskLabel}: ${copy.issueSummary}`,
    ].join("\n"),
    questions: [
      {
        id: "decision",
        prompt: `Should Spark create ${copy.taskLabel} now while ${copy.issueSummary}, or stop so this plan can be revised first?`,
        type: "single",
        required: true,
        options: [
          option(
            "create-with-this-plan",
            `Create ${copy.taskHandle}`,
            `Create or update ${copy.taskLabel} now, keeping the proposed plan and recording this decision with the task plan.`,
          ),
          option(
            "revise-before-create",
            `Revise ${copy.taskHandle} first`,
            `Do not create ${copy.taskLabel} yet; revise the missing plan details for ${copy.issueSummary} before adding it to the thread.`,
          ),
        ],
      },
      {
        id: "successCriteria",
        prompt: `Which outcomes would make ${copy.taskLabel} objectively complete for “${copy.focus}”?`,
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "successCriteria", copy),
      },
      {
        id: "evidenceRequired",
        prompt: `What evidence should ${copy.taskLabel} require to prove “${copy.focus}” is done?`,
        type: "multi",
        required: false,
        options: taskPlanSuggestionOptions(task, "evidenceRequired", copy),
      },
      {
        id: "openQuestions",
        prompt: `Before creating ${copy.taskLabel}, what unresolved question still blocks “${copy.focus}”?`,
        type: "single",
        required: false,
        options: taskPlanSuggestionOptions(task, "openQuestions", copy),
      },
    ],
  };
}

type TaskPlanSuggestionKind = "successCriteria" | "evidenceRequired" | "openQuestions";

interface TaskPlanAskCopy {
  taskHandle: string;
  taskLabel: string;
  focus: string;
  objective: string;
  steps: string;
  issueSummary: string;
  hasRuntime: boolean;
  hasBrowser: boolean;
  hasApi: boolean;
  hasDocs: boolean;
  hasTest: boolean;
}

function taskPlanAskCopy(task: Task, issues: TaskPlanIssue[]): TaskPlanAskCopy {
  const focus = summarizeSentence(task.plan?.objective || task.description || task.title);
  const issueSummary = issues.length
    ? issues.map((issue) => issue.message.toLowerCase()).join(" and ")
    : "its plan is already structurally complete";
  const text = `${task.title}\n${task.description}\n${task.plan?.objective ?? ""}`;
  const lower = text.toLowerCase();
  return {
    taskHandle: `@${task.name}`,
    taskLabel: `@${task.name} “${task.title}”`,
    focus,
    objective: summarizeSentence(task.plan?.objective || task.description || task.title),
    steps: task.plan?.steps.length ? task.plan.steps.map(summarizeSentence).join("; ") : focus,
    issueSummary,
    hasRuntime: /runtime|heartbeat|liveness|health|alive|connection|websocket|ws|sse|event/.test(
      lower,
    ),
    hasBrowser: /browser|ui|frontend|client|page|sse|eventsource/.test(lower),
    hasApi: /api|endpoint|server|http|route/.test(lower),
    hasDocs: /doc|readme|skill|guide/.test(lower),
    hasTest: /test|coverage|regression|verify/.test(lower),
  };
}

function taskPlanSuggestionOptions(
  task: Task,
  kind: TaskPlanSuggestionKind,
  copy: TaskPlanAskCopy,
): SparkAskToolOptionParams[] {
  if (kind === "successCriteria") {
    return compactOptions([
      copy.hasRuntime
        ? option(
            "runtime-liveness-visible",
            `Expose ${copy.taskHandle} runtime health`,
            `${copy.taskLabel} is complete when ${copy.focus} makes runtime heartbeat or liveness state visibly distinguish live, stale, and disconnected cases.`,
          )
        : undefined,
      copy.hasBrowser
        ? option(
            "browser-updates-live",
            `Show ${copy.taskHandle} browser updates`,
            `${copy.taskLabel} is complete when the browser-facing surface for ${copy.focus} updates live without requiring a manual refresh.`,
          )
        : undefined,
      copy.hasApi
        ? option(
            "api-contract-works",
            `Validate ${copy.taskHandle} API contract`,
            `${copy.taskLabel} is complete when the API or protocol path for ${copy.focus} returns the expected success and failure shapes.`,
          )
        : undefined,
      option(
        "implementation-complete",
        `Finish ${copy.taskHandle} behavior`,
        `${copy.taskLabel} is complete when ${copy.focus} is implemented end-to-end in the relevant production code path.`,
      ),
      option(
        "tests-pass",
        `Test ${copy.taskHandle} behavior`,
        `${copy.taskLabel} is complete when focused automated tests cover ${copy.focus} and pass with the relevant existing suite.`,
      ),
      copy.hasDocs
        ? option(
            "docs-updated",
            `Document ${copy.taskHandle} behavior`,
            `${copy.taskLabel} is complete when user-facing documentation or guidance explains ${copy.focus} where applicable.`,
          )
        : undefined,
    ]);
  }

  if (kind === "evidenceRequired") {
    return compactOptions([
      option(
        "tests-output",
        `Attach ${copy.taskHandle} test output`,
        `Completion evidence for ${copy.taskLabel} must include focused test command output proving ${copy.focus}.`,
      ),
      option(
        "code-refs",
        `List ${copy.taskHandle} code refs`,
        `Completion evidence for ${copy.taskLabel} must name the changed files and key functions or modules responsible for ${copy.focus}.`,
      ),
      copy.hasRuntime || copy.hasBrowser
        ? option(
            "manual-smoke",
            `Smoke ${copy.taskHandle} live path`,
            `Completion evidence for ${copy.taskLabel} must record a manual or simulated runtime/browser smoke result for ${copy.focus}.`,
          )
        : undefined,
      copy.hasApi
        ? option(
            "protocol-sample",
            `Capture ${copy.taskHandle} protocol sample`,
            `Completion evidence for ${copy.taskLabel} must include an example response, event, or protocol payload for ${copy.focus}.`,
          )
        : undefined,
      copy.hasTest
        ? option(
            "regression-proof",
            `Name ${copy.taskHandle} regression proof`,
            `Completion evidence for ${copy.taskLabel} must identify the regression test or fixture that would fail without ${copy.focus}.`,
          )
        : undefined,
    ]);
  }

  return compactOptions([
    option(
      "resolved-no-open-questions",
      `No blocker for ${copy.taskHandle}`,
      `${copy.taskLabel} has no remaining open question blocking ${copy.focus}; it can be created with the selected plan details.`,
    ),
    option(
      "needs-scope-choice",
      `Decide ${copy.taskHandle} scope`,
      `${copy.taskLabel} still needs a scope or boundary decision before executing ${copy.focus}.`,
    ),
    option(
      "needs-acceptance-choice",
      `Decide ${copy.taskHandle} acceptance`,
      `${copy.taskLabel} still needs concrete acceptance criteria or evidence requirements for ${copy.focus}.`,
    ),
  ]);
}

function summarizeSentence(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}…`;
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
