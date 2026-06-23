import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleRegistry } from "@zendev-lab/pi-roles";
import {
  newRef,
  stableId,
  type ArtifactRef,
  type RoleRef,
  type RunRef,
  type TaskPlan,
  type TaskRef,
  type ProjectRef,
} from "@zendev-lab/pi-extension-api";
import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import { defaultLearningStore } from "@zendev-lab/pi-learnings";
import { defaultWorkflowRunStore } from "../packages/pi-workflows/src/index.ts";
import {
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
} from "@zendev-lab/spark-runtime";
import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  renderTaskPlanReadinessRules,
  TaskGraph,
  TaskGraphStore,
} from "@zendev-lab/pi-tasks";
import { registerPiArtifactTool } from "@zendev-lab/pi-artifacts/extension";
import piAskExtension from "../packages/pi-ask/src/extension.ts";
import sparkExtension from "../packages/spark-extension/src/extension/index.ts";
import { JsonStoreFormatError } from "../packages/spark-extension/src/extension/json-store.ts";
import type { SparkToolContext } from "../packages/spark-extension/src/extension/spark-tool-registration.ts";
import {
  loadCurrentProjectState,
  loadHiddenRoleRunInboxState,
  loadSparkMode,
  saveCurrentProjectRef,
} from "../packages/spark-extension/src/extension/session-state.ts";
import {
  assignTodoDisplayNumber,
  importLegacyIndependentTodos,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveIndependentTodos,
  saveTodoDisplayNumberState,
} from "../packages/spark-extension/src/extension/session-todos.ts";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusView,
} from "../packages/spark-extension/src/extension/spark-status.ts";
import {
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalProjectRef,
  normalizeOptionalRunRef,
  normalizeSparkBackgroundAction,
  normalizeSparkBackgroundBoolean,
} from "../packages/spark-extension/src/extension/background-runs.ts";
import {
  normalizeSparkRunReadyTasksBoolean,
  normalizeSparkRunReadyTasksPositiveInteger,
} from "../packages/spark-extension/src/extension/spark-run-ready-tasks-tool-registration.ts";
import { normalizeSparkPlanTaskInputs } from "../packages/spark-extension/src/extension/spark-plan-tasks-tool-registration.ts";
import { normalizeSparkClaimTaskInput } from "../packages/spark-extension/src/extension/spark-claim-task-tool-registration.ts";
import { normalizeSparkFinishTaskInput } from "../packages/spark-extension/src/extension/spark-finish-task-tool-registration.ts";
import {
  goalReviewDirectory,
  rebuildWorkspaceReviewIndex,
  subjectReviewRecordPath,
  taskReviewDirectory,
} from "../packages/spark-extension/src/extension/subject-review-store.ts";
import { normalizeSparkTodoOps } from "../packages/spark-extension/src/extension/spark-todo-tool-registration.ts";
import {
  normalizeArtifactBoolean,
  normalizeArtifactLimit,
  normalizeArtifactRef,
  normalizePositiveInteger,
} from "../packages/spark-extension/src/extension/artifact-tools.ts";
import {
  normalizeLearningBoolean,
  normalizeLearningCategory,
  normalizeLearningConfidence,
  normalizeLearningInput,
  normalizeLearningLocation,
  normalizeLearningStatusFilter,
  normalizeStringArray,
} from "../packages/spark-extension/src/extension/learning-tools.ts";
import {
  normalizeSparkWorkflowRunsAction,
  normalizeSparkWorkflowRunsBoolean,
  normalizeSparkWorkflowRunsNonNegativeInteger,
  normalizeSparkWorkflowRunsRunRef,
} from "../packages/spark-extension/src/extension/spark-workflow-runs-tool-registration.ts";
import { defaultSparkDynamicWorkflowEventStore } from "../packages/spark-extension/src/extension/spark-dynamic-workflow-event-store.ts";
import {
  normalizeSparkNewProjectInput,
  normalizeSparkProjectOptionalString,
  normalizeSparkProjectOutputLanguage,
  normalizeSparkProjectPatch,
} from "../packages/spark-extension/src/extension/spark-project-tools.ts";
import {
  normalizeSparkStateAction,
  normalizeSparkStateOptionalString,
} from "../packages/spark-extension/src/extension/spark-state-tool-registration.ts";
import {
  normalizeTaskKind,
  normalizeTaskStatus,
} from "../packages/spark-extension/src/extension/task-plan-tool.ts";
import { normalizeSparkAskReplayArtifactRef } from "../packages/spark-extension/src/extension/spark-ask-tool-registration.ts";
import {
  inferSessionGoalObjective,
  loadSessionGoal,
  setSessionGoal,
  updateSessionGoalStatus,
} from "../packages/spark-extension/src/extension/spark-session-goals.ts";
import {
  loadSessionLoop,
  setSessionLoop,
} from "../packages/spark-extension/src/extension/spark-session-loops.ts";
import type {
  ReviewInput,
  ReviewerRunResult,
  ReviewerRunner,
} from "../packages/spark-extension/src/extension/reviewer-runner.ts";

type SparkExtensionApiForTest = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkExtensionApiForTest["registerTool"]>>[0];
type SparkToolResult = Awaited<ReturnType<SparkToolConfig["execute"]>>;
type TestNotification = { message: string; level?: "info" | "warning" | "error" | "success" };

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`${objective} succeeds`],
    evidenceRequired: [`${objective} evidence is recorded`],
    steps: [objective],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

type NormalizerAcceptCase = [actual: () => unknown, expected: unknown];
type NormalizerRejectCase = [actual: () => unknown, error: RegExp];

function runNormalizerGroup(
  name: string,
  accepts: NormalizerAcceptCase[],
  rejects: NormalizerRejectCase[],
): void {
  accepts.forEach(([actual, expected], index) => {
    assert.deepEqual(actual(), expected, name + " accepted case " + index);
  });
  rejects.forEach(([actual, error], index) => {
    assert.throws(actual, error, name + " rejected case " + index);
  });
}

const workflowRunActionError =
  /action must be status, list, inspect, pause, resume, stop, restart, save, kill, reply, steer, reconcile, ack, prune, clear_inactive, or kill_active/;

void test("Spark tool normalizer groups reject invalid explicit parameters instead of using defaults", () => {
  runNormalizerGroup(
    "status",
    [
      [() => normalizeSparkStatusView({}), "active"],
      [() => normalizeSparkStatusFormat({}), "text"],
      [() => normalizeSparkStatusLimit({}), undefined],
    ],
    [
      [() => normalizeSparkStatusView({ view: "compact" }), /view must be active/],
      [() => normalizeSparkStatusFormat({ format: "yaml" }), /format must be text or json/],
      [() => normalizeSparkStatusLimit({ limit: "20" }), /limit must be a finite number/],
      [() => normalizeSparkStatusLimit({ limit: 1.5 }), /limit must be a non-negative integer/],
    ],
  );

  runNormalizerGroup(
    "background runs",
    [
      [() => normalizeSparkBackgroundAction(undefined), "status"],
      [() => normalizeSparkBackgroundAction("kill"), "kill"],
      [() => normalizeSparkBackgroundAction("pause"), "pause"],
      [() => normalizeOptionalRunRef(" run:child "), "run:child"],
      [() => normalizeOptionalProjectRef(" proj:main "), "proj:main"],
      [() => normalizeKillSignal("sigkill"), "SIGKILL"],
      [() => normalizeForceAfterMs(0), 0],
      [() => normalizeSparkBackgroundBoolean(undefined, false, "field"), false],
    ],
    [
      [() => normalizeSparkBackgroundAction("cancel"), workflowRunActionError],
      [() => normalizeOptionalRunRef("child"), /runRef must be a run ref/],
      [() => normalizeOptionalRunRef(123), /runRef must be a string/],
      [() => normalizeOptionalProjectRef("project"), /projectRef must be a project ref/],
      [() => normalizeKillSignal("TERM"), /signal must be one of/],
      [() => normalizeForceAfterMs("0"), /forceAfterMs must be a finite number/],
      [() => normalizeForceAfterMs(1.5), /forceAfterMs must be a non-negative integer/],
      [
        () => normalizeSparkBackgroundBoolean("true", false, "includeHistory"),
        /includeHistory must be a boolean/,
      ],
    ],
  );

  runNormalizerGroup(
    "ready-task runner",
    [
      [() => normalizeSparkRunReadyTasksBoolean(undefined, true, "dryRun"), true],
      [() => normalizeSparkRunReadyTasksBoolean(false, true, "dryRun"), false],
      [() => normalizeSparkRunReadyTasksPositiveInteger(undefined, 4, "maxConcurrency"), 4],
      [() => normalizeSparkRunReadyTasksPositiveInteger(2, 4, "maxConcurrency"), 2],
    ],
    [
      [
        () => normalizeSparkRunReadyTasksBoolean("false", true, "dryRun"),
        /dryRun must be a boolean/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger("2", 4, "maxConcurrency"),
        /maxConcurrency must be a finite number/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger(2.5, 4, "maxConcurrency"),
        /maxConcurrency must be a positive integer/,
      ],
      [
        () => normalizeSparkRunReadyTasksPositiveInteger(0, 4, "maxConcurrency"),
        /maxConcurrency must be a positive integer/,
      ],
    ],
  );

  runNormalizerGroup(
    "workflow runs",
    [
      [() => normalizeSparkWorkflowRunsAction(undefined), "status"],
      [() => normalizeSparkWorkflowRunsAction("prune"), "prune"],
      [() => normalizeSparkWorkflowRunsAction("restart"), "restart"],
      [() => normalizeSparkWorkflowRunsAction("save"), "save"],
      [() => normalizeSparkWorkflowRunsRunRef(undefined), undefined],
      [() => normalizeSparkWorkflowRunsRunRef("run:one"), "run:one"],
      [() => normalizeSparkWorkflowRunsBoolean(undefined, true, "dryRun"), true],
      [() => normalizeSparkWorkflowRunsBoolean(false, true, "dryRun"), false],
      [() => normalizeSparkWorkflowRunsNonNegativeInteger(undefined, 10, "keepRecent"), 10],
      [() => normalizeSparkWorkflowRunsNonNegativeInteger(0, 10, "keepRecent"), 0],
    ],
    [
      [() => normalizeSparkWorkflowRunsAction("acknowledge"), workflowRunActionError],
      [() => normalizeSparkWorkflowRunsAction(""), workflowRunActionError],
      [() => normalizeSparkWorkflowRunsRunRef("task:one"), /runRef must be a run ref/],
      [
        () => normalizeSparkWorkflowRunsBoolean("false", true, "dryRun"),
        /dryRun must be a boolean/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger("0", 10, "keepRecent"),
        /keepRecent must be a finite number/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger(1.5, 10, "keepRecent"),
        /keepRecent must be a non-negative integer/,
      ],
      [
        () => normalizeSparkWorkflowRunsNonNegativeInteger(-1, 10, "keepRecent"),
        /keepRecent must be a non-negative integer/,
      ],
    ],
  );

  runNormalizerGroup(
    "artifacts",
    [
      [() => normalizeArtifactLimit(undefined, 20), 20],
      [() => normalizeArtifactLimit(0, 20), 0],
      [() => normalizeArtifactLimit(12, 20), 12],
      [() => normalizePositiveInteger(undefined, 1, "thresholdBytes"), 1],
      [() => normalizePositiveInteger(8, 1, "thresholdBytes"), 8],
      [() => normalizeArtifactBoolean(undefined, false, "dryRun"), false],
      [() => normalizeArtifactBoolean(true, false, "dryRun"), true],
      [() => normalizeArtifactRef("artifact:one"), "artifact:one"],
    ],
    [
      [() => normalizeArtifactLimit("12", 20), /limit must be a finite number/],
      [() => normalizeArtifactLimit(1.5, 20), /limit must be a non-negative integer/],
      [() => normalizeArtifactLimit(-1, 20), /limit must be a non-negative integer/],
      [
        () => normalizePositiveInteger(0, 1, "thresholdBytes"),
        /thresholdBytes must be a positive integer/,
      ],
      [() => normalizeArtifactBoolean("true", false, "dryRun"), /dryRun must be a boolean/],
      [() => normalizeArtifactRef("note:one"), /artifactRef must be an artifact: ref/],
    ],
  );

  runNormalizerGroup(
    "learnings",
    [
      [() => normalizeLearningStatusFilter(undefined), undefined],
      [() => normalizeLearningStatusFilter("active"), "active"],
      [() => normalizeLearningStatusFilter(["active", "candidate"]), ["active", "candidate"]],
      [() => normalizeLearningLocation("workspace"), "workspace"],
      [() => normalizeLearningLocation("repo"), "repo"],
      [() => normalizeLearningCategory("decision"), "decision"],
      [() => normalizeStringArray(["a", "b"], "tags"), ["a", "b"]],
      [() => normalizeLearningBoolean(undefined, false, "includeCandidates"), false],
      [() => normalizeLearningConfidence(undefined), undefined],
      [() => normalizeLearningConfidence(0.75), 0.75],
    ],
    [
      [() => normalizeLearningStatusFilter("archived"), /status must be candidate/],
      [() => normalizeLearningStatusFilter(["active", "archived"]), /status must be/],
      [() => normalizeLearningLocation("thread"), /location must be user/],
      [() => normalizeLearningCategory("lesson"), /category must be pattern/],
      [() => normalizeStringArray(["a", 1], "tags"), /tags must be a string array/],
      [
        () => normalizeLearningBoolean("true", false, "includeCandidates"),
        /includeCandidates must be a boolean/,
      ],
      [() => normalizeLearningConfidence(1.2), /confidence must be a finite number/],
      [
        () =>
          normalizeLearningInput({
            title: "Bad learning",
            statement: "Bad learning statement",
            tags: ["valid", 1],
          }),
        /tags must be a string array/,
      ],
    ],
  );

  runNormalizerGroup(
    "state",
    [
      [() => normalizeSparkStateAction(undefined), "state_status"],
      [() => normalizeSparkStateAction("role_run_artifact_compact"), "role_run_artifact_compact"],
      [() => normalizeSparkStateOptionalString(undefined, "exportDir"), undefined],
      [() => normalizeSparkStateOptionalString("exports", "exportDir"), "exports"],
    ],
    [
      [() => normalizeSparkStateAction("repair"), /action must be state_status/],
      [() => normalizeSparkStateAction(42), /action must be state_status/],
      [() => normalizeSparkStateOptionalString("", "exportDir"), /exportDir must be/],
      [() => normalizeSparkStateOptionalString(1, "exportDir"), /exportDir must be/],
    ],
  );

  runNormalizerGroup(
    "projects",
    [
      [() => normalizeSparkProjectOptionalString(undefined, "title"), undefined],
      [() => normalizeSparkProjectOptionalString(" Demo ", "title"), "Demo"],
      [() => normalizeSparkProjectOutputLanguage(undefined), undefined],
      [() => normalizeSparkProjectOutputLanguage("zh"), "zh"],
      [
        () =>
          normalizeSparkProjectPatch({
            title: " Renamed ",
            purpose: " Ship v0 ",
          }),
        {
          title: "Renamed",
          description: undefined,
          purpose: "Ship v0",
          outputLanguage: undefined,
        },
      ],
      [
        () =>
          normalizeSparkNewProjectInput({
            project: " Demo ",
            title: " Next ",
            purpose: " Ship v0 ",
          }),
        {
          project: "Demo",
          title: "Next",
          description: undefined,
          purpose: "Ship v0",
          outputLanguage: undefined,
        },
      ],
      [
        () => normalizeSparkProjectPatch({ intent: "ignored extra field" }),
        {
          title: undefined,
          description: undefined,
          purpose: undefined,
          outputLanguage: undefined,
        },
      ],
    ],
    [
      [() => normalizeSparkProjectOptionalString("", "title"), /title must be/],
      [() => normalizeSparkProjectOptionalString(1, "title"), /title must be/],
      [() => normalizeSparkProjectOutputLanguage("fr"), /outputLanguage must be zh or en/],
      [() => normalizeSparkProjectPatch({ title: "" }), /title must be/],
      [() => normalizeSparkProjectPatch({ outputLanguage: "jp" }), /outputLanguage/],
      [() => normalizeSparkNewProjectInput({ project: "" }), /project must be/],
    ],
  );

  const taskInputs = normalizeSparkPlanTaskInputs(
    {
      tasks: [
        {
          name: " focused-task ",
          title: " Focused task ",
          description: " Implement the focused task. ",
          plan: {
            objective: " Ship focused task ",
            contextRefs: [" docs/plan.md "],
            successCriteria: [" command passes "],
            evidenceRequired: [" focused test output "],
            steps: [" implement ", " verify "],
            riskLevel: "high",
          },
        },
      ],
    },
    new RoleRegistry(),
  );
  assert.equal(taskInputs?.[0]?.name, "focused-task");
  assert.equal(taskInputs?.[0]?.title, "Focused task");
  assert.equal(taskInputs?.[0]?.description, "Implement the focused task.");
  assert.equal(taskInputs?.[0]?.status, undefined);
  assert.equal(taskInputs?.[0]?.plan?.riskLevel, "high");
  assert.deepEqual(taskInputs?.[0]?.plan?.successCriteria, ["command passes"]);

  const claimInput = normalizeSparkClaimTaskInput(
    {
      name: " focused-claim ",
      title: " Focused claim ",
      description: " Claim focused work. ",
      kind: "implement",
      status: "ready",
    },
    new RoleRegistry(),
  );
  assert.equal(claimInput.name, "focused-claim");
  assert.equal(claimInput.title, "Focused claim");
  assert.equal(claimInput.description, "Claim focused work.");
  assert.equal(claimInput.kind, "implement");
  assert.equal(claimInput.requestedStatus, "ready");

  runNormalizerGroup(
    "task planning",
    [
      [() => normalizeTaskKind(undefined), undefined],
      [() => normalizeTaskKind("implement"), "implement"],
      [() => normalizeTaskKind("research"), "research"],
      [() => normalizeTaskKind("review"), "review"],
      [() => normalizeTaskStatus(undefined), undefined],
      [() => normalizeTaskStatus("pending"), "pending"],
      [() => normalizeSparkPlanTaskInputs({}, new RoleRegistry()), undefined],
      [
        () => normalizeSparkFinishTaskInput({}),
        {
          task: undefined,
          status: "done",
          summary: undefined,
          evidenceRefs: [],
          evidence: undefined,
        },
      ],
      [
        () =>
          normalizeSparkFinishTaskInput({
            status: "failed",
            summary: " Failed ",
            evidenceRefs: ["artifact:focused-validation"],
          }),
        {
          task: undefined,
          status: "failed",
          summary: "Failed",
          evidenceRefs: ["artifact:focused-validation"],
          evidence: undefined,
        },
      ],
      [
        () =>
          normalizeSparkFinishTaskInput({
            evidence: {
              title: " Evidence title ",
              notes: " Notes ",
              changedFiles: [" packages/spark-extension/src/file.ts "],
              sourceRefs: [" test/file.test.ts:10 "],
              validationCommands: [" pnpm test — pass "],
            },
          }),
        {
          task: undefined,
          status: "done",
          summary: undefined,
          evidenceRefs: [],
          evidence: {
            title: "Evidence title",
            notes: "Notes",
            changedFiles: ["packages/spark-extension/src/file.ts"],
            sourceRefs: ["test/file.test.ts:10"],
            validationCommands: ["pnpm test — pass"],
          },
        },
      ],
      [() => normalizeSparkTodoOps(undefined), undefined],
      [
        () => normalizeSparkTodoOps([{ op: "init", items: [" One ", "Two"] }]),
        [{ op: "init", items: ["One", "Two"] }],
      ],
      [
        () => normalizeSparkTodoOps([{ op: "block", item: "One", blockedBy: [" Gate "] }]),
        [{ op: "block", item: "One", blockedBy: ["Gate"] }],
      ],
      [
        () => normalizeSparkTodoOps([{ op: "upsert_done", item: " One " }]),
        [{ op: "upsert_done", item: "One" }],
      ],
    ],
    [
      [() => normalizeTaskKind("build"), /kind must be research, implement, or review/],
      [() => normalizeTaskKind(1), /kind must be research, implement, or review/],
      [() => normalizeTaskKind("plan"), /internal\/reserved/],
      [() => normalizeTaskKind("proj:demo"), /project ref/],
      [() => normalizeTaskStatus("waiting"), /status must be pending/],
      [() => normalizeTaskStatus(false), /status must be pending/],
      [
        () => normalizeSparkPlanTaskInputs({ tasks: {} }, new RoleRegistry()),
        /tasks must be a non-empty array/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: 42, description: "Implement focused task." }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.title must be a string/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: "Focused task", description: "Implement.", dependsOn: [1] }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.dependsOn must be an array of strings/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            { tasks: [{ title: "Focused task", description: "Implement.", plan: "later" }] },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.plan must be an object/,
      ],
      [
        () =>
          normalizeSparkPlanTaskInputs(
            {
              tasks: [
                {
                  title: "Focused task",
                  description: "Implement.",
                  plan: { riskLevel: "urgent" },
                },
              ],
            },
            new RoleRegistry(),
          ),
        /tasks\[0\]\.plan\.riskLevel must be trivial, normal, or high/,
      ],
      [
        () =>
          normalizeSparkClaimTaskInput(
            { title: 42, description: "Claim focused work." },
            new RoleRegistry(),
          ),
        /title must be a string/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ status: "cancel" }),
        /status must be done, failed, or cancelled/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ evidenceRefs: "artifact:focused-validation" }),
        /evidenceRefs must be an array of artifact refs/,
      ],
      [
        () => normalizeSparkFinishTaskInput({ evidenceRefs: ["task:not-an-artifact"] }),
        /evidenceRefs\[0\] must be an artifact: ref/,
      ],
      [() => normalizeSparkFinishTaskInput({ summary: 42 }), /summary must be a string/],
      [() => normalizeSparkFinishTaskInput({ evidence: [] }), /evidence must be an object/],
      [
        () => normalizeSparkFinishTaskInput({ evidence: { changedFiles: [1] } }),
        /evidence\.changedFiles must be an array of strings/,
      ],
      [() => normalizeSparkStateAction("status"), /action must be state_status/],
      [() => normalizeSparkStateAction("compact-role-run-artifacts"), /role_run_artifact_compact/],
      [() => normalizeSparkTodoOps({}), /ops must be a non-empty array/],
      [() => normalizeSparkTodoOps([{ op: "pause", item: "One" }]), /ops\[0\]\.op must be init/],
      [
        () => normalizeSparkTodoOps([{ op: "init", items: [1] }]),
        /ops\[0\]\.items must be an array of strings/,
      ],
    ],
  );

  runNormalizerGroup(
    "ask replay",
    [
      [() => normalizeSparkAskReplayArtifactRef(undefined), undefined],
      [() => normalizeSparkAskReplayArtifactRef("artifact:ask-one"), "artifact:ask-one"],
    ],
    [
      [() => normalizeSparkAskReplayArtifactRef(42), /artifactRef must be a string/],
      [() => normalizeSparkAskReplayArtifactRef("ask:one"), /artifactRef must be an artifact: ref/],
    ],
  );
});

type TestSparkContext = {
  cwd: string;
  sessionManager: {
    getSessionFile: () => string | undefined;
    getLeafId: () => string | undefined;
  };
  waitForIdle?: () => Promise<void>;
  hasUI: boolean;
  notifications: TestNotification[];
  selected?: string;
  inputValue?: string;
  editorText?: string;
  askAutoAnswer?: "reviewer";
  sparkActiveLens?: {
    mode: "research" | "plan" | "implement";
    driver?: "interactive" | "goal" | "workflow";
  };
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    setWidget: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus: (key: string, text: string | undefined) => void;
    setEditorText?: (text: string) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    custom?: (...args: unknown[]) => unknown;
  };
};

void test("Spark command surface does not expose the removed /spark entry", () => {
  const run = registerSparkToolsForTest();
  assert.equal(run.commands.has("spark"), false);
});

void test("/ultracode enters opt-in high-effort workflow generation mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ultracode-command-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const ultracode = run.commands.get("ultracode");
    assert.ok(ultracode, "missing /ultracode command");

    await ultracode.handler("design and validate a workflow parity suite", ctx);

    const message = run.customMessages.at(-1);
    assert.equal(message?.customType, "spark-mode-request");
    assert.equal(message?.display, false);
    assert.equal(run.messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/plan, /implement, /goal, and /workflow selector commands enter Spark modes directly", async () => {
  const existingDir = await mkdtemp(join(tmpdir(), "spark-plan-direct-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-initialized-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-execute-direct-empty-"));
  try {
    await mkdir(join(existingDir, ".git"));
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    const existingRun = registerSparkToolsForTest();
    const planCommand = existingRun.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");
    await planCommand.handler("Audit current task flow", existingCtx);
    assert.equal(existsSync(projectTreeIndexPath(existingDir)), true);
    assert.equal(existsSync(join(existingDir, "SPARK.md")), false);
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.equal(existingRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.equal(existingCtx.sparkActiveLens?.mode, "plan");

    await writeEmptySparkProject(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(initializedDir, initializedCtx), { recursive: true });
      await writeFile(
        currentProjectStatePath(initializedDir, initializedCtx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        projectRef: project.ref,
        title: "Direct execution task needing a plan",
        description: "Direct execution task needing a plan",
        status: "pending",
      });
    });
    const initializedRun = registerSparkToolsForTest();
    assert.equal(initializedRun.commands.get("research"), undefined);
    const executeCommand = initializedRun.commands.get("implement");
    assert.ok(executeCommand, "missing /implement command");
    await executeCommand.handler("Finish the direct execution task", initializedCtx);
    assert.equal(initializedRun.messages.length, 0);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveLens, { mode: "implement", driver: "interactive" });

    initializedCtx.ui.select = async () =>
      assert.fail("/implement should not open a canned implement-strategy ask");
    await executeCommand.handler("keep going until done", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    const askedGoalState = JSON.parse(
      await readFile(currentProjectStatePath(initializedDir, initializedCtx), "utf8"),
    ) as { projectRef?: string; executionMode?: unknown };
    assert.ok(askedGoalState.projectRef);
    assert.equal(askedGoalState.executionMode, undefined);
    initializedCtx.ui.select = async () =>
      assert.fail("explicit /workflow selector aliases should not ask for strategy");

    const goalCommand = initializedRun.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    const loopCommand = initializedRun.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    assert.equal(initializedRun.commands.get("workflow:goal"), undefined);
    assert.ok(initializedRun.commands.get("workflow:research"));
    assert.ok(initializedRun.commands.get("workflow:review"));
    await goalCommand.handler("Finish the queue until done", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-goal-request");
    const goalSessionStateRaw = await readFile(
      sessionGoalPath(initializedDir, initializedCtx),
      "utf8",
    );
    const goalSessionState = JSON.parse(goalSessionStateRaw) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalSessionState.goal?.objective, "Finish the queue until done");
    assert.equal(goalSessionState.goal?.status, "active");
    const sessionAfterGoal = JSON.parse(
      await readFile(currentProjectStatePath(initializedDir, initializedCtx), "utf8"),
    ) as { executionMode?: unknown };
    assert.equal(sessionAfterGoal.executionMode, undefined);

    await goalCommand.handler("", initializedCtx);
    const inferredGoalMessage = initializedRun.customMessages.at(-1);
    assert.equal(inferredGoalMessage?.customType, "spark-goal-request");
    assert.equal(inferredGoalMessage?.details?.purpose, "foreground-goal-tick");
    assert.equal(initializedRun.commands.get("workflow:ready"), undefined);

    const messagesBeforeLoop = initializedRun.customMessages.length;
    await loopCommand.handler("Continue the queue without completing", initializedCtx);
    assert.equal(initializedRun.customMessages.length, messagesBeforeLoop + 1);
    const loopMessage = initializedRun.customMessages.at(-1);
    assert.equal(loopMessage?.customType, "spark-loop-request");
    assert.equal(loopMessage?.details?.purpose, "foreground-loop-tick");
    const activeLoop = await loadSessionLoop(initializedDir, initializedCtx);
    assert.equal(activeLoop?.objective, "Continue the queue without completing");
    assert.equal(activeLoop?.status, "active");
    assert.equal(await loadSessionGoal(initializedDir, initializedCtx), undefined);
    await loopCommand.handler("停止", initializedCtx);
    const pausedLoop = await loadSessionLoop(initializedDir, initializedCtx);
    assert.equal(pausedLoop?.loopId, activeLoop?.loopId);
    assert.equal(pausedLoop?.status, "paused");
    assert.equal(pausedLoop?.retryState, undefined);
    assert.match(pausedLoop?.pauseReason ?? "", /Paused by \/loop stop/);

    await mkdir(join(initializedDir, ".spark", "workflows"), { recursive: true });
    await writeFile(
      join(initializedDir, ".spark", "workflows", "triage.js"),
      `export const meta = {
        name: "Triage Workflow",
        description: "Triage incidents with specialist phases.",
        phases: [{ title: "Collect" }, { title: "Decide" }],
      };
      export default async function workflow() { return "not run during discovery"; }`,
    );
    await writeFile(
      join(initializedDir, ".spark", "workflows", "broken.js"),
      `export const meta = { name: "Broken" };`,
    );
    const workflowCommand = initializedRun.commands.get("workflow");
    assert.ok(workflowCommand, "missing /workflow command");
    const workflowsCommand = initializedRun.commands.get("workflows");
    assert.ok(workflowsCommand, "missing /workflows command");
    const researchWorkflowCommand = initializedRun.commands.get("workflow:research");
    assert.ok(researchWorkflowCommand, "missing /workflow:research command");
    assert.equal(initializedRun.commands.get("workflow:triage"), undefined);
    await workflowCommand.handler("workspace:triage Review with a workflow", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    await workflowCommand.handler("builtin:research Compare design options", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveLens, { mode: "research", driver: "workflow" });

    await researchWorkflowCommand.handler(
      "Compare default panel and judge behavior",
      initializedCtx,
    );
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(initializedCtx.sparkActiveLens, { mode: "research", driver: "workflow" });

    let workflowNavigatorOptions: string[] = [];
    initializedCtx.ui.select = async (_title, options) => {
      workflowNavigatorOptions = options;
      return initializedCtx.selected;
    };
    initializedCtx.selected = "builtin:review";
    initializedCtx.inputValue = "Review the workflow UI direction";
    await workflowCommand.handler("", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    initializedCtx.selected = "workspace:triage";
    await workflowsCommand.handler("Navigator supplied focus", initializedCtx);
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    const navigatorStore = defaultSparkDynamicWorkflowEventStore(initializedDir);
    const navigatorRun = await navigatorStore.start({
      source: { kind: "inline", label: "navigator control workflow" },
      script:
        "export const meta = { name: 'Navigator Control', description: 'Navigator control workflow' }\nreturn 'ok'",
      meta: { name: "Navigator Control", description: "Navigator control workflow" },
      options: {},
    });
    initializedCtx.selected = `dynamic:save:${navigatorRun.ref} running navigator control workflow`;
    await workflowsCommand.handler("", initializedCtx);
    assert.ok(
      workflowNavigatorOptions.some((option) =>
        option.startsWith(`dynamic:save:${navigatorRun.ref}`),
      ),
      "expected /workflows navigator to expose dynamic workflow run save action",
    );
    assert.ok(
      initializedCtx.notifications.some((entry) =>
        /Spark dynamic workflow dashboard \(navigator\)/.test(entry.message),
      ),
      "expected /workflows navigator to show the dynamic workflow dashboard before selection",
    );
    assert.match(
      initializedCtx.notifications.at(-1)?.message ?? "",
      /Spark dynamic workflow dashboard \(save\)/,
    );
    assert.match(initializedCtx.notifications.at(-1)?.message ?? "", /Control: save/);
    assert.match(
      initializedCtx.notifications.at(-1)?.message ?? "",
      /workspace:navigator-control-/,
    );
    assert.match(
      (await navigatorStore.get(navigatorRun.ref))?.savedWorkflow?.selector ?? "",
      /^workspace:navigator-control-/,
    );
    initializedCtx.ui.select = async () =>
      assert.fail("non-empty /workflow focus should not ask for a selector before prompting");

    await workflowCommand.handler(
      "Run this one-shot workflow:\n\n" +
        "```js\n" +
        "export const meta = {\n" +
        '  name: "Inline Cleanup",\n' +
        '  description: "Clean up temporary files with a one-shot workflow.",\n' +
        '  phases: [{ title: "Inspect" }, { title: "Remove" }],\n' +
        "};\n" +
        'export default async function workflow() { throw new Error("not run during discovery"); }\n' +
        "```",
      initializedCtx,
    );
    assert.equal(initializedRun.customMessages.at(-1)?.customType, "spark-mode-request");

    assert.equal(initializedRun.commands.get("run"), undefined);
    assert.equal(initializedRun.commands.get("run-sequential"), undefined);
    assert.equal(initializedRun.commands.get("run-parallel"), undefined);

    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyExecute = emptyRun.commands.get("implement");
    assert.ok(emptyExecute, "missing /implement command");
    await emptyExecute.handler("", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 0);
    const emptyGoalCommand = emptyRun.commands.get("goal");
    assert.ok(emptyGoalCommand, "missing /goal command");
    assert.equal(emptyRun.commands.get("workflow:goal"), undefined);
    await emptyGoalCommand.handler("", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 1);
    const emptyWorkflowCommand = emptyRun.commands.get("workflow:research");
    assert.ok(emptyWorkflowCommand, "missing /workflow:research command");
    await emptyWorkflowCommand.handler("Investigate standalone workflow usage", emptyCtx);
    assert.equal(emptyRun.customMessages.length, 2);
    assert.equal(emptyRun.customMessages.at(-1)?.customType, "spark-mode-request");
  } finally {
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("latest direct Spark mode replaces older pending hidden mode context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-context-replace-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);

    const goalCommand = run.commands.get("goal");
    const executeCommand = run.commands.get("implement");
    const planCommand = run.commands.get("plan");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    assert.ok(executeCommand, "missing /implement command");
    assert.ok(planCommand, "missing /plan command");

    await goalCommand.handler("work through background queue", ctx);
    await executeCommand.handler("take one task", ctx);
    await planCommand.handler("revise the failed task plan", ctx);

    const hiddenMessage = run.customMessages.at(-1);
    assert.equal(hiddenMessage?.customType, "spark-mode-request");
    assert.equal(ctx.sparkActiveLens?.mode, "plan");
    assert.equal(ctx.sparkActiveLens?.driver, "interactive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/plan includes active roadmap item context and matches focus to an existing item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-context-"));
  try {
    await writeEmptySparkProject(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:other",
      items: [
        {
          ref: "roadmap-item:other",
          title: "Other roadmap item",
          objective: "Keep an unrelated active item available.",
          status: "active",
        },
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Use roadmap item intent while planning tasks.",
          scope: "Keep changes within task organization only.",
          successCriteria: ["Planning prompt includes roadmap context."],
          evidenceRequired: ["Roadmap item refs are visible to planning."],
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const seededGraph = await defaultTaskGraphStore(dir).load();
    const seededProject = seededGraph?.projects()[0];
    assert.ok(seededProject);
    await saveCurrentProjectRef(dir, ctx, seededProject.ref);
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await planCommand.handler("Roadmap assisted planning", ctx);

    assert.equal(run.messages.length, 0);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(ctx.sparkActiveLens, { mode: "plan", driver: "interactive" });
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project?.roadmap);
    assert.equal(project.roadmap.activeItemRef, "roadmap-item:planning");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/plan rejects malformed roadmap state without entering planning mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-malformed-"));
  try {
    await writeEmptySparkProject(dir);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    const roadmapPath = join(
      dir,
      ".spark",
      "projects",
      projectTreeDirName(project.ref),
      "roadmap.json",
    );
    const snapshot = JSON.parse(await readFile(roadmapPath, "utf8")) as { items?: unknown };
    snapshot.items = "not-array";
    await writeFile(roadmapPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await assert.rejects(async () => {
      await planCommand.handler("Roadmap assisted planning", ctx);
    }, /invalid project roadmap: .*\.items must be an array/);
    assert.equal(run.customMessages.length, 0);
    const currentState = await loadCurrentProjectState(dir, ctx);
    assert.equal(currentState, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks maps active roadmap item hints into task plans and attaches refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-roadmap-hints-"));
  try {
    await writeEmptySparkProject(dir);
    await writeRoadmap(dir, {
      activeItemRef: "roadmap-item:planning",
      items: [
        {
          ref: "roadmap-item:planning",
          title: "Roadmap assisted planning",
          objective: "Organize roadmap-backed Spark planning tasks.",
          scope: "Do not add dashboard or scheduling features.",
          successCriteria: ["Created tasks use roadmap success criteria."],
          evidenceRequired: ["Task refs are attached to the roadmap item."],
          status: "active",
        },
      ],
    });
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "roadmap-backed-task",
          title: "Create roadmap-backed task",
          description: "Exercise roadmap-assisted planning hints.",
          kind: "implement",
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    assert.match(toolText(planned), /roadmap item updated: roadmap-item:planning/);
    assert.equal((planned.details as { approval?: unknown }).approval, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks()[0];
    assert.ok(task);
    assert.match(task.plan?.contextRefs.join("\n") ?? "", /Roadmap objective:/);
    assert.match(task.plan?.constraints.join("\n") ?? "", /Do not add dashboard/);
    assert.deepEqual(task.plan?.successCriteria, ["Created tasks use roadmap success criteria."]);
    assert.deepEqual(task.plan?.evidenceRequired, ["Task refs are attached to the roadmap item."]);

    const project = graph?.projects()[0];
    const item = project?.roadmap.items[0];
    assert.ok(item?.taskRefs?.includes(task.ref));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks writes directly whenever durable planning is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-any-mode-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools, commands } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const noMode = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-no-mode",
          title: "Direct plan outside prompt mode",
          description: "Save durable planning without requiring explicit /plan mode.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Save durable planning without requiring explicit /plan mode."),
        },
      ],
    });
    assert.match(toolText(noMode), /Planned tasks: created=1 updated=0/);

    const executeCommand = commands.get("implement");
    assert.ok(executeCommand, "missing /implement command");
    await executeCommand.handler("Do one task", ctx);
    const duringExecute = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-execute-mode",
          title: "Direct plan during execution prompt",
          description: "Save durable planning when the model detects planning is needed.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan(
            "Save durable planning when the model detects planning is needed.",
          ),
        },
      ],
    });
    assert.match(toolText(duringExecute), /Planned tasks: created=1 updated=0/);

    const graph = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      graph
        ?.tasks()
        .map((task) => task.name)
        .sort(),
      ["direct-execute-mode", "direct-no-mode"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks writes directly without approval UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-write-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = undefined as never;
    ctx.ui.input = undefined as never;
    ctx.ui.custom = undefined;
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "direct-plan-write",
          title: "Direct plan write task",
          description: "Exercise direct saving of ready task plans.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Exercise direct saving of ready task plans."),
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const details = planned.details as { error?: string; approval?: unknown; dryRun?: unknown };
    assert.equal(details.error, undefined);
    assert.equal(details.approval, undefined);
    assert.equal(details.dryRun, undefined);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 1);
    assert.equal(graph?.tasks()[0]?.name, "direct-plan-write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks accepts an explicit project selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-explicit-project-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    let secondProjectRef: ProjectRef | undefined;
    await store.update((graph) => {
      const second = graph.createProject({
        title: "Explicit project target",
        description: "Project selected directly by ref.",
      });
      secondProjectRef = second.ref;
    });
    assert.ok(secondProjectRef);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      project: secondProjectRef,
      tasks: [
        {
          name: "explicit-project-task",
          title: "Explicit project task",
          description: "Plan into the explicit project instead of the current project.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan(
            "Plan into the explicit project instead of the current project.",
          ),
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks(secondProjectRef).length, 1);
    assert.equal(graph?.tasks()[0]?.projectRef, secondProjectRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks blocks mixed readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-readiness-mixed-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await taskGraphSnapshotText(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "ready-plan",
          title: "Ready task",
          description: "A ready task that should not save when a sibling is blocked.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("A ready task that should not save when a sibling is blocked."),
        },
        {
          name: "blocked-plan",
          title: "Blocked task",
          description: "A blocked task that should prevent saving the whole batch.",
          kind: "implement",
          status: "pending",
        },
      ],
    });

    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.match(toolText(planned), /Task plan not ready: @blocked-plan/);
    assert.match(toolText(planned), /missing_success_criteria\(blocking\)/);
    assert.match(toolText(planned), /Add at least one observable entry to plan\.successCriteria/);
    assert.equal(details?.dryRun, undefined);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[1]?.blocked, true);
    assert.equal(await taskGraphSnapshotText(dir), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks accepts warning-only openQuestions plans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-open-questions-warning-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "question-notes",
          title: "Task with scratch questions",
          description: "A task whose open questions are non-blocking planning notes.",
          kind: "implement",
          status: "pending",
          plan: {
            ...executionReadyPlan("Run with scratch questions"),
            openQuestions: ["Can we simplify later?"],
          },
        },
      ],
    });

    assert.match(toolText(planned), /Planned tasks: created=1/);
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks().find((candidate) => candidate.name === "question-notes");
    assert.ok(task);
    assert.equal(graph?.taskPlanReadiness(task.ref).ready, true);
    assert.deepEqual(
      graph?.taskPlanReadiness(task.ref).issues.map((issue) => [issue.kind, issue.severity]),
      [["open_questions", "warning"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks reports all-rejected readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-rejected-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await taskGraphSnapshotText(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("readiness validation should not open a task-plan ask");
    ctx.ui.custom = async () =>
      assert.fail("readiness validation should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "blocked-one",
          title: "Blocked task one",
          description: "A blocked task that should not save.",
          kind: "implement",
          status: "pending",
        },
        {
          name: "blocked-two",
          title: "Blocked task two",
          description: "Another blocked task that should not save.",
          kind: "review",
          status: "pending",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan not ready: @blocked-one/);
    assert.match(toolText(planned), /missing_success_criteria\(blocking\)/);
    const details = planned.details as
      | {
          dryRun?: unknown;
          error?: string;
          result?: { created?: unknown[] };
          planDecisions?: Array<{ accepted?: boolean; blocked?: boolean }>;
        }
      | undefined;
    assert.equal(details?.dryRun, undefined);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(
      details?.planDecisions?.every((decision) => decision.blocked),
      true,
    );
    assert.equal(await taskGraphSnapshotText(dir), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/implement continues by prompting for the next ready task without auto-answering or auto-claiming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-execute-one-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
      await writeFile(
        currentProjectStatePath(dir, ctx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        projectRef: project.ref,
        name: "first-ready",
        title: "First ready task",
        description: "First ready task",
        plan: executionReadyPlan("First ready task"),
        status: "pending",
      });
      graph.createTask({
        projectRef: project.ref,
        name: "second-ready",
        title: "Second ready task",
        description: "Second ready task",
        plan: executionReadyPlan("Second ready task"),
        status: "pending",
      });
    });

    const run = registerSparkToolsForTest();
    const executeCommand = run.commands.get("implement");
    assert.ok(executeCommand, "missing /implement command");
    await executeCommand.handler("work through the ready queue", ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.deepEqual(ctx.sparkActiveLens, { mode: "implement", driver: "interactive" });

    await executeSparkTool(run.tools, "impl_claim_task", ctx, {
      name: "first-ready",
      title: "First ready task",
      description: "First ready task",
      status: "running",
      todos: ["Finish first ready task"],
    });
    await executeSparkTool(run.tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Finish first ready task"] },
        { op: "done", item: "Finish first ready task" },
      ],
    });
    const finished = await executeSparkTool(run.tools, "impl_finish_task", ctx, {
      summary: "Finished first ready task.",
    });

    const text = finished.content.map((item) => item.text).join("\n");
    assert.match(text, /Implementation mode can continue/);
    assert.match(text, /Next ready task: @second-ready/);
    assert.match(text, /claim the next ready task, and continue until blocked/);
    assert.doesNotMatch(text, /Implementation mode stopped after one task/);
    assert.doesNotMatch(text, /auto-claimed next ready task/);
    assert.equal((finished.details as { autoClaimedTask?: unknown }).autoClaimedTask, undefined);
    assert.ok((finished.details as { nextReadyTask?: unknown }).nextReadyTask);
    assert.equal((finished.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((finished.details as { statusAfter?: string }).statusAfter, "done");
    assert.equal(
      (finished.details as { remainingReadyTasks?: unknown[] }).remainingReadyTasks?.length,
      1,
    );
    assert.equal(
      (finished.details as { projectCompletionCandidate?: { unfinishedTaskCount?: number } })
        .projectCompletionCandidate?.unfinishedTaskCount,
      1,
    );
    assert.equal(await tryConsumeSparkModeContext(run, ctx), undefined);

    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(run.customMessages.at(-1)?.customType, "spark-mode-request");
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    assert.deepEqual(ctx.sparkActiveLens, { mode: "implement", driver: "interactive" });

    const graph = await defaultTaskGraphStore(dir).load();
    const next = graph?.tasks().find((task) => task.name === "second-ready");
    assert.equal(next?.status, "pending");
    assert.equal(next?.claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal sets a durable session goal instead of execute-mode continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-run-foreground-continue-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
      await writeFile(
        currentProjectStatePath(dir, ctx),
        JSON.stringify({ version: 1, projectRef: project.ref }, null, 2),
        "utf8",
      );
    });

    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    await goalCommand.handler("work through the ready queue until done", ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
    const goalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalState.goal?.objective, "work through the ready queue until done");
    assert.equal(goalState.goal?.status, "active");

    const sessionState = JSON.parse(await readFile(currentProjectStatePath(dir, ctx), "utf8")) as {
      executionMode?: unknown;
      runMode?: unknown;
    };
    assert.equal(sessionState.executionMode, undefined);
    assert.equal(sessionState.runMode, undefined);
    assert.equal(run.customMessages.at(-1)?.details?.purpose, "foreground-goal-start");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("foreground drivers plan empty-frontier research-progress objectives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-foreground-empty-frontier-plan-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const objective = "不断学习其他项目，调研，考虑优化 Spark 方案，创建任务并完成它们";

    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler(objective, ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
    assert.equal(run.customMessages.at(-1)?.details?.selectedMode, "plan");

    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    await loopCommand.handler(objective, ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-loop-request");
    assert.equal(run.customMessages.at(-1)?.details?.selectedMode, "plan");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("foreground drivers preserve pure empty-frontier research objectives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-foreground-empty-frontier-research-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const objective = "调研其他项目并总结发现";

    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler(objective, ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
    assert.equal(run.customMessages.at(-1)?.details?.selectedMode, "research");

    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    await loopCommand.handler(objective, ctx);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-loop-request");
    assert.equal(run.customMessages.at(-1)?.details?.selectedMode, "research");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal without objective dispatches an agent infer instruction without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-empty-infer-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");

    await goalCommand.handler("", ctx);

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal, undefined);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.details?.purpose, "empty-goal-infer");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("goal status surfaces lifecycle actions, usage, review, and retry state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-status-polish-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goal = await setSessionGoal(dir, ctx, {
      objective: "Explain polished goal status output",
      source: "explicit",
      status: "active",
    });
    await updateSessionGoalStatus(dir, ctx, "active", {
      expectedGoalId: goal.goalId,
      review: {
        achieved: false,
        confidence: "medium",
        reason: "status output still needs polish",
        remainingWork: "finish the display copy",
        blockers: ["missing action guidance"],
        reviewedAt: "2026-06-10T00:00:00.000Z",
      },
      retryState: {
        consecutiveFailures: 1,
        lastFailureAt: "2026-06-10T00:00:00.000Z",
        nextDelayMs: 30_000,
      },
    });

    const status = await executeSparkTool(run.tools, "goal", ctx, { action: "status" });
    const statusText = toolText(status);
    assert.match(statusText, /Spark session goal active/);
    assert.match(statusText, /Goal: Explain polished goal status output/);
    assert.doesNotMatch(statusText, /Objective:/);
    assert.doesNotMatch(statusText, /Spark session goal active:/);
    assert.doesNotMatch(statusText, /Usage:/);
    assert.doesNotMatch(statusText, /tokens/);
    assert.match(statusText, /Last review: unrecorded at 2026-06-10T00:00:00.000Z/);
    assert.match(statusText, /Retry state: 1 failure\(s\), nextDelayMs=30000/);
    assert.match(statusText, /Current project: .* unfinishedTasks=0 readyTasks=0/);
    assert.match(statusText, /Goal\/project relationship: Goal is session-scoped/);
    assert.doesNotMatch(statusText, /project_finish/);
    assert.match(statusText, /request goal\(\{ action: "complete" \}\)/);
    assert.doesNotMatch(statusText, /goal\(\{ action: "pause"/);
    assert.match(statusText, /autonomous pause is forbidden/);
    assert.doesNotMatch(statusText, /goal_complete/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("goal status explains absent durable goal against current project context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-status-no-goal-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);

    const status = await executeSparkTool(run.tools, "goal", ctx, { action: "status" });
    const statusText = toolText(status);
    assert.match(statusText, /No session goal is set in durable session state/);
    assert.match(statusText, /Current project: .* unfinishedTasks=0 readyTasks=0/);
    assert.match(statusText, /goal\(\{ action: "start" \}\)/);
    const relationship = status.details?.goalProjectRelationship as
      | { hasGoal?: boolean; binding?: string; currentProject?: { ref?: ProjectRef } }
      | undefined;
    assert.equal(relationship?.hasGoal, false);
    assert.equal(relationship?.binding, "current_project");
    assert.ok(relationship?.currentProject?.ref?.startsWith("proj:"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal restarts without overwriting an existing goal objective", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-no-overwrite-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");

    await goalCommand.handler("finish the original queue", ctx);
    await goalCommand.handler("replace with a different goal", ctx);

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, "finish the original queue");
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal handles stale inferred project goals after project work has no unfinished tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-stale-done-project-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Done goal project",
      description: "Already finished project.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    const staleObjective = `Advance project “${project.title}” to completion.\nUnfinished tasks: 3. Ready tasks: 2.`;
    await setSessionGoal(dir, ctx, {
      objective: staleObjective,
      source: "inferred",
      status: "active",
    });

    await goalCommand.handler("", ctx);

    let goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal, undefined);
    assert.equal(run.customMessages.length, 0);

    await setSessionGoal(dir, ctx, {
      objective: staleObjective,
      source: "inferred",
      status: "active",
    });
    await goalCommand.handler("review 全盘代码进行改进", ctx);

    goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, "review 全盘代码进行改进");
    assert.equal(goal?.source, "explicit");
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("session shutdown clears foreground timers without pausing active goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-shutdown-active-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("survive until reload", ctx);
    assert.equal((await loadSessionGoal(dir, ctx))?.status, "active");

    for (const handler of run.eventHandlers.get("session_shutdown") ?? []) {
      await handler({ reason: "reload" }, ctx);
    }

    const reloadedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(reloadedGoal?.status, "active");
    assert.equal(reloadedGoal?.pauseReason, undefined);
    assert.ok(timers.every((timer) => timer.cleared));

    const reloadedRun = registerSparkToolsForTest();
    const before = timers.length;
    for (const handler of reloadedRun.eventHandlers.get("session_start") ?? []) {
      await handler({ reason: "reload" }, ctx);
    }
    assert.ok(timers.length > before, "active goals should reschedule after reload");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/loop foreground driver persists, reschedules, and does not call reviewer completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-loop-foreground-driver-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => void;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const reviewerRunner: ReviewerRunner = {
      async review(input: ReviewInput): Promise<ReviewerRunResult> {
        reviewerCalls += 1;
        return createApprovingReviewerRunner().review(input);
      },
    };
    const run = registerSparkToolsForTest({ reviewerRunner });
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");

    await loopCommand.handler("Continue without completion review", ctx);
    const loop = await loadSessionLoop(dir, ctx);
    assert.equal(loop?.status, "active");
    assert.equal(loop?.objective, "Continue without completion review");
    assert.equal(run.customMessages.at(-1)?.customType, "spark-loop-request");
    assert.equal(run.customMessages.at(-1)?.details?.purpose, "foreground-loop-tick");
    assert.equal(reviewerCalls, 0);

    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(reviewerCalls, 0);
    assert.ok(timers.some((timer) => timer.delay === 30_000 && !timer.cleared));

    const messageCountBeforeScheduledTick = run.customMessages.length;
    timers.at(-1)?.callback();
    await flushAsyncWork();
    assert.ok(run.customMessages.length > messageCountBeforeScheduledTick);
    assert.equal(run.customMessages.at(-1)?.customType, "spark-loop-request");
    assert.equal(reviewerCalls, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal start clears an existing foreground loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-clears-loop-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    const goalCommand = run.commands.get("goal");
    assert.ok(loopCommand, "missing /loop command");
    assert.ok(goalCommand, "missing /goal command");

    await loopCommand.handler("Loop before goal", ctx);
    assert.equal((await loadSessionLoop(dir, ctx))?.status, "active");
    await goalCommand.handler("Goal replaces loop", ctx);
    assert.equal(await loadSessionLoop(dir, ctx), undefined);
    assert.equal((await loadSessionGoal(dir, ctx))?.objective, "Goal replaces loop");
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("session_start schedules goal instead of loop when both persisted states exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-session-start-mutual-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => void;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(until?: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (until?.()) return;
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await setSessionGoal(dir, ctx, {
      objective: "Persisted goal wins over loop",
      source: "explicit",
      status: "active",
    });
    await setSessionLoop(dir, ctx, {
      objective: "Persisted loop should not schedule",
      source: "explicit",
      status: "active",
    });
    const run = registerSparkToolsForTest();
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.filter((timer) => !timer.cleared).length, 1);
    timers[0]?.callback();
    await flushAsyncWork(() => run.customMessages.at(-1)?.customType === "spark-goal-request");
    assert.equal(run.customMessages.at(-1)?.customType, "spark-goal-request");
    for (const handler of run.eventHandlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/loop stop and pause aliases all persist paused state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-loop-pause-aliases-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");

    for (const alias of ["stop", "pause", "停止", "暂停", "停下"] as const) {
      await loopCommand.handler(`objective before ${alias}`, ctx);
      const active = await loadSessionLoop(dir, ctx);
      assert.equal(active?.status, "active");
      await loopCommand.handler(alias, ctx);
      const paused = await loadSessionLoop(dir, ctx);
      assert.equal(paused?.loopId, active?.loopId);
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.retryState, undefined);
      assert.match(paused?.pauseReason ?? "", /Paused by \/loop stop/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/loop foreground driver retries failures and pauses after retry budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-loop-retry-budget-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => void;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const reviewerRunner: ReviewerRunner = {
      async review(input: ReviewInput): Promise<ReviewerRunResult> {
        reviewerCalls += 1;
        return createApprovingReviewerRunner().review(input);
      },
    };
    const run = registerSparkToolsForTest({ reviewerRunner });
    await useOnlySparkProject(run.tools, ctx);
    const loopCommand = run.commands.get("loop");
    assert.ok(loopCommand, "missing /loop command");
    await loopCommand.handler("Retry failing loop turn", ctx);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      for (const handler of run.eventHandlers.get("agent_end") ?? []) {
        await handler({ errorMessage: `loop failure ${attempt}`, messages: [] }, ctx);
      }
      const loop = await loadSessionLoop(dir, ctx);
      assert.equal(reviewerCalls, 0);
      if (attempt < 5) {
        assert.equal(loop?.status, "active");
        assert.equal(loop?.retryState?.consecutiveFailures, attempt);
        assert.equal(timers.at(-1)?.delay, [30_000, 60_000, 120_000, 120_000][attempt - 1]);
        timers.at(-1)?.callback();
        await flushAsyncWork();
        assert.equal(run.customMessages.at(-1)?.customType, "spark-loop-request");
      } else {
        assert.equal(loop?.status, "paused");
        assert.equal(loop?.retryState?.consecutiveFailures, 5);
        assert.ok(loop?.retryState?.exhaustedAt);
        assert.match(loop?.pauseReason ?? "", /retry budget exhausted/);
      }
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop reschedules active goal on session_start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-session-start-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  let restartedRun: ReturnType<typeof registerSparkToolsForTest> | undefined;
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const setupRun = registerSparkToolsForTest();
    await useOnlySparkProject(setupRun.tools, ctx);
    await executeSparkTool(setupRun.tools, "goal", ctx, {
      action: "start",
      objective: "Resume persisted goal after host restart",
    });
    assert.equal(timers.length, 0, "starting via goal tool persists state but does not schedule");

    restartedRun = registerSparkToolsForTest();
    for (const handler of restartedRun.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, 30_000);

    const messageCountBeforeTick = restartedRun.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();

    assert.ok(restartedRun.customMessages.length > messageCountBeforeTick);
    assert.equal(isForegroundGoalTickMessage(restartedRun.customMessages.at(-1)), true);
    assert.equal(restartedRun.customMessages.at(-1)?.display, false);
    assert.equal(restartedRun.customMessages.at(-1)?.options?.deliverAs, "followUp");
  } finally {
    if (restartedRun) {
      const ctx = testSparkContext(dir, "main");
      for (const handler of restartedRun.eventHandlers.get("session_shutdown") ?? []) {
        await handler({}, ctx);
      }
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop does not duplicate awaiting continuations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-awaiting-no-duplicate-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Avoid duplicate continuation dispatches",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);

    timers[0]?.callback();
    await flushAsyncWork();
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    const messageCountAfterTick = run.customMessages.length;

    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }

    assert.equal(
      run.customMessages.length,
      messageCountAfterTick,
      "session_start while awaiting must not dispatch another hidden continuation",
    );
    assert.equal(timers.length, 2, "completed awaited turn schedules exactly one next tick");
    assert.equal(timers[1]?.delay, 30_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop cancels scheduled tick when a user turn starts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-user-turn-cancel-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Wait for actual user idle before ticking",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.cleared, false);

    for (const handler of run.eventHandlers.get("turn_start") ?? []) {
      await handler({}, ctx);
    }

    assert.equal(timers[0]?.cleared, true, "user turns clear the scheduled goal tick timer");
    assert.equal(run.customMessages.some(isForegroundGoalTickMessage), false);

    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }

    assert.equal(timers.length, 2, "ordinary completed turns re-arm idle goal ticks");
    assert.equal(timers[1]?.delay, 30_000);
    assert.equal(
      run.customMessages.some(isForegroundGoalTickMessage),
      false,
      "re-arming after a user turn must not tick immediately",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop drops stale tick context after pause", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-drop-stale-tick-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(until?: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (until?.()) return;
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Drop stale tick after pause",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork(() => isForegroundGoalTickMessage(run.customMessages.at(-1)));
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");

    const rejectedPause = await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "stop before hidden tick context is consumed",
    });

    assert.equal(
      (rejectedPause.details as { error?: string }).error,
      "autonomous_goal_pause_forbidden",
    );
    assert.equal(run.customMessages.at(-1)?.details?.purpose, "foreground-goal-tick");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop ignores stale awaited-turn completions after replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-ignore-stale-awaiting-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(until?: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (until?.()) return;
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Old goal awaiting turn",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork(() => isForegroundGoalTickMessage(run.customMessages.at(-1)));
    const oldGoal = await loadSessionGoal(dir, ctx);
    assert.ok(oldGoal);
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "clear",
    });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Replacement goal must stay clean",
    });
    const replacementGoal = await loadSessionGoal(dir, ctx);
    assert.ok(replacementGoal);
    assert.notEqual(replacementGoal.goalId, oldGoal.goalId);

    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler(
        {
          usage: { inputTokens: 100, outputTokens: 200 },
          messages: [{ role: "assistant", stopReason: "stop" }],
        },
        ctx,
      );
    }

    const currentGoal = await loadSessionGoal(dir, ctx);
    assert.equal(currentGoal?.goalId, replacementGoal.goalId);
    assert.equal(currentGoal?.status, "active");
    assert.equal(timers.length, 1, "stale completion must not schedule another tick");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop completes active goal when reviewer says achieved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-review-achieved-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Already verified objective",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    const messagesBefore = run.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(reviewerCalls, 1);
    assert.equal(run.customMessages.length, messagesBefore);
    const goal = await loadSessionGoal(dir, ctx);
    assert.ok(goal);
    assert.equal(goal.status, "complete");
    const goalReviewArtifactRef = goal.lastReviewArtifactRef;
    assert.ok(goalReviewArtifactRef);
    assert.ok(goal.lastReviewedAt);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 1);
    const reviewDir = goalReviewDirectory(dir, goal);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; artifactRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "goal");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, goal.goalId);
    assert.equal(reviewIndex.reviews[0]?.artifactRef, goalReviewArtifactRef);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, goalReviewArtifactRef), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "goal");
    assert.equal(subjectReview.subjectRef, goal.goalId);
    assert.equal(subjectReview.outcome, "approved");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop includes completed current project evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-completed-project-evidence-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const evidence = await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Completed project closure evidence",
      format: "markdown",
      body: "All tasks are done and validated.",
      provenance: { producer: "task" },
    });
    let completedProjectRef: ProjectRef | undefined;
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      completedProjectRef = project.ref;
      await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
      await saveCurrentProjectRef(dir, ctx, project.ref);
      const task = graph.createTask({
        projectRef: project.ref,
        name: "completed-evidence-task",
        title: "Completed evidence task",
        description: "Produce closure evidence for the project.",
        status: "done",
        plan: executionReadyPlan("Completed evidence task"),
      });
      graph.attachOutputArtifact(task.ref, evidence.ref);
    });
    let reviewerInput: ReviewInput | undefined;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerInput = input;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Complete broad review after project closes",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(reviewerInput?.targetKind, "goal");
    if (reviewerInput?.targetKind !== "goal") assert.fail("expected goal review input");
    assert.equal(reviewerInput.projectRef, completedProjectRef);
    assert.equal(reviewerInput.currentProjectSelected, true);
    assert.equal(reviewerInput.projectEvidenceSource, "current_project");
    assert.equal(reviewerInput.projectStatus?.taskCounts.total, 1);
    assert.equal(reviewerInput.projectStatus?.taskCounts.unfinished, 0);
    assert.deepEqual(reviewerInput.evidenceRefs, [evidence.ref]);
    assert.equal(reviewerInput.evidencePreviews?.[0]?.ref, evidence.ref);
    assert.equal(reviewerInput.evidencePreviews?.[0]?.title, "Completed project closure evidence");
    assert.match(reviewerInput.evidencePreviews?.[0]?.bodyPreview ?? "", /All tasks are done/);
    const reviewArtifact = await defaultArtifactStore(dir).get(
      (await defaultArtifactStore(dir).list({ kind: "record" })).at(-1)!.ref,
    );
    const reviewBody = reviewArtifact.body as {
      reviewPacket?: {
        projectRef?: ProjectRef;
        currentProjectSelected?: boolean;
        projectEvidenceSource?: string;
        evidenceRefs?: string[];
        evidencePreviews?: Array<{ ref?: string; title?: string; bodyPreview?: string }>;
      };
    };
    assert.equal(reviewBody.reviewPacket?.projectRef, completedProjectRef);
    assert.equal(reviewBody.reviewPacket?.currentProjectSelected, true);
    assert.equal(reviewBody.reviewPacket?.projectEvidenceSource, "current_project");
    assert.deepEqual(reviewBody.reviewPacket?.evidenceRefs, [evidence.ref]);
    assert.equal(reviewBody.reviewPacket?.evidencePreviews?.[0]?.ref, evidence.ref);
    assert.match(
      reviewBody.reviewPacket?.evidencePreviews?.[0]?.bodyPreview ?? "",
      /All tasks are done/,
    );
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop blocks completion when project tasks remain unfinished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-unfinished-project-blocker-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let projectRef: ProjectRef | undefined;
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      projectRef = project.ref;
      await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
      await saveCurrentProjectRef(dir, ctx, project.ref);
      graph.createTask({
        projectRef: project.ref,
        name: "unfinished-ready-task",
        title: "Unfinished ready task",
        description: "This task remains pending and should block goal completion.",
        status: "pending",
        plan: executionReadyPlan("Unfinished ready task"),
      });
    });
    assert.ok(projectRef);
    let reviewerCalls = 0;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Finish the role model settings project implementation",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork();

    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.ok(goal?.lastReviewedAt);
    assert.equal(goal?.lastReviewArtifactRef, undefined);
    assert.equal(reviewerCalls, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop includes project-scoped review artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-project-review-artifact-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let projectRef: ProjectRef | undefined;
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      projectRef = project.ref;
      await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
      await saveCurrentProjectRef(dir, ctx, project.ref);
    });
    assert.ok(projectRef);
    const projectReview = await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Project planning readiness review",
      format: "markdown",
      body: "The project plan is reviewed and execution-ready.",
      provenance: { producer: "review", projectRef },
    });
    let reviewerInput: ReviewInput | undefined;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerInput = input;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Complete after project-scoped plan review evidence is visible",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(reviewerInput?.targetKind, "goal");
    assert.equal(reviewerInput?.projectRef, projectRef);
    assert.ok(reviewerInput?.evidenceRefs.includes(projectReview.ref));
    assert.ok(
      reviewerInput?.targetKind === "goal" &&
        reviewerInput.evidencePreviews?.some(
          (preview) =>
            preview.ref === projectReview.ref &&
            /project plan is reviewed/.test(preview.bodyPreview ?? ""),
        ),
    );
    const reviewArtifact = await defaultArtifactStore(dir).get(
      (await defaultArtifactStore(dir).list({ kind: "record" })).at(-1)!.ref,
    );
    const reviewBody = reviewArtifact.body as {
      reviewPacket?: {
        evidenceRefs?: string[];
        evidencePreviews?: Array<{ ref?: string; bodyPreview?: string }>;
      };
    };
    assert.ok(reviewBody.reviewPacket?.evidenceRefs?.includes(projectReview.ref));
    assert.ok(
      reviewBody.reviewPacket?.evidencePreviews?.some(
        (preview) =>
          preview.ref === projectReview.ref &&
          /project plan is reviewed/.test(preview.bodyPreview ?? ""),
      ),
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop records unmet reviewer verdict before continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-review-unmet-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createRejectingReviewerRunner("goal needs one more verified task").review(input);
        },
      },
    });
    await useOnlySparkProject(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Need more work",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    const messagesBefore = run.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(reviewerCalls, 1);
    assert.ok(run.customMessages.length > messagesBefore);
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    const goal = await loadSessionGoal(dir, ctx);
    assert.ok(goal);
    assert.equal(goal.status, "active");
    const goalReviewArtifactRef = goal.lastReviewArtifactRef;
    assert.ok(goalReviewArtifactRef);
    assert.ok(goal.lastReviewedAt);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 1);
    const reviewDir = goalReviewDirectory(dir, goal);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; artifactRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "goal");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, goal.goalId);
    assert.equal(reviewIndex.reviews[0]?.artifactRef, goalReviewArtifactRef);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, goalReviewArtifactRef), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "goal");
    assert.equal(subjectReview.subjectRef, goal.goalId);
    assert.equal(subjectReview.outcome, "needs_changes");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop defers while task finish review is running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-defers-task-review-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let resolveTaskReview: ((value: ReviewerRunResult) => void) | undefined;
    let taskReviewerCalls = 0;
    let goalReviewerCalls = 0;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          if (input.targetKind === "task") {
            taskReviewerCalls += 1;
            return new Promise((resolve) => {
              resolveTaskReview = resolve;
            });
          }
          goalReviewerCalls += 1;
          return createRejectingReviewerRunner("goal should wait for task review").review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(run.tools, ctx);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Goal waits while task review runs",
    });
    await planAndClaimTask(run.tools, ctx, {
      name: "finish-review-lease",
      title: "Finish review lease",
      description: "Task finish reviewer should hold the shared reviewer lease.",
      plan: executionReadyPlan("Finish review lease"),
      todos: ["Run finish review reviewer flow"],
    });
    await executeSparkTool(run.tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Run finish review reviewer flow"] },
        { op: "done", item: "Run finish review reviewer flow" },
      ],
    });

    const finishPromise = executeSparkTool(run.tools, "impl_finish_task", ctx, {
      summary: "Complete after task review resolves.",
    });
    await flushAsyncWork();
    assert.equal(taskReviewerCalls, 1);
    assert.equal(goalReviewerCalls, 0);

    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(goalReviewerCalls, 0);
    assert.equal(timers.length, 2, "goal tick should reschedule instead of starting reviewer");
    resolveTaskReview?.(
      await createApprovingReviewerRunner().review({
        targetKind: "task",
        cwd: dir,
        projectRef: "proj:test" as ProjectRef,
        task: (await defaultTaskGraphStore(dir).load())!.tasks()[0]!,
        requestedStatus: "done",
        evidenceRefs: [],
      }),
    );
    const finished = await finishPromise;
    assert.match(toolText(finished), /Finished Spark task/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("goal reviewer state machine covers restart, idle review, and task finish gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-reviewer-state-machine-e2e-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(until?: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
      if (until?.()) return;
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  async function waitForGoalStatus(status: "active" | "complete") {
    for (let index = 0; index < 100; index += 1) {
      const goal = await loadSessionGoal(dir, testSparkContext(dir, "main"));
      if (goal?.status === status) return goal;
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
    return await loadSessionGoal(dir, testSparkContext(dir, "main"));
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const goalOutcomes: Array<"unmet" | "achieved"> = ["unmet", "achieved"];
    let rejectTaskFinish = true;
    let goalReviewerCalls = 0;
    let taskReviewerCalls = 0;
    const reviewerRunner: ReviewerRunner = {
      async review(input: ReviewInput): Promise<ReviewerRunResult> {
        if (input.targetKind === "goal") {
          if (input.requestedStatus === "paused")
            return createApprovingReviewerRunner().review(input);
          goalReviewerCalls += 1;
          const outcome = goalOutcomes.shift() ?? "achieved";
          return outcome === "achieved"
            ? createApprovingReviewerRunner().review(input)
            : createRejectingReviewerRunner("project goal still needs one task").review(input);
        }
        taskReviewerCalls += 1;
        return rejectTaskFinish
          ? createRejectingReviewerRunner("task finish needs revision").review(input)
          : createApprovingReviewerRunner().review(input);
      },
    };

    const run = registerSparkToolsForTest({ reviewerRunner });
    await useOnlySparkProjectInExplicitPlanMode(run.tools, ctx);

    const sessionStarted = await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Session goal for state-machine e2e",
    });
    assert.match(toolText(sessionStarted), /Spark session goal active/);

    const restarted = registerSparkToolsForTest({ reviewerRunner });
    for (const handler of restarted.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, 30_000);

    const messagesBeforeUnmet = restarted.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork(
      () => goalReviewerCalls === 1 && restarted.customMessages.length > messagesBeforeUnmet,
    );
    assert.equal(goalReviewerCalls, 1);
    assert.ok(restarted.customMessages.length > messagesBeforeUnmet);
    assert.equal(restarted.customMessages.at(-1)?.display, false);
    assert.equal(restarted.customMessages.at(-1)?.options?.deliverAs, "followUp");
    let goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.ok(goal?.lastReviewArtifactRef);
    assert.ok(goal?.lastReviewedAt);

    for (const handler of restarted.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 2);
    const messagesBeforeAchieved = restarted.customMessages.length;
    timers[1]?.callback();
    await flushAsyncWork(() => goalReviewerCalls === 2);
    assert.equal(goalReviewerCalls, 2);
    assert.equal(restarted.customMessages.length, messagesBeforeAchieved);
    goal = await waitForGoalStatus("complete");
    assert.equal(goal?.status, "complete");
    assert.ok(goal?.lastReviewArtifactRef);

    await planAndClaimTask(run.tools, ctx, {
      name: "e2e-task-finish-gate",
      title: "E2E task finish gate",
      description: "Task finish should reject then approve through the reviewer gate.",
      plan: executionReadyPlan("E2E task finish gate"),
      todos: ["Validate task finish reviewer gate"],
    });
    await executeSparkTool(run.tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate task finish reviewer gate"] },
        { op: "done", item: "Validate task finish reviewer gate" },
      ],
    });
    const rejected = await executeSparkTool(run.tools, "impl_finish_task", ctx, {
      summary: "First finish attempt should be rejected.",
    });
    assert.equal((rejected.details as { error?: string }).error, "task_review_failed");
    assert.match(toolText(rejected), /task finish needs revision/);

    rejectTaskFinish = false;
    const finished = await executeSparkTool(run.tools, "impl_finish_task", ctx, {
      summary: "Second finish attempt is approved.",
    });
    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal(taskReviewerCalls, 2);

    const reviews = await defaultArtifactStore(dir).list({ kind: "record" });
    assert.equal(
      reviews.length,
      3,
      "one rolling goal review artifact and two task finish reviews are persisted",
    );
    const goalReview = reviews.find((review) => review.ref.startsWith("artifact:goal-review-"));
    assert.ok(goalReview, "goal reviews should use a stable rolling artifact ref");
    const goalReviewArtifact = await defaultArtifactStore(dir).get(goalReview.ref);
    assert.equal(
      (goalReviewArtifact.body as { reviews?: unknown[] }).reviews?.length,
      2,
      "rolling goal review artifact keeps both goal review entries",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop backs off and pauses after retry budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-retry-budget-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("retry bounded goal", ctx);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 1);

    const expectedDelays = [30_000, 60_000, 120_000, 120_000];
    for (let failureIndex = 0; failureIndex < 5; failureIndex += 1) {
      timers.at(-1)?.callback();
      await flushAsyncWork();
      for (const handler of run.eventHandlers.get("turn_end") ?? []) {
        await handler(
          {
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: `transient failure ${failureIndex + 1}`,
            },
          },
          ctx,
        );
      }
      for (const handler of run.eventHandlers.get("agent_end") ?? []) {
        await handler(
          {
            messages: [
              {
                role: "assistant",
                stopReason: "error",
                errorMessage: `transient failure ${failureIndex + 1}`,
              },
            ],
          },
          ctx,
        );
      }
      if (failureIndex < expectedDelays.length) {
        assert.equal(timers.at(-1)?.delay, expectedDelays[failureIndex]);
      }
    }

    const goalStatePath = sessionGoalPath(dir, ctx);
    await waitFor(async () => {
      const state = JSON.parse(await readFile(goalStatePath, "utf8")) as {
        goal?: { status?: string; retryState?: { consecutiveFailures?: number } };
      };
      return state.goal?.status === "paused" && state.goal.retryState?.consecutiveFailures === 5;
    });
    const failedGoalState = JSON.parse(await readFile(goalStatePath, "utf8")) as {
      goal?: {
        status?: string;
        pauseReason?: string;
        retryState?: { consecutiveFailures?: number; exhaustedAt?: string };
      };
    };
    assert.equal(failedGoalState.goal?.status, "paused");
    assert.match(failedGoalState.goal?.pauseReason ?? "", /retry budget exhausted/);
    assert.equal(failedGoalState.goal?.retryState?.consecutiveFailures, 5);
    assert.ok(failedGoalState.goal?.retryState?.exhaustedAt);
    assert.equal(
      ctx.notifications.some((notification) => /retry 1\/5/.test(notification.message)),
      false,
    );
    assert.ok(
      ctx.notifications.some((notification) => /retry budget exhausted/.test(notification.message)),
    );
    assert.equal(timers.length, 5);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop pauses without retry after manual abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-manual-abort-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback();
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("abort should not retry", ctx);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 1);

    timers[0]?.callback();
    await flushAsyncWork();
    for (const handler of run.eventHandlers.get("turn_end") ?? []) {
      await handler(
        {
          message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" },
        },
        ctx,
      );
    }
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler(
        {
          messages: [
            { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" },
          ],
        },
        ctx,
      );
    }

    const abortedGoalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: {
        status?: string;
        pauseReason?: string;
        retryState?: { consecutiveFailures?: number };
      };
    };
    assert.equal(abortedGoalState.goal?.status, "paused");
    assert.match(abortedGoalState.goal?.pauseReason ?? "", /manual abort/);
    assert.equal(abortedGoalState.goal?.retryState, undefined);
    assert.equal(
      ctx.notifications.some((notification) => /retry \d\/5/.test(notification.message)),
      false,
    );
    assert.equal(timers.length, 1, "manual abort must not schedule a retry timer");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop clears retry state after successful turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-retry-reset-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("retry reset goal", ctx);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }

    timers[0]?.callback();
    await flushAsyncWork();
    for (const handler of run.eventHandlers.get("turn_end") ?? []) {
      await handler(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "first transient failure",
          },
        },
        ctx,
      );
    }
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler(
        {
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "first transient failure" },
          ],
        },
        ctx,
      );
    }
    const retryGoalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: { retryState?: { consecutiveFailures?: number } };
    };
    assert.equal(retryGoalState.goal?.retryState?.consecutiveFailures, 1);

    timers[1]?.callback();
    await flushAsyncWork();
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    const resetGoalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: { status?: string; retryState?: unknown };
    };
    assert.equal(resetGoalState.goal?.status, "active");
    assert.equal(resetGoalState.goal?.retryState, undefined);
    assert.equal(timers.at(-1)?.delay, 30_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop waits for idle and stops after pause", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-tick-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let idleWaits = 0;
    ctx.waitForIdle = async () => {
      idleWaits += 1;
    };
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("finish active goal work", ctx);
    assert.equal(timers.length, 0);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, 30_000);

    const messageCountBeforeTick = run.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(idleWaits, 1);
    assert.equal(run.customMessages.length, messageCountBeforeTick);
    assert.equal(timers.length, 2);
    assert.equal(timers[1]?.delay, 30_000);

    timers[1]?.callback();
    await flushAsyncWork();
    assert.ok(run.customMessages.length > messageCountBeforeTick);
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    assert.equal(timers.length, 2);

    for (const handler of run.eventHandlers.get("turn_end") ?? []) {
      await handler({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    }
    assert.equal(timers.length, 2);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 3);
    assert.equal(timers[2]?.delay, 30_000);

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "waiting for review",
    });
    for (const handler of run.eventHandlers.get("tool_execution_end") ?? []) {
      await handler({ toolName: "goal", params: { action: "pause" } }, ctx);
    }
    assert.equal(timers[2]?.cleared, true);
    const messageCountAfterPause = run.customMessages.length;
    timers[2]?.callback();
    await flushAsyncWork();

    assert.equal(run.customMessages.length, messageCountAfterPause);
    assert.equal(idleWaits, 1);
    assert.equal(timers.length, 3);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 3);

    await goalCommand.handler("finish failed goal work", ctx);
    assert.equal(timers.length, 3);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 4);
    timers[3]?.callback();
    await flushAsyncWork();
    assert.equal(idleWaits, 2);
    assert.equal(timers.length, 5);
    timers[4]?.callback();
    await flushAsyncWork();
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    for (const handler of run.eventHandlers.get("turn_end") ?? []) {
      await handler(
        {
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Context overflow recovery failed: invalidated oauth token",
          },
        },
        ctx,
      );
    }
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler(
        {
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Context overflow recovery failed: invalidated oauth token",
            },
          ],
        },
        ctx,
      );
    }
    const failedGoalState = JSON.parse(await readFile(sessionGoalPath(dir, ctx), "utf8")) as {
      goal?: { status?: string; lastReview?: unknown; lastReviewedAt?: string };
    };
    assert.equal(failedGoalState.goal?.status, "active");
    assert.equal(failedGoalState.goal?.lastReview, undefined);
    assert.ok(failedGoalState.goal?.lastReviewedAt);
    assert.equal(timers.length, 6);
    assert.equal(timers[5]?.delay, 30_000);

    await goalCommand.handler("finish complete goal work", ctx);
    assert.equal(timers.length, 6);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 7);
    assert.equal(timers[5]?.cleared, true);
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "verified stop after test",
    });
    const messageCountAfterComplete = run.customMessages.length;
    timers[6]?.callback();
    await flushAsyncWork();

    assert.equal(run.customMessages.length, messageCountAfterComplete);
    assert.equal(idleWaits, 2);
    assert.equal(timers.length, 7);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop defers ticks while compaction is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-compaction-gate-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;

  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
  }

  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await useOnlySparkProject(run.tools, ctx);
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    await goalCommand.handler("avoid compaction overlap", ctx);
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 1);

    const messageCountBeforeCompactionTick = run.customMessages.length;
    const compactionAbort = new AbortController();
    for (const handler of run.eventHandlers.get("session_before_compact") ?? []) {
      await handler({ signal: compactionAbort.signal }, ctx);
    }

    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(
      run.customMessages.length,
      messageCountBeforeCompactionTick,
      "goal tick must not dispatch while session compaction is active",
    );
    assert.equal(timers.length, 2);
    assert.equal(timers[1]?.delay, 30_000);

    for (const handler of run.eventHandlers.get("session_compact") ?? []) {
      await handler({ compactionEntry: { id: "entry:compact" } }, ctx);
    }
    assert.equal(timers[1]?.cleared, true);
    assert.equal(timers.length, 3);

    timers[2]?.callback();
    await flushAsyncWork();

    assert.ok(run.customMessages.length > messageCountBeforeCompactionTick);
    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("Shift+Tab shortcut shows per-turn Spark mode hints without persisting mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-shift-tab-mode-"));
  const inactiveDir = await mkdtemp(join(tmpdir(), "spark-shift-tab-inactive-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const shortcut = run.shortcuts.get("shift+tab");
    assert.ok(shortcut, "missing Shift+Tab Spark mode shortcut");
    assert.equal(shortcut.isActive?.(testSparkContext(inactiveDir, "main")), false);
    assert.equal(shortcut.isActive?.(ctx), true);

    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Tool persistence" });
    assert.equal((await loadSparkMode(dir, ctx)).mode, "research");

    await shortcut.handler(ctx);
    assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    assert.equal(ctx.editorText, "/plan ");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(inactiveDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_plan_tasks blocks underspecified executable tasks without opening a canned ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-not-ready-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("impl_plan_tasks should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("impl_plan_tasks should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "clarify-plan",
          title: "Clarify underspecified plan",
          description: "Exercise task plan readiness validation.",
          kind: "implement",
        },
      ],
    });

    const details = planned.details as
      | {
          error?: string;
          planDecision?: {
            asked?: boolean;
            accepted?: boolean;
            blocked?: boolean;
            summary?: string;
          };
        }
      | undefined;
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.planDecision?.asked, false);
    assert.equal(details?.planDecision?.accepted, false);
    assert.equal(details?.planDecision?.blocked, true);
    assert.match(details?.planDecision?.summary ?? "", /fix: Add at least one observable entry/);
    assert.match(toolText(planned), /Task plan not ready: @clarify-plan/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks rejects standalone design/planning tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-not-concrete-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "background-role-results-design",
          title: "设计 DAG 子 agent 完成结果的用户/父 agent 可见机制",
          description: "Decide how background child role-run results should be visible.",
          kind: "implement",
          status: "pending",
          plan: executionReadyPlan("Decide result visibility."),
        },
      ],
    });

    assert.match(toolText(planned), /task_not_concrete/);
    assert.match(toolText(planned), /standalone design\/planning/);
    assert.match(toolText(planned), /embed the chosen design in each concrete task\.plan/);
    assert.equal((planned.details as { error?: string }).error, "task_not_concrete");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "invalid-kind",
              title: "Invalid kind",
              description: "Invalid kind must not become a generic task.",
              kind: "build",
              plan: executionReadyPlan("Reject invalid kind"),
            },
          ],
        }),
      /kind must be research, implement, or review/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "project-ref-as-kind",
              title: "Project ref as kind",
              description: "Project refs should be passed via project/projectRef.",
              kind: "proj:demo-project",
              plan: executionReadyPlan("Reject project ref passed as kind"),
            },
          ],
        }),
      /kind received a project ref/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              name: "invalid-status",
              title: "Invalid status",
              description: "Invalid status must be rejected.",
              status: "waiting",
              plan: executionReadyPlan("Reject invalid status"),
            },
          ],
        }),
      /status must be pending, ready, running, blocked, done, failed, or cancelled/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: 42,
              description: "Invalid title must not be trusted.",
              plan: executionReadyPlan("Reject invalid title."),
            },
          ],
        }),
      /tasks\[0\]\.title must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid dependency",
              description: "Invalid dependency must not reach graph planning.",
              dependsOn: [123],
              plan: executionReadyPlan("Reject invalid dependency."),
            },
          ],
        }),
      /tasks\[0\]\.dependsOn must be an array of strings/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid risk",
              description: "Invalid plan risk must not be downgraded to normal.",
              plan: { ...executionReadyPlan("Reject invalid risk."), riskLevel: "urgent" },
            },
          ],
        }),
      /tasks\[0\]\.plan\.riskLevel must be trivial, normal, or high/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_plan_tasks", ctx, {
          tasks: [
            {
              title: "Invalid role",
              description: "Invalid role ref must not be ignored.",
              roleRef: 42,
              plan: executionReadyPlan("Reject invalid role."),
            },
          ],
        }),
      /tasks\[0\]\.roleRef must be a string/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks accepts cancelled cleanup tasks without success/evidence readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancelled-plan-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "retire-placeholder",
          title: "Retire placeholder task",
          description:
            "Historical placeholder that should be cancelled without execution evidence.",
          status: "cancelled",
        },
      ],
    });

    const details = planned.details as
      | { planDecisions?: Array<{ asked?: boolean; accepted?: boolean; blocked?: boolean }> }
      | undefined;
    assert.equal(details?.planDecisions?.[0]?.asked, false);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[0]?.blocked, false);
    assert.match(toolText(planned), /Planned tasks: created=1 updated=0/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks()[0];
    assert.equal(task?.status, "cancelled");
    assert.equal(task?.plan?.successCriteria.length, 0);
    assert.equal(task?.plan?.evidenceRequired.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks refuses to cancel tasks that still have dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancel-dependent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const prerequisite = graph.createTask({
        projectRef: project.ref,
        name: "kept-prereq",
        title: "Kept prerequisite",
        description: "A prerequisite that is still depended on.",
        status: "pending",
        plan: executionReadyPlan("Keep prerequisite"),
      });
      const dependent = graph.createTask({
        projectRef: project.ref,
        name: "dependent-work",
        title: "Dependent work",
        description: "Depends on the kept prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const before = await taskGraphSnapshotText(dir);
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "kept-prereq",
          title: "Kept prerequisite",
          description: "A prerequisite that is still depended on.",
          kind: "implement",
          status: "cancelled",
        },
      ],
    });

    assert.match(toolText(planned), /Task plan dependency error/);
    assert.match(toolText(planned), /cannot be cancelled/);
    assert.equal((planned.details as { error?: string }).error, "task_dependency_error");
    assert.equal(await taskGraphSnapshotText(dir), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task explains how to create or select a project when none exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-no-project-hint-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "claim-without-project",
      title: "Claim without project",
      description: "Claim should report an actionable project setup hint.",
      kind: "implement",
    });

    assert.equal((claimed.details as { found?: boolean }).found, false);
    assert.match(toolText(claimed), /No Spark project found\./);
    assert.match(toolText(claimed), /Create or select a project/);
    assert.match(
      toolText(claimed),
      /task_write\(\{ action: "project_use", title, description \}\)/,
    );
    assert.doesNotMatch(toolText(claimed), /\/spark/);
    assert.equal(existsSync(join(dir, ".spark", "projects.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task can claim an existing named task without title or description", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-existing-by-name-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "existing-named-task",
      title: "Existing named task",
      description: "Existing task fields should be inherited by name-only claim.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Existing task fields should be inherited by name-only claim."),
    });
    await defaultTaskGraphStore(dir).save(graph);

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "existing-named-task",
    });

    assert.match(
      toolText(claimed),
      /Claimed Spark task: @existing-named-task: Existing named task/,
    );
    assert.match(toolText(claimed), /Task plan items are present for this claim/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks(project.ref)[0];
    assert.equal(task?.title, "Existing named task");
    assert.equal(task?.description, "Existing task fields should be inherited by name-only claim.");
    assert.equal(task?.claim?.sessionId, ctxSessionKey(ctx));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status surfaces foreign-claim recovery guidance for blocked ready frontier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-stale-claim-guidance-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "status-stale-claim",
      title: "Status stale claim",
      description: "Status should explain how a foreign claim blocks the ready frontier.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Surface stale-claim recovery guidance in status."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      leaseMs: 60_000,
    });
    await store.save(graph);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});

    assert.match(
      toolText(status),
      /Recovery: ready_frontier is blocked by 1 other-session claimed task/,
    );
    assert.match(
      toolText(status),
      /reclaim with task_write\(\{ action: "claim", task: "@name" \}\)/,
    );
    const renderedProject = (
      status.details as {
        renderedProjects?: Array<{
          ref?: string;
          claimRecovery?: Array<{ name?: string; expired?: boolean; workflowIdle?: boolean }>;
        }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(renderedProject?.claimRecovery?.[0]?.name, "status-stale-claim");
    assert.equal(renderedProject?.claimRecovery?.[0]?.expired, false);
    assert.equal(renderedProject?.claimRecovery?.[0]?.workflowIdle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task recovers an expired foreign claim when background work is idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recover-expired-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "recover-expired-claim",
      title: "Recover expired claim",
      description:
        "Expired foreign claim should be safely recoverable when background work is idle.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Recover an expired foreign claim safely."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.save(graph);

    const claimed = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    assert.match(toolText(claimed), /Recovered previous task claim: claim_expired/);
    assert.match(toolText(claimed), /Recovery evidence: artifact:/);
    const details = claimed.details as {
      recoveredClaimArtifactRef?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.equal(details.claimRecovery?.recoverable, true);
    assert.equal(details.claimRecovery?.reason, "claim_expired");
    assert.match(details.recoveredClaimArtifactRef ?? "", /^artifact:/);
    const recovered = (await store.load())?.getTask(task.ref);
    assert.equal(recovered?.claim?.sessionId, ctxSessionKey(ctx));
    assert.equal(recovered?.status, "running");
    const artifact = await defaultArtifactStore(dir).get(
      details.recoveredClaimArtifactRef as ArtifactRef,
    );
    const body = artifact.body as {
      previousClaim?: { claimedBy?: string };
      decision?: { reason?: string };
    };
    assert.equal(body.previousClaim?.claimedBy, "session:old-owner");
    assert.equal(body.decision?.reason, "claim_expired");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task_write recover requeues needs_changes inactive-owner claim without marking done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-recover-needs-changes-requeue-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "recover-needs-changes",
      title: "Recover needs changes",
      description: "Recover a needs_changes task with evidence without marking it done.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Recover a needs_changes inactive-owner claim."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 365 * 24 * 60 * 60 * 1_000,
    });
    const evidence = await defaultArtifactStore(dir).put({
      kind: "document",
      title: "Final evidence that still needs review changes",
      format: "markdown",
      body: "# Evidence\n\nThe work has evidence but still received needs_changes.",
      provenance: { producer: "task", projectRef: project.ref, taskRef: task.ref },
    });
    graph.attachOutputArtifact(task.ref, evidence.ref);
    await store.save(graph);
    await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Task finish review for @recover-needs-changes",
      format: "json",
      body: { verdict: { outcome: "needs_changes", summary: "Still needs changes." } },
      provenance: { producer: "review", projectRef: project.ref, taskRef: task.ref },
    });

    const before = await executeSparkTool(tools, "impl_status", ctx, {});
    const beforeProject = (
      before.details as {
        renderedProjects?: Array<{ ref?: string; taskCounts?: { ready?: number } }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(beforeProject?.taskCounts?.ready, 0);

    const recovered = await executeSparkTool(tools, "task_write", ctx, {
      action: "recover",
      taskRef: task.ref,
    });

    assert.match(toolText(recovered), /Recovered Spark task claim: @recover-needs-changes/);
    assert.match(toolText(recovered), /Reason: review_needs_changes_owner_inactive/);
    assert.match(
      toolText(recovered),
      /Task is now unclaimed and can re-enter the ready frontier; it was not marked done/,
    );
    const recoveredDetails = recovered.details as {
      recoveredClaimArtifactRef?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.match(recoveredDetails.recoveredClaimArtifactRef ?? "", /^artifact:/);
    assert.equal(recoveredDetails.claimRecovery?.recoverable, true);
    assert.equal(recoveredDetails.claimRecovery?.reason, "review_needs_changes_owner_inactive");

    const after = await executeSparkTool(tools, "impl_status", ctx, {});
    const afterProject = (
      after.details as {
        renderedProjects?: Array<{ ref?: string; taskCounts?: { ready?: number } }>;
      }
    ).renderedProjects?.find((candidate) => candidate.ref === project.ref);
    assert.equal(afterProject?.taskCounts?.ready, 1);
    const reloaded = (await store.load())?.getTask(task.ref);
    assert.equal(reloaded?.status, "pending");
    assert.equal(reloaded?.claim, undefined);
    assert.equal(reloaded?.outputArtifacts.includes(evidence.ref), true);
    assert.notEqual(reloaded?.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task refuses stale-claim recovery while workflow work is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-recovery-active-workflow-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const project = graph.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "refuse-active-workflow-recovery",
      title: "Refuse active workflow recovery",
      description: "Expired claim must not be recovered while workflow work is active.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Refuse stale-claim recovery while workflow work is active."),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: "session:old-owner",
      sessionId: "session:old-owner",
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.save(graph);
    await defaultWorkflowRunStore(dir).startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 10_000,
    });

    const refused = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    assert.match(toolText(refused), /Claim recovery refused: active_workflow_run/);
    const details = refused.details as {
      error?: string;
      claimRecovery?: { recoverable?: boolean; reason?: string };
    };
    assert.equal(details.error, "claimed_by_other");
    assert.equal(details.claimRecovery?.recoverable, false);
    assert.equal(details.claimRecovery?.reason, "active_workflow_run");
    const stillClaimed = (await store.load())?.getTask(task.ref);
    assert.equal(stillClaimed?.claim?.sessionId, "session:old-owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("canonical task claim can claim an existing planned task by taskRef", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-write-claim-existing-by-ref-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const graph = await defaultTaskGraphStore(dir).load();
    const project = graph?.projects()[0];
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "planned-ready-task",
      title: "Planned ready task",
      description: "A planned task should be claimable through the canonical task facade.",
      kind: "research",
      status: "ready",
      plan: executionReadyPlan("Audit a ready planned task through the canonical task facade."),
    });
    await defaultTaskGraphStore(dir).save(graph);

    const claimed = await executeSparkTool(tools, "task_write", ctx, {
      action: "claim",
      taskRef: task.ref,
    });

    assert.match(toolText(claimed), /Claimed Spark task: @planned-ready-task: Planned ready task/);
    const claimedTask = (await defaultTaskGraphStore(dir).load())?.getTask(task.ref);
    assert.equal(claimedTask?.claim?.sessionId, ctxSessionKey(ctx));
    assert.equal(
      claimedTask?.plan?.objective,
      "Audit a ready planned task through the canonical task facade.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task rejects inline plan on claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-rejected-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const rejected = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "claim-plan-patch",
      title: "Inline plan claim",
      description: "Inline plan on claim must be rejected.",
      kind: "implement",
      plan: executionReadyPlan("Inline plan on claim must be rejected."),
    });

    assert.equal((rejected.details as { error?: string }).error, "claim_plan_not_allowed");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task returns structured task plan details after claiming a planned task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-output-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const planned = graph.createTask({
      projectRef: project.ref,
      name: "claim-plan-output",
      title: "Claim plan output",
      description: "Claim output should surface the plan.",
      kind: "implement",
      status: "ready",
      plan: {
        ...executionReadyPlan("Surface the claim plan summary."),
        constraints: ["Keep output compact", "Do not remove details.task"],
        successCriteria: ["The text includes success criteria"],
        evidenceRequired: ["Focused test proves plan fields are rendered"],
        steps: ["Render the plan", "Prompt for task plan items"],
      },
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: planned.ref,
    });

    const claimedTask = claim.details?.task as
      | {
          ref?: TaskRef;
          name?: string;
          title?: string;
          plan?: TaskPlan;
          claim?: { sessionId?: string };
        }
      | undefined;
    assert.equal(claimedTask?.ref, planned.ref);
    assert.equal(claimedTask?.name, "claim-plan-output");
    assert.equal(claimedTask?.title, "Claim plan output");
    assert.equal(claimedTask?.claim?.sessionId, ctxSessionKey(ctx));
    assert.deepEqual(claimedTask?.plan?.successCriteria, ["The text includes success criteria"]);
    assert.deepEqual(claimedTask?.plan?.evidenceRequired, [
      "Focused test proves plan fields are rendered",
    ]);
    assert.deepEqual(claimedTask?.plan?.constraints, [
      "Keep output compact",
      "Do not remove details.task",
    ]);
    assert.deepEqual(
      claimedTask?.plan?.items?.map((item) => item.title),
      ["Render the plan", "Prompt for task plan items"],
    );
    const reloaded = await defaultTaskGraphStore(dir).load();
    assert.deepEqual(
      reloaded?.taskTodos(planned.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Render the plan", "pending"],
        ["Prompt for task plan items", "pending"],
      ],
    );
    assert.equal(existsSync(sessionTaskTodoPath(dir, ctx)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task requires an existing bound task plan instead of asking at claim time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-claim-no-plan-ask-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "claim-plan",
      title: "Claim underspecified plan",
      description: "Claiming should not ask for task plan refinement.",
      kind: "implement",
      status: "ready",
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });

    const details = claim.details as
      | { error?: string; issues?: Array<{ kind?: string; severity?: string }> }
      | undefined;
    assert.equal(details?.error, "task_plan_required");
    assert.deepEqual(
      details?.issues?.map((issue) => [issue.kind, issue.severity]),
      [
        ["missing_success_criteria", "blocking"],
        ["missing_evidence_required", "blocking"],
      ],
    );
    const reloaded = await defaultTaskGraphStore(dir).load();
    assert.equal(reloaded?.getTask(task.ref).claim, undefined);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task and impl_update_task_plan_items persist task plan items across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-todos-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "persist-todos",
      title: "Persist task plan items",
      description: "Exercise task plan-item persistence through Spark tools.",
      kind: "implement",
      status: "ready",
      plan: executionReadyPlan("Exercise task plan-item persistence through Spark tools."),
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });
    const claimedTask = claim.details?.task as
      | {
          ref?: TaskRef;
          name?: string;
          claim?: { sessionId?: string };
        }
      | undefined;
    assert.equal(claimedTask?.name, "persist-todos");
    assert.ok(claimedTask?.ref);
    assert.equal(claimedTask.claim?.sessionId, ctxSessionKey(ctx));

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "init", items: ["Read sources", "Run focused tests"] }],
    });

    const afterClaimGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(afterClaimGraph);
    const afterClaim = afterClaimGraph.taskTodos(claimedTask.ref);
    assert.equal(afterClaim.length, 2);
    assert.deepEqual(
      afterClaim.map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "in_progress"],
        ["Run focused tests", "pending"],
      ],
    );
    assert.match(await taskGraphSnapshotText(dir), /Read sources/);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "done", item: "Read sources" },
        { op: "append", items: ["Check reload"] },
        { op: "note", item: "Run focused tests", text: "Persisted after reload" },
      ],
    });

    const afterUpdateGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(afterUpdateGraph);
    const afterUpdate = afterUpdateGraph.taskTodos(claimedTask.ref);
    assert.deepEqual(
      afterUpdate.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Read sources", "done", []],
        ["Run focused tests", "in_progress", ["Persisted after reload"]],
        ["Check reload", "pending", []],
      ],
    );

    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(reloadedGraph);
    assert.deepEqual(
      reloadedGraph.taskTodos(claimedTask.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "done"],
        ["Run focused tests", "in_progress"],
        ["Check reload", "pending"],
      ],
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "impl_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Persist task plan items/);
    assert.match(statusText, /\[done\].*Read sources/);
    assert.match(statusText, /\[in_progress\].*Run focused tests/);
    assert.match(statusText, /\[pending\].*Check reload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_update_task_plan_items supports upsert_done with planned task item sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-item-upsert-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    const project = graph?.projects()[0];
    assert.ok(graph);
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "todo-upsert-sync",
      title: "plan item upsert sync",
      description: "Exercise task plan item upsert and plan sync operations.",
      kind: "implement",
      status: "ready",
      plan: {
        ...executionReadyPlan("Exercise task plan item upsert and plan sync operations."),
        successCriteria: ["Plan sync criterion is represented"],
        steps: ["Inspect plan item sync", "Verify plan item sync"],
      },
    });
    await store.save(graph);

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      taskRef: task.ref,
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
          ops: [{ op: "done", item: "Typo TODO" }],
        }),
      /unknown todo item: Typo TODO/,
    );

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "upsert_done", item: "Verify plan item sync" },
        { op: "upsert_done", item: "Ad hoc validation completed" },
      ],
    });
    const updatedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(updatedGraph);
    const todos = updatedGraph.taskTodos(taskRef);
    assert.deepEqual(
      todos.map((todo) => [todo.content, todo.status]),
      [
        ["Inspect plan item sync", "in_progress"],
        ["Verify plan item sync", "done"],
        ["Ad hoc validation completed", "done"],
      ],
    );
    assert.match(
      todos.find((todo) => todo.content === "Ad hoc validation completed")?.notes?.[0] ?? "",
      /upsert_done created this TODO as done/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks syncs concrete plan items into task plan items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-task-todo-sync-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: [
        {
          name: "planned-todo-sync",
          title: "Planned plan item sync",
          description: "Planned task should get concrete TODOs from its plan.",
          kind: "implement",
          plan: {
            ...executionReadyPlan("Planned task should get concrete TODOs from its plan."),
            successCriteria: ["Planned criterion is represented"],
            steps: ["Plan step one", "Plan step two"],
          },
        },
      ],
    });

    const created = (planned.details?.result as { created?: Array<{ ref?: TaskRef }> } | undefined)
      ?.created?.[0]?.ref;
    assert.ok(created);
    assert.deepEqual(
      (planned.details as { planTodoSync?: Array<{ items?: string[] }> }).planTodoSync?.[0]?.items,
      [],
    );
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const todos = graph.taskTodos(created);
    assert.deepEqual(
      todos.map((todo) => [todo.content, todo.status]),
      [
        ["Plan step one", "pending"],
        ["Plan step two", "pending"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark rename tools improve obvious placeholder project and generic task names without changing refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-rename-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "「自定义输入」", description: "placeholder" });
    const generic = graph.createTask({
      projectRef: project.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Old broad placeholder task.",
      kind: "interaction",
      status: "running",
      plan: executionReadyPlan("Update generic task display names while preserving stable refs."),
    });
    const existing = graph.createTask({
      projectRef: project.ref,
      name: "implement-safe-naming",
      title: "Other naming task",
      description: "Ensure rename conflict suffixes are safe.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const renamedProject = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "rename",
      title: "Autonomous Spark naming quality",
    });
    const renamedProjectDetails = renamedProject.details?.project as
      | { ref?: ProjectRef; title?: string }
      | undefined;
    assert.equal(renamedProjectDetails?.ref, project.ref);
    assert.equal(renamedProjectDetails?.title, "Autonomous Spark naming quality");
    assert.equal(
      Object.hasOwn(renamedProjectDetails ?? {}, "status"),
      false,
      "Project mutation details must not expose Project.status",
    );

    const statusOnlyMutation = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "metadata_update",
      project: project.ref,
      status: "done",
    });
    assert.equal(statusOnlyMutation.isError, true);
    assert.equal(
      (statusOnlyMutation.details as { error?: string }).error,
      "project_status_removed",
    );

    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement safe naming",
      description: "Update generic task display names while preserving stable refs.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, generic.ref);
    assert.equal(claimedTask?.title, "Implement safe naming");
    assert.equal(claimedTask?.name, "implement-safe-naming-2");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getProject(project.ref).title, "Autonomous Spark naming quality");
    assert.equal(loaded.getTask(generic.ref).name, "implement-safe-naming-2");
    assert.equal(loaded.getTask(existing.ref).name, "implement-safe-naming");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task project mutation actions preserve permanent projects and reject lifecycle actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-intents-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Existing project",
      description: "Only project in graph.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      project: project.ref,
    });

    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "project_update",
          project: project.ref,
          title: "Old overloaded action",
        }),
      /task_write\.action must be one of:.*project_rename.*project_metadata_update/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_write", ctx, { action: "project_finish" }),
      /task_write\.action must be one of:/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "task_write", ctx, {
          action: "project_status_update",
          status: "done",
        }),
      /task_write\.action must be one of:/,
    );

    const missing = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_rename",
      project: "Missing project",
      title: "Better project title",
    });
    assert.equal(missing.isError, true);
    assert.equal((missing.details as { error?: string }).error, "no_project");
    assert.match(toolText(missing), /No matching Spark project found/);

    const renamed = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_rename",
      title: "Intent-specific project title",
    });
    assert.match(toolText(renamed), /Renamed Spark project:/);
    assert.equal((renamed.details as { titleBefore?: string }).titleBefore, "Existing project");
    assert.equal(
      (renamed.details as { titleAfter?: string }).titleAfter,
      "Intent-specific project title",
    );

    const metadata = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_metadata_update",
      description: "Updated description.",
      purpose: "Updated purpose.",
    });
    assert.match(toolText(metadata), /Updated Spark project metadata/);
    assert.deepEqual((metadata.details as { changedFields?: string[] }).changedFields?.sort(), [
      "description",
      "purpose",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task preserves intentional task names when only the title improves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-intentional-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Hypha v0", description: "intentional" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "hypha-v0",
      title: "Current task",
      description: "Generic title, intentional @name.",
      kind: "interaction",
      status: "running",
      plan: executionReadyPlan(
        "Narrow the active Hypha work without replacing the intentional handle.",
      ),
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement editor diagnostics slice",
      description: "Narrow the active Hypha work without replacing the intentional handle.",
      kind: "implement",
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.equal(claimedTask?.ref, task.ref);
    assert.equal(claimedTask?.name, "hypha-v0");
    assert.equal(claimedTask?.title, "Implement editor diagnostics slice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task refuses to create a new task when generic rename candidates are ambiguous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ambiguous-name-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Spark project", description: "placeholder" });
    const first = graph.createTask({
      projectRef: project.ref,
      name: "task-deadbeefcafebabe",
      title: "整理一下",
      description: "First generic non-ASCII placeholder.",
      kind: "interaction",
      status: "running",
    });
    const second = graph.createTask({
      projectRef: project.ref,
      name: "capture-project-intent",
      title: "Capture project intent",
      description: "Second generic placeholder.",
      kind: "interaction",
      status: "running",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Implement concrete naming policy test",
      description:
        "No existing task can be chosen without guessing because multiple generic tasks are present.",
      kind: "implement",
    });
    assert.equal((claim.details as { error?: string }).error, "task_not_found");
    assert.match(toolText(claim), /no existing planned task matched/);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(first.ref).name, "task-deadbeefcafebabe");
    assert.equal(loaded.getTask(second.ref).name, "capture-project-intent");
    assert.equal(loaded.tasks(project.ref).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task rejects terminal statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-terminal-claim-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "impl_claim_task", ctx, {
      name: "terminal-claim",
      title: "Terminal claim",
      description: "Attempt to finish through the claim tool.",
      kind: "implement",
      status: "done",
    });

    assert.equal(rejected.details?.error, "terminal_status_not_allowed");
    assert.match(toolText(rejected), /only accepts unfinished statuses/);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    assert.equal(
      graph.tasks(project.ref).some((task) => task.name === "terminal-claim"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid claim kind",
          description: "Invalid kind must not become interaction.",
          kind: "build",
        }),
      /kind must be research, implement, or review/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid claim status",
          description: "Invalid status must not become running.",
          status: "waiting",
        }),
      /status must be pending, ready, running, blocked, done, failed, or cancelled/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_claim_task rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: 42,
          description: "Invalid title must not be trusted.",
        }),
      /title must be a string/,
    );
    const inlinePlan = await executeSparkTool(tools, "impl_claim_task", ctx, {
      title: "Invalid risk",
      description: "Claim must reject every inline plan before validating plan fields.",
      plan: { ...executionReadyPlan("Reject invalid risk."), riskLevel: "urgent" },
    });
    assert.equal((inlinePlan.details as { error?: string }).error, "claim_plan_not_allowed");
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_claim_task", ctx, {
          title: "Invalid role",
          description: "Invalid role ref must not be ignored.",
          roleRef: 42,
        }),
      /roleRef must be a string/,
    );

    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task completes this session's claimed task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-me",
      title: "Finish me",
      description: "Exercise task lifecycle completion.",
      plan: executionReadyPlan("Finish me"),
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);
    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "init", items: ["Run focused finish lifecycle test"] }],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(finished), /Task finish blocked by open task plan items/);
    assert.equal((finished.details as { error?: string } | undefined)?.error, "open_plan_items");

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [{ op: "done", item: "Run focused finish lifecycle test" }],
    });
    const completed = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(completed), /Finished Spark task: \[done\] @finish-me: Finish me/);
    assert.match(
      toolText(completed),
      /Completion evidence warning: Task completion needs evidence artifacts/,
    );
    assert.match(
      toolText(completed),
      /Learning candidate: artifact:.* — Candidate from @finish-me/,
    );
    assert.equal((completed.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal((completed.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((completed.details as { statusAfter?: string }).statusAfter, "done");
    assert.deepEqual(
      (completed.details as { transition?: { committed?: boolean; statusBefore?: string } })
        .transition,
      {
        requestedStatus: "done",
        statusBefore: "running",
        statusAfter: "done",
        committed: true,
      },
    );
    assert.equal((completed.details as { reviewRequired?: boolean }).reviewRequired, true);
    assert.equal((completed.details?.review as { approved?: boolean } | undefined)?.approved, true);
    assert.ok(
      (completed.details as { reviewArtifact?: string }).reviewArtifact?.startsWith("artifact:"),
    );
    assert.equal(
      (completed.details as { reviewer?: { required?: boolean; approved?: boolean } }).reviewer
        ?.required,
      true,
    );
    assert.equal(
      (completed.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      false,
    );
    assert.deepEqual((completed.details as { evidenceRefs?: string[] }).evidenceRefs, []);
    assert.deepEqual((completed.details as { inputEvidenceRefs?: string[] }).inputEvidenceRefs, []);
    assert.deepEqual(
      (completed.details as { remainingReadyTasks?: unknown[] }).remainingReadyTasks,
      [],
    );
    assert.equal(
      (completed.details as { projectCompletionCandidate?: { ready?: boolean } })
        .projectCompletionCandidate?.ready,
      true,
    );
    assert.equal(
      (completed.details?.learningCandidate as { status?: string } | undefined)?.status,
      "candidate",
    );
    assert.match(
      (completed.details?.learningCandidate as { title?: string } | undefined)?.title ?? "",
      /Candidate from @finish-me/,
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
    const reviewArtifacts = await defaultArtifactStore(dir).list({ kind: "record" });
    assert.equal(reviewArtifacts.length, 1);
    const reviewDir = taskReviewDirectory(dir, loaded.getTask(taskRef).projectRef, taskRef);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; artifactRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "task");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, taskRef);
    assert.equal(reviewIndex.reviews[0]?.artifactRef, reviewArtifacts[0]?.ref);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, reviewArtifacts[0]!.ref), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "task");
    assert.equal(subjectReview.subjectRef, taskRef);
    assert.equal(subjectReview.outcome, "approved");
    const workspaceReviewIndex = await rebuildWorkspaceReviewIndex(dir);
    const reviewEntry = workspaceReviewIndex.reviews.find((entry) => entry.subjectRef === taskRef);
    assert.equal(reviewEntry?.subjectKind, "task");
    assert.match(
      reviewEntry?.path ?? "",
      /projects\/proj-.*\/tasks\/task-.*\/reviews\/artifact-.*\.json/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task returns structured transition data for failed no-review completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-failed-structured-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          throw new Error("failed status must not invoke reviewer");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await planAndClaimTask(tools, ctx, {
      name: "finish-failed-no-review",
      title: "Finish failed without review",
      description: "Terminal failed status should not run the reviewer gate.",
      plan: executionReadyPlan("Finish failed without review"),
    });

    const failed = await executeSparkTool(tools, "impl_finish_task", ctx, {
      status: "failed",
      summary: "External validation failed.",
    });

    assert.match(toolText(failed), /Finished Spark task: \[failed\]/);
    assert.equal(reviewerCalls, 0);
    assert.equal((failed.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((failed.details as { statusAfter?: string }).statusAfter, "failed");
    assert.equal((failed.details as { reviewRequired?: boolean }).reviewRequired, false);
    assert.equal((failed.details as { review?: unknown }).review, undefined);
    assert.equal(
      (failed.details as { reviewer?: { required?: boolean } }).reviewer?.required,
      false,
    );
    assert.equal(
      (failed.details as { transition?: { committed?: boolean } }).transition?.committed,
      true,
    );
    assert.equal((failed.details as { learningCandidate?: unknown }).learningCandidate, undefined);
    assert.equal(
      (failed.details as { projectCompletionCandidate?: { ready?: boolean } })
        .projectCompletionCandidate?.ready,
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task attaches evidenceRefs before reviewer gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerEvidenceRefs: string[] = [];
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          if (input.targetKind === "task") reviewerEvidenceRefs = input.evidenceRefs;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Focused validation evidence",
      format: "markdown",
      body: "Targeted tests passed.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-evidence",
      title: "Finish with evidence",
      description: "Finish should pass explicit evidence refs to reviewer.",
      plan: executionReadyPlan("Finish with evidence"),
      todos: ["Attach evidence and finish task"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Attach evidence and finish task"] },
        { op: "done", item: "Attach evidence and finish task" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Validated with attached evidence.",
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\] @finish-evidence/);
    assert.deepEqual(reviewerEvidenceRefs, [evidence.ref]);
    assert.deepEqual((finished.details as { evidenceRefs?: string[] }).evidenceRefs, [
      evidence.ref,
    ]);
    assert.deepEqual((finished.details as { reviewEvidenceRefs?: string[] }).reviewEvidenceRefs, [
      evidence.ref,
    ]);
    assert.equal(
      (finished.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      true,
    );
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.deepEqual(loaded.getTask(taskRef).outputArtifacts, [evidence.ref]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task can create bounded task evidence artifact before reviewer gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-generated-evidence-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerEvidenceRefs: string[] = [];
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          if (input.targetKind === "task") reviewerEvidenceRefs = input.evidenceRefs;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-generated-evidence",
      title: "Finish with generated evidence",
      description: "Finish should create a bounded task evidence artifact.",
      plan: executionReadyPlan("Finish with generated evidence"),
      todos: ["Generate evidence and finish task"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Generate evidence and finish task"] },
        { op: "done", item: "Generate evidence and finish task" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Generated evidence validates the task.",
      evidence: {
        title: "Generated finish evidence",
        notes: "Bounded evidence notes.",
        changedFiles: [
          "packages/spark-extension/src/extension/spark-finish-task-tool-registration.ts",
        ],
        sourceRefs: ["test/spark-tools.test.ts:generated-evidence"],
        validationCommands: ["pnpm run test:file test/spark-tools.test.ts — pass"],
      },
    });

    assert.match(toolText(finished), /Generated evidence artifact: artifact:/);
    const generatedRef = (finished.details as { generatedEvidenceArtifact?: ArtifactRef })
      .generatedEvidenceArtifact;
    assert.ok(generatedRef?.startsWith("artifact:"));
    if (!generatedRef) throw new Error("missing generated evidence artifact ref");
    assert.deepEqual(reviewerEvidenceRefs, [generatedRef]);
    assert.deepEqual((finished.details as { evidenceRefs?: string[] }).evidenceRefs, [
      generatedRef,
    ]);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.deepEqual(loaded.getTask(taskRef).outputArtifacts, [generatedRef]);
    const artifact = await defaultArtifactStore(dir).get(generatedRef);
    assert.equal(artifact.provenance.producer, "task");
    assert.equal(artifact.provenance.taskRef, taskRef);
    assert.equal(artifact.curation?.status, "candidate");
    assert.equal(artifact.curation?.retention, "task");
    const body = artifact.body;
    assert.equal(typeof body, "string");
    if (typeof body !== "string") throw new Error("generated evidence body must be markdown");
    assert.match(body, /Generated finish evidence/);
    assert.match(body, /pnpm run test:file test\/spark-tools\.test\.ts — pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task does not persist evidenceRefs when follow-up gate blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-evidence-followup-block-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          throw new Error("reviewer should not run before follow-up disposition passes");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a follow-up before this research can close.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-evidence-followup-block",
      title: "Finish evidence follow-up block",
      description: "Blocked follow-up checks must not persist explicit finish evidence.",
      kind: "research",
      plan: executionReadyPlan("Finish evidence follow-up block"),
      todos: ["Validate follow-up gate blocks before evidence persistence"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate follow-up gate blocks before evidence persistence"] },
        { op: "done", item: "Validate follow-up gate blocks before evidence persistence" },
      ],
    });

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Research conclusion: still has an open follow-up.",
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(blocked), /Task finish blocked by follow-up disposition gate/);
    assert.equal(
      (blocked.details as { error?: string } | undefined)?.error,
      "followup_disposition_required",
    );
    assert.equal(reviewerCalls, 0);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.deepEqual(loaded.getTask(taskRef).outputArtifacts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task keeps task unfinished when reviewer rejects done transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-review-reject-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createRejectingReviewerRunner("reviewer requires focused validation"),
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-review-reject",
      title: "Finish review reject",
      description: "Reviewer rejection must keep this task unfinished.",
      plan: executionReadyPlan("Finish review reject"),
      todos: ["Validate reviewer rejection keeps task unfinished"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate reviewer rejection keeps task unfinished"] },
        { op: "done", item: "Validate reviewer rejection keeps task unfinished" },
      ],
    });

    const rejected = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Pretend complete without validation.",
    });

    assert.match(toolText(rejected), /Task finish blocked by reviewer/);
    assert.match(toolText(rejected), /reviewer requires focused validation/);
    assert.match(toolText(rejected), /The task was not marked done/);
    assert.equal((rejected.details as { error?: string }).error, "task_review_failed");
    assert.equal((rejected.details?.task as { status?: string } | undefined)?.status, "running");
    assert.equal((rejected.details as { statusBefore?: string }).statusBefore, "running");
    assert.equal((rejected.details as { statusAfter?: string }).statusAfter, "running");
    assert.equal(
      (rejected.details as { transition?: { committed?: boolean; blocker?: string } }).transition
        ?.committed,
      false,
    );
    assert.equal(
      (rejected.details as { transition?: { committed?: boolean; blocker?: string } }).transition
        ?.blocker,
      "task_review_failed",
    );
    assert.equal(
      (rejected.details as { reviewer?: { required?: boolean; approved?: boolean } }).reviewer
        ?.required,
      true,
    );
    assert.equal(
      (rejected.details?.review as { outcome?: string; approved?: boolean } | undefined)?.outcome,
      "needs_changes",
    );
    assert.equal(
      (rejected.details?.review as { outcome?: string; approved?: boolean } | undefined)?.approved,
      false,
    );
    assert.ok(
      (rejected.details as { reviewArtifact?: string }).reviewArtifact?.startsWith("artifact:"),
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    const reviewArtifacts = await defaultArtifactStore(dir).list({ kind: "record" });
    assert.equal(reviewArtifacts.length, 1);
    assert.equal(reviewArtifacts[0]?.provenance.producer, "review");
    assert.equal(reviewArtifacts[0]?.provenance.taskRef, taskRef);
    const reviewArtifact = await defaultArtifactStore(dir).get(reviewArtifacts[0]!.ref);
    const reviewerRun = (
      reviewArtifact?.body as { reviewerRun?: { stdoutPreview?: string } } | undefined
    )?.reviewerRun;
    assert.match(reviewerRun?.stdoutPreview ?? "", /test reviewer raw stdout/);
    const reviewDir = taskReviewDirectory(dir, loaded.getTask(taskRef).projectRef, taskRef);
    const reviewIndex = JSON.parse(await readFile(join(reviewDir, "index.json"), "utf8")) as {
      reviews: Array<{ subjectKind?: string; subjectRef?: string; artifactRef?: string }>;
    };
    assert.equal(reviewIndex.reviews[0]?.subjectKind, "task");
    assert.equal(reviewIndex.reviews[0]?.subjectRef, taskRef);
    assert.equal(reviewIndex.reviews[0]?.artifactRef, reviewArtifacts[0]?.ref);
    const subjectReview = JSON.parse(
      await readFile(subjectReviewRecordPath(reviewDir, reviewArtifacts[0]!.ref), "utf8"),
    ) as { subjectKind?: string; subjectRef?: string; outcome?: string };
    assert.equal(subjectReview.subjectKind, "task");
    assert.equal(subjectReview.subjectRef, taskRef);
    assert.equal(subjectReview.outcome, "needs_changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task treats malformed reviewer verdict as blocking feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-review-malformed-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review() {
          throw new Error("reviewer verdict must be a JSON object");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-review-malformed",
      title: "Finish review malformed",
      description: "Malformed reviewer output must block completion transparently.",
      plan: executionReadyPlan("Finish review malformed"),
      todos: ["Verify malformed reviewer output blocks finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Verify malformed reviewer output blocks finish"] },
        { op: "done", item: "Verify malformed reviewer output blocks finish" },
      ],
    });

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: "Pretend complete with malformed reviewer output.",
    });

    assert.match(toolText(blocked), /Task finish blocked by reviewer/);
    assert.match(toolText(blocked), /reviewer failed: reviewer verdict must be a JSON object/);
    assert.equal((blocked.details as { error?: string }).error, "task_review_failed");
    assert.equal(
      (blocked.details?.review as { outcome?: string; approved?: boolean } | undefined)?.outcome,
      "blocked",
    );
    assert.equal(
      (blocked.details?.review as { outcome?: string; approved?: boolean } | undefined)?.approved,
      false,
    );
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    const reviewArtifacts = await defaultArtifactStore(dir).list({ kind: "record" });
    assert.equal(reviewArtifacts.length, 1);
    assert.equal(reviewArtifacts[0]?.provenance.producer, "review");
    assert.equal(reviewArtifacts[0]?.provenance.taskRef, taskRef);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task blocks research follow-ups without explicit disposition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-followup-block-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review() {
          reviewerCalls += 1;
          throw new Error("reviewer should not run before follow-up disposition passes");
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-research-followup-block",
      title: "Finish research follow-up block",
      description: "Research outputs with orphan follow-ups must not be marked done.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up block"),
      todos: ["Verify orphan follow-ups block research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const blocked = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary:
        "Research conclusion: compact is incomplete.\nP1: wire Spark-native compaction into SparkAgentLoop.\nTODO: create memory scratch/daily follow-up.",
    });

    assert.match(toolText(blocked), /Task finish blocked by follow-up disposition gate/);
    assert.match(
      toolText(blocked),
      /created_task, already_covered, deferred, rejected, out_of_scope/,
    );
    assert.equal((blocked.details as { error?: string }).error, "followup_disposition_required");
    assert.equal(reviewerCalls, 0);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "running");
    assert.ok(loaded.getTask(taskRef).claim);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 0);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task accepts summary disposition for artifact follow-ups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-artifact-followup-disposition-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);
    const evidence = await defaultArtifactStore(dir).put({
      kind: "record",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a separate follow-up.",
      provenance: { producer: "task" },
    });

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-artifact-followup-disposition",
      title: "Finish artifact follow-up disposition",
      description: "Summary disposition may explicitly cover artifact follow-up signals.",
      kind: "research",
      plan: executionReadyPlan("Finish artifact follow-up disposition"),
      todos: ["Validate artifact follow-up disposition"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Validate artifact follow-up disposition"] },
        { op: "done", item: "Validate artifact follow-up disposition" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary: `Research conclusion: artifact disposition is explicit.\nFollow-ups:\n- already_covered: ${evidence.ref} is covered by an existing task.`,
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal(reviewerCalls, 1);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.deepEqual(loaded.getTask(taskRef).outputArtifacts, [evidence.ref]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task completes research when follow-ups are dispositioned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-followup-pass-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-research-followup-pass",
      title: "Finish research follow-up pass",
      description: "Research outputs with dispositioned follow-ups may complete.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up pass"),
      todos: ["Verify dispositioned follow-ups allow research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
      ops: [
        { op: "init", items: ["Verify dispositioned follow-ups allow research finish"] },
        { op: "done", item: "Verify dispositioned follow-ups allow research finish" },
      ],
    });

    const finished = await executeSparkTool(tools, "impl_finish_task", ctx, {
      summary:
        "Research conclusion: route is selected.\nFollow-ups:\n- created_task: @compact-auto-budget covers P1 compaction wiring.\n- deferred: memory scratch/daily remains P2 outside this slice.",
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal(reviewerCalls, 1);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal((finished.details?.review as { approved?: boolean } | undefined)?.approved, true);
    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 1);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task rejects invalid explicit parameters without changing status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await planAndClaimTask(tools, ctx, {
      name: "finish-invalid",
      title: "Finish invalid",
      description: "Invalid finish parameters must not alter task state.",
      plan: executionReadyPlan("Reject invalid finish parameters."),
      todos: ["Validate finish parameters"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () => executeSparkTool(tools, "impl_finish_task", ctx, { status: "cancel" }),
      /status must be done, failed, or cancelled/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "impl_finish_task", ctx, { summary: 42 }),
      /summary must be a string/,
    );

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.equal(loaded?.getTask(taskRef).status, "running");
    assert.ok(loaded?.getTask(taskRef).claim);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_finish_task refuses to cancel a claimed prerequisite with dependents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-cancel-dependent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const prerequisite = graph.createTask({
        projectRef: project.ref,
        name: "claimed-prereq",
        title: "Claimed prerequisite",
        description: "A claimed prerequisite with a dependent.",
        status: "running",
        plan: executionReadyPlan("Keep claimed prerequisite"),
      });
      graph.claimTask(prerequisite.ref, {
        kind: "main",
        claimedBy: ctxSessionKey(ctx),
        sessionId: ctxSessionKey(ctx),
        leaseMs: 60_000,
      });
      const dependent = graph.createTask({
        projectRef: project.ref,
        name: "dependent-on-claimed",
        title: "Dependent on claimed",
        description: "Depends on the claimed prerequisite.",
        status: "pending",
        plan: executionReadyPlan("Use claimed prerequisite"),
      });
      graph.addDependency(dependent.ref, prerequisite.ref);
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const cancelled = await executeSparkTool(tools, "impl_finish_task", ctx, {
      status: "cancelled",
      summary: "Try to cancel prerequisite.",
    });

    assert.match(toolText(cancelled), /Cannot finish Spark task/);
    assert.match(toolText(cancelled), /cannot be cancelled/);
    assert.equal((cancelled.details as { error?: string }).error, "task_dependency_error");
    const graph = await defaultTaskGraphStore(dir).load();
    const task = graph?.tasks().find((candidate) => candidate.name === "claimed-prereq");
    assert.equal(task?.status, "running");
    assert.ok(task?.claim);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("split task tools dispatch read, write, and assign actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-canonical-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    assert.equal(tools.has("task"), false, "old task multiplexer must not be public");
    assert.ok(tools.has("task_read"), "missing task_read tool");
    assert.ok(tools.has("task_write"), "missing task_write tool");
    assert.ok(tools.has("assign"), "missing assign tool");
    const taskParameters = JSON.stringify(tools.get("task_write")?.parameters);
    assert.match(taskParameters, /Executor role ref/);
    assert.match(taskParameters, /omit for normal task planning/);
    assert.doesNotMatch(taskParameters, /Preferred role ref/);
    assert.doesNotMatch(taskParameters, /run_ready/);
    assert.doesNotMatch(taskParameters, /run_control/);
    const taskReadParameters = JSON.stringify(tools.get("task_read")?.parameters);
    assert.match(taskReadParameters, /task_status/);
    assert.match(taskReadParameters, /project_status/);
    assert.match(taskReadParameters, /workspace_status/);
    assert.match(taskReadParameters, /run_status/);
    await assert.rejects(
      () => executeSparkTool(tools, "task_read", ctx, { action: "status" }),
      /task_read\.action must be one of: task_status, project_status, workspace_status, project_list, run_status/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_read", ctx, { action: "project_use" }),
      /task_read\.action must be one of: task_status, project_status, workspace_status, project_list, run_status/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "task_write", ctx, { action: "run_ready" }),
      /task_write\.action must be one of:/,
    );

    const created = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Canonical task tool project",
      description: "Exercise the canonical task action tool.",
    });
    assert.match(toolText(created), /Created new Spark project/);

    const planned = await executeSparkTool(tools, "task_write", ctx, {
      action: "plan",
      tasks: [
        {
          name: "canonical-task-tool",
          title: "Canonical task tool",
          description: "Exercise task action routing.",
          status: "ready",
          plan: executionReadyPlan("Exercise task action routing"),
        },
      ],
    });
    assert.match(toolText(planned), /Planned tasks: created=1/);

    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    assert.match(toolText(status), /Canonical task tool project/);

    const assigned = await executeSparkTool(tools, "assign", ctx, {
      dryRun: true,
      maxConcurrency: 1,
    });
    assert.match(toolText(assigned), /Dry-run checked 1 Spark task run/);

    const claimed = await executeSparkTool(tools, "task_write", ctx, {
      action: "claim",
      name: "canonical-task-tool",
      title: "Canonical task tool",
      description: "Exercise task action routing.",
      todos: ["Validate canonical task action routing"],
    });
    assert.match(toolText(claimed), /Claimed Spark task/);

    const todos = await executeSparkTool(tools, "task_write", ctx, {
      action: "todo_update",
      scope: "task",
      ops: [
        { op: "init", items: ["Validate canonical task action routing"] },
        { op: "append", items: ["Validate canonical task routing"] },
        { op: "done", item: "Validate canonical task action routing" },
        { op: "done", item: "Validate canonical task routing" },
      ],
    });
    assert.match(toolText(todos), /Updated plan items/);

    const finished = await executeSparkTool(tools, "task_write", ctx, {
      action: "finish",
      summary: "Canonical task routing works.",
    });
    assert.match(toolText(finished), /Finished Spark task/);

    const contextList = await executeSparkTool(tools, "context", ctx, { action: "list" });
    assert.match(toolText(contextList), /spark\.active/);
    const contextPreview = await executeSparkTool(tools, "context", ctx, {
      action: "preview",
      providerIds: ["spark.active"],
      budgetChars: 1_000,
    });
    assert.match(toolText(contextPreview), /Spark context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task_read project_status hides unclaimed task plan-item details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-claim-gated-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const unclaimed = graph.createTask({
      projectRef: project.ref,
      name: "unclaimed-details",
      title: "Unclaimed task with plan items",
      description: "Plan-item content must not leak before claim.",
      status: "ready",
      plan: executionReadyPlan("Keep unclaimed plan-item content compact"),
      todos: [{ content: "Hidden unclaimed plan item", status: "pending" }],
    });
    const claimed = graph.createTask({
      projectRef: project.ref,
      name: "claimed-details",
      title: "Claimed task with plan items",
      description: "Claimed plan-item content should remain visible.",
      status: "ready",
      plan: executionReadyPlan("Show claimed plan-item content"),
      todos: [{ content: "Visible claimed plan item", status: "pending" }],
    });
    const sessionKey = ctxSessionKey(ctx);
    graph.claimTask(claimed.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    await store.save(graph);
    await saveCurrentProjectRef(dir, ctx, project.ref);

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: project.ref,
    });
    const text = toolText(status);
    assert.match(text, /Unclaimed task with plan items/);
    assert.doesNotMatch(text, /Hidden unclaimed plan item/);
    assert.match(text, /Visible claimed plan item/);

    const detailsStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: project.ref,
    });
    const details = detailsStatus.details as {
      selectedProject?: {
        tasks?: Array<{
          ref?: string;
          todos?: { total?: number; items?: Array<{ content?: string }> };
        }>;
      };
    };
    const taskDetails = details.selectedProject?.tasks ?? [];
    const unclaimedDetails = taskDetails.find((task) => task.ref === unclaimed.ref);
    const claimedDetails = taskDetails.find((task) => task.ref === claimed.ref);
    assert.equal(unclaimedDetails?.todos?.total, 0);
    assert.deepEqual(unclaimedDetails?.todos?.items, []);
    assert.equal(claimedDetails?.todos?.total, 1);
    assert.equal(claimedDetails?.todos?.items?.[0]?.content, "Visible claimed plan item");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("task_read scoped status actions do not return unrelated projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-scoped-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [currentProject] = graph.projects();
    assert.ok(currentProject);
    const selectedTask = graph.createTask({
      projectRef: currentProject.ref,
      name: "selected-task",
      title: "Selected task",
      description: "The only task expected in task_status.",
      status: "ready",
      plan: executionReadyPlan("The only task expected in task_status."),
    });
    graph.createTask({
      projectRef: currentProject.ref,
      name: "sibling-task",
      title: "Sibling task",
      description: "Same-project task excluded from task_status.",
      status: "pending",
      plan: executionReadyPlan("Same-project task excluded from task_status."),
    });
    const unrelatedProject = graph.createProject({
      title: "Unrelated project",
      description: "Must not appear in scoped project/task status.",
    });
    graph.createTask({
      projectRef: unrelatedProject.ref,
      name: "unrelated-task",
      title: "Unrelated task",
      description: "Must not leak into scoped status.",
      status: "ready",
      plan: executionReadyPlan("Must not leak into scoped status."),
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      project: currentProject.ref,
    });

    const projectStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
      projectRef: currentProject.ref,
    });
    const projectDetails = projectStatus.details as {
      scope?: string;
      selectedProject?: { ref?: string; title?: string; tasks?: Array<{ name?: string }> };
      renderedProjects?: Array<{ ref?: string; title?: string }>;
      projects?: Array<{ title?: string }>;
    };
    assert.equal(projectDetails.scope, "project");
    assert.equal(projectDetails.selectedProject?.ref, currentProject.ref);
    assert.deepEqual(
      projectDetails.renderedProjects?.map((project) => project.ref),
      [currentProject.ref],
    );
    assert.equal(projectDetails.projects, undefined);
    assert.doesNotMatch(toolText(projectStatus), /Unrelated project|Unrelated task/);

    const taskStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "task_status",
      taskRef: selectedTask.ref,
    });
    const taskDetails = taskStatus.details as {
      scope?: string;
      selectedTask?: { ref?: string; name?: string };
      selectedProject?: { ref?: string; tasks?: Array<{ name?: string }> };
      renderedProjects?: Array<{ tasks?: Array<{ name?: string }> }>;
    };
    assert.equal(taskDetails.scope, "task");
    assert.equal(taskDetails.selectedTask?.ref, selectedTask.ref);
    assert.deepEqual(
      taskDetails.renderedProjects?.[0]?.tasks?.map((task) => task.name),
      ["selected-task"],
    );
    assert.doesNotMatch(toolText(taskStatus), /Sibling task|Unrelated project|Unrelated task/);

    const workspaceStatus = await executeSparkTool(tools, "task_read", ctx, {
      action: "workspace_status",
      view: "summary",
      format: "json",
    });
    const workspaceDetails = JSON.parse(toolText(workspaceStatus)) as {
      scope?: string;
      renderedProjects?: Array<{ title?: string }>;
    };
    assert.equal(workspaceDetails.scope, "workspace");
    assert.ok(
      workspaceDetails.renderedProjects?.some((project) => project.title === "Unrelated project"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("canonical task project_use creates the first Spark project when graph is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-project-bootstrap-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.equal(existsSync(join(dir, ".spark", "projects.json")), false);
    const created = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Goal bootstrap project",
      description: "Create the first project directly from a foreground goal tick.",
    });

    assert.match(toolText(created), /Created new Spark project/);
    assert.equal((created.details as { created?: boolean }).created, true);
    const graph = await defaultTaskGraphStore(dir).load();
    assert.equal(graph?.projects()[0]?.title, "Goal bootstrap project");

    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    assert.match(toolText(status), /Goal bootstrap project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact tool lists and reads artifacts through the canonical facade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const artifact = await defaultArtifactStore(dir).put({
      kind: "document",
      title: "Facade research note",
      format: "text",
      body: "artifact body",
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    const listed = await executeSparkTool(tools, "artifact", ctx, {
      action: "list",
      kind: "document",
    });
    assert.match(toolText(listed), new RegExp(`${artifact.ref}.*Facade research note`));
    assert.equal((listed.details as { count?: number }).count, 1);
    assert.equal((listed.details as { view?: string }).view, "summary");

    const refOnly = await executeSparkTool(tools, "artifact", ctx, {
      action: "list",
      kind: "document",
      view: "ref-only",
    });
    assert.match(toolText(refOnly), new RegExp(`- ${artifact.ref}`));
    assert.doesNotMatch(toolText(refOnly), /Facade research note/);

    const read = await executeSparkTool(tools, "artifact", ctx, {
      action: "read",
      artifactRef: artifact.ref,
    });
    assert.match(toolText(read), /Facade research note/);
    assert.match(toolText(read), /artifact body/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact tool rejects invalid explicit filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-invalid-filters-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const artifact = await defaultArtifactStore(dir).put({
      kind: "document",
      title: "Boundary note",
      format: "text",
      body: "artifact body",
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", kind: "note" }),
      /kind must be a valid artifact kind; valid values: document, record, trace, knowledge; received: note/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", producer: "agent" }),
      /producer must be a valid artifact producer; valid values: spark, role, task, review, ask, cue, user; received: agent.*producer=task.*runRef\/taskRef/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "artifact", ctx, {
          action: "record",
          kind: "plan-draft",
          title: "Draft",
          format: "markdown",
          body: "draft",
          provenance: { producer: "task" },
        }),
      /kind must be a valid artifact kind; valid values: document, record, trace, knowledge; received: plan-draft.*kind=document/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "artifact", ctx, {
          action: "link",
          from: artifact.ref,
          to: "task:demo",
          relation: "review",
        }),
      /relation must be a valid artifact link relation; valid values: parent, input, output, review-of, answer-to, trace-of, derived-from; received: review/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", projectRef: "project:one" }),
      /projectRef must be a proj: ref/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", limit: 1.5 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", view: "unsupported" }),
      /view must be ref-only or summary/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "artifact", ctx, {
          action: "read",
          artifactRef: "note:one",
        }),
      /artifactRef must be an artifact ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("learning tool routes record, list, search, read, export, and import through the canonical facade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-"));
  const importDir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-import-"));
  try {
    await writeEmptySparkProject(dir);
    await writeEmptySparkProject(importDir);
    const ctx = testSparkContext(dir, "main");
    const importCtx = testSparkContext(importDir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.ok(tools.has("learning"), "missing canonical learning tool");
    const recorded = await executeSparkTool(tools, "learning", ctx, {
      action: "record",
      id: "learning-explicit-export",
      title: "Export shared learnings explicitly",
      statement:
        "Spark learnings live in .learnings locally and can be shared through explicit Markdown exports.",
      category: "decision",
      evidenceRefs: ["artifact:decision-gate"],
      tags: ["nyakore", "spark"],
      confidence: 0.9,
    });
    assert.match(toolText(recorded), /Recorded learning artifact:learning-explicit-export/);

    const listed = await executeSparkTool(tools, "learning", ctx, {
      action: "list",
      tag: "spark",
      location: "workspace",
    });
    assert.match(toolText(listed), /Export shared learnings explicitly/);

    const search = await executeSparkTool(tools, "learning", ctx, {
      action: "search",
      query: "explicit Markdown exports",
      location: "workspace",
    });
    assert.match(toolText(search), /Export shared learnings explicitly/);

    const read = await executeSparkTool(tools, "learning", ctx, {
      action: "read",
      ref: "artifact:learning-explicit-export",
    });
    assert.match(toolText(read), /\.learnings/);

    const exportPath = join("exports", "learnings.md");
    const exported = await executeSparkTool(tools, "learning", ctx, {
      action: "export_markdown",
      outputPath: exportPath,
      location: "workspace",
    });
    assert.match(toolText(exported), /Exported 1 learning/);
    assert.equal((exported.details as { count?: number }).count, 1);

    const dryRun = await executeSparkTool(tools, "learning", importCtx, {
      action: "import_markdown",
      inputPath: join(dir, exportPath),
    });
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((dryRun.details as { apply?: boolean; count?: number }).apply, false);
    assert.equal((dryRun.details as { apply?: boolean; count?: number }).count, 1);

    const imported = await executeSparkTool(tools, "learning", importCtx, {
      action: "import_markdown",
      inputPath: join(dir, exportPath),
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);
    assert.equal((imported.details as { count?: number }).count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(importDir, { recursive: true, force: true });
  }
});

void test("spark learning tools reject invalid explicit parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_record", ctx, {
          title: "Invalid category",
          statement: "This category should not be accepted.",
          category: "lesson",
        }),
      /category must be pattern/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_record", ctx, {
          title: "Invalid confidence",
          statement: "Confidence should stay normalized.",
          confidence: 2,
        }),
      /confidence must be a finite number between 0 and 1/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_search", ctx, {
          query: "anything",
          includeCandidates: "true",
        }),
      /includeCandidates must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_list", ctx, {
          status: ["active", "archived"],
        }),
      /status must be candidate/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_export_markdown", ctx, {
          includeInactive: "false",
        }),
      /includeInactive must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_learning_import_markdown", ctx, {
          inputPath: ".learnings",
          apply: "true",
        }),
      /apply must be a boolean/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_ask_replay rejects invalid explicit artifact refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ask-replay-invalid-ref-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_ask_replay", ctx, { artifactRef: 42 }),
      /artifactRef must be a string/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "impl_ask_replay", ctx, { artifactRef: "ask:one" }),
      /artifactRef must be an artifact: ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project clarifies generic project labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-intent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const created = await executeSparkTool(tools, "impl_use_project", ctx, { title: "tasks" });
    assert.match(toolText(created), /Created new Spark project/);
    assert.equal((created.details as { created?: boolean } | undefined)?.created, true);
    const artifacts = await defaultArtifactStore(dir).list({
      kind: "record",
    });
    assert.equal(artifacts.length, 1);
    const traces = await defaultArtifactStore(dir).list({
      kind: "trace",
    });
    const askArtifact = await defaultArtifactStore(dir).get(artifacts[0].ref);
    const askBody = askArtifact.body as {
      request?: { questions?: Array<{ id: string; prompt?: string }> };
    };
    assert.ok(askBody.request?.questions?.every((question) => question.prompt?.includes("tasks")));
    const clarificationTrace = traces.find(
      (artifact) => artifact.title === "Project purpose clarification",
    );
    assert.ok(clarificationTrace);
    assert.equal(clarificationTrace.provenance.producer, "task");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project blocks active duplicate project creation without writing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-active-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeGraph = await defaultTaskGraphStore(dir).load();
    const beforeCount = beforeGraph?.projects().length ?? 0;
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);

    const blocked = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Tool persistence",
      description: "Same work as the existing Tool persistence project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    assert.match(toolText(blocked), /task_write\(\{ action: "project_use"/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string }>;
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    const afterGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(afterGraph?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project compares duplicates against permanent projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-permanent-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await store.load())?.projects().length ?? 0;

    const blocked = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Tool persistence",
      description: "Attempt to recreate a duplicate permanent project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    const details = blocked.details as { candidates?: Array<{ title?: string }> } | undefined;
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.equal((await store.load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project creates clearly distinct projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-distinct-create-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const created = await executeSparkTool(tools, "impl_use_project", ctx, {
      title: "Renderer pipeline profiling",
      description: "Investigate frame timing and GPU trace capture for the renderer pipeline.",
    });

    assert.match(toolText(created), /Created new Spark project/);
    const details = created.details as
      | { created?: boolean; project?: { ref?: string } }
      | undefined;
    assert.equal(details?.created, true);
    assert.equal(
      (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0,
      beforeCount + 1,
    );
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, details?.project?.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project duplicate gate does not block explicit existing project selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-use-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const selected = await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
      title: "Tool persistence",
      description:
        "Even duplicate create metadata must be ignored when selecting an existing Project.",
    });

    assert.match(toolText(selected), /Selected existing Spark project/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
    assert.equal((await defaultTaskGraphStore(dir).load())?.projects().length ?? 0, beforeCount);
    assert.ok((await loadCurrentProjectState(dir, ctx))?.projectRef?.startsWith("proj:"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("canonical task project_use exposes duplicate creation gate guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-canonical-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const blocked = await executeSparkTool(tools, "task_write", ctx, {
      action: "project_use",
      title: "Tool persistence",
      description: "Duplicate via canonical task tool surface.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.doesNotMatch(toolText(blocked), /status=/);
    assert.match(toolText(blocked), /Select the existing Project/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string }>;
          guidance?: string[];
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.ok(
      details?.guidance?.some((line) => line.includes('task_write({ action: "project_use"')),
    );
    assert.equal((await defaultTaskGraphStore(dir).load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_use_project reports selected existing projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-use-project-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const selected = await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
    });

    assert.match(toolText(selected), /Selected existing Spark project/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal start with objective bootstraps when no project exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-bootstrap-no-project-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Ship autonomous goal bootstrap behavior",
    });

    assert.match(toolText(started), /Spark session goal active/);
    assert.match(toolText(started), /No current Spark project is selected/);
    assert.match(
      toolText(started),
      /task_write\(\{ action: "project_use", title, description \}\)/,
    );
    assert.match(toolText(started), /task_write\(\{ action: "plan" \}\)/);
    assert.notEqual((started.details as { error?: string }).error, "no_inferable_goal");
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.objective, "Ship autonomous goal bootstrap behavior");
    assert.equal(goal?.status, "active");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal foreground loop asks agent to bootstrap a project when none exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-bootstrap-no-project-"));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  type FakeTimer = {
    callback: () => void;
    delay: number | undefined;
    cleared: boolean;
    unref: () => FakeTimer;
  };
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === "function") callback(...args);
      },
      delay,
      cleared: false,
      unref: () => timer,
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const fake = timer as unknown as FakeTimer | undefined;
    if (fake) fake.cleared = true;
  }) as typeof clearTimeout;
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1)
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
  }

  try {
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Bootstrap project from goal loop",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
    assert.equal(timers.length, 1);
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(isForegroundGoalTickMessage(run.customMessages.at(-1)), true);
    assert.equal(run.customMessages.at(-1)?.details?.selectedMode, "plan");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_goal start ignores legacy session-scoped TODO snapshots when inferring goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-goal-ignore-legacy-todos-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    await defaultTaskGraphStore(dir).save(new TaskGraph());
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const emptyStart = await executeSparkTool(tools, "goal", ctx, { action: "start" });
    assert.match(toolText(emptyStart), /No Spark project\/task state is available to infer/);
    assert.equal((emptyStart.details as { found?: boolean; error?: string }).found, false);
    assert.equal(
      (emptyStart.details as { found?: boolean; error?: string }).error,
      "no_inferable_goal",
    );
    assert.equal(await loadSessionGoal(dir, ctx), undefined);

    await saveIndependentTodos(dir, ctx, [
      { id: "todo-1", content: "Resolve session blocker", status: "pending" },
    ]);
    const todoStart = await executeSparkTool(tools, "goal", ctx, { action: "start" });
    assert.match(toolText(todoStart), /No Spark project\/task state is available to infer/);
    assert.equal((todoStart.details as { found?: boolean; error?: string }).found, false);
    assert.equal(
      (todoStart.details as { found?: boolean; error?: string }).error,
      "no_inferable_goal",
    );
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal inference describes substantive project outcomes instead of task completion", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({
    title: "Alignment precision",
    description: "Deliver complete alignment across generated reports.",
    purpose: "Complete alignment of precision-sensitive report generation",
    outputLanguage: "en",
  });
  graph.createTask({
    projectRef: project.ref,
    title: "Implement alignment checks",
    description: "Add deterministic checks.",
    status: "ready",
    plan: executionReadyPlan("Add deterministic checks."),
  });

  const objective = inferSessionGoalObjective(graph, project);

  assert.equal(
    objective,
    "Achieve the intended project outcome: Complete alignment of precision-sensitive report generation.",
  );
  assert.doesNotMatch(objective ?? "", /Advance project|to completion|unfinished|ready/i);
});

void test("spark_goal tool sets and updates durable session goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-goal-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createApprovingReviewerRunner(),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "set",
      objective: "Finish the durable goal slice",
    });
    const startedText = toolText(started);
    assert.match(startedText, /Spark session goal active\./);
    assert.doesNotMatch(startedText, /Token budget/);
    assert.doesNotMatch(startedText, /Finish the durable goal slice/);
    assert.equal(
      (started.details as { goal?: { objective?: string; status?: string } } | undefined)?.goal
        ?.objective,
      "Finish the durable goal slice",
    );
    assert.equal(
      (started.details as { goal?: { objective?: string; status?: string } } | undefined)?.goal
        ?.status,
      "active",
    );
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    assert.match(toolText(status), /Session goal: active \| Finish the durable goal slice/);
    assert.doesNotMatch(toolText(status), /tokens/);
    assert.equal(
      (status.details as { sessionGoal?: { objective?: string } } | undefined)?.sessionGoal
        ?.objective,
      "Finish the durable goal slice",
    );

    const paused = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "waiting",
    });
    assert.match(toolText(paused), /Spark session goal paused/);
    assert.match(toolText(paused), /Reason: waiting/);
    const pausedGoal = await loadSessionGoal(dir, ctx);
    assert.ok(pausedGoal);

    const resumed = await executeSparkTool(tools, "goal", ctx, { action: "resume" });
    assert.match(toolText(resumed), /Spark session goal active/);
    assert.equal((await loadSessionGoal(dir, ctx))?.goalId, pausedGoal.goalId);
    assert.equal((await loadSessionGoal(dir, ctx))?.pauseReason, undefined);

    const edited = await executeSparkTool(tools, "goal", ctx, {
      action: "edit",
      objective: "Finish the edited durable goal slice",
      reason: "correct stale description wording without reducing scope",
    });
    assert.match(toolText(edited), /Finish the edited durable goal slice/);
    const editedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(editedGoal?.goalId, pausedGoal.goalId);
    assert.equal(editedGoal?.objective, "Finish the edited durable goal slice");
    assert.equal(editedGoal?.lastReviewRef, undefined);
    assert.equal(editedGoal?.lastReviewArtifactRef, undefined);
    assert.equal(editedGoal?.lastReviewedAt, undefined);

    const completed = await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      reason: "review passed",
    });
    assert.equal(
      (completed.details as { goal?: { status?: string } } | undefined)?.goal?.status,
      "complete",
    );
    assert.equal((await loadSessionGoal(dir, ctx))?.status, "complete");

    await executeSparkTool(tools, "goal", ctx, { action: "clear" });
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal complete uses deterministic blocker before reviewer when work remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-complete-blocker-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await saveCurrentProjectRef(dir, ctx, project.ref);
      graph.createTask({
        projectRef: project.ref,
        name: "unfinished-complete-blocker",
        title: "Unfinished complete blocker",
        description: "Pending task blocks goal completion requests before reviewer calls.",
        status: "pending",
        plan: executionReadyPlan("Unfinished complete blocker"),
      });
    });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish all complete blocker work",
    });

    const completed = await executeSparkTool(tools, "goal", ctx, { action: "complete" });

    assert.equal(reviewerCalls, 0);
    assert.equal(
      (completed.details as { error?: string } | undefined)?.error,
      "goal_completion_needs_changes",
    );
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.ok(goal?.lastReviewedAt);
    assert.equal(goal?.lastReviewArtifactRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal complete allows evidenced narrow goal despite unrelated project backlog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-complete-unrelated-backlog-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let reviewerCalls = 0;
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          reviewerCalls += 1;
          assert.equal(input.targetKind, "goal");
          if (input.targetKind === "goal") {
            assert.equal(input.evidenceRefs.length, 1);
            assert.equal(input.projectStatus?.taskCounts.unfinished, 1);
          }
          return createApprovingReviewerRunner().review(input);
        },
      },
    });
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await saveCurrentProjectRef(dir, ctx, project.ref);
      const doneTask = graph.createTask({
        projectRef: project.ref,
        name: "loop-paused-validation-docs",
        title: "Update docs and run final validation for paused loop lifecycle",
        description: "Completed evidence for the active loop paused lifecycle goal.",
        status: "done",
        plan: executionReadyPlan("Update docs and run final validation for paused loop lifecycle"),
      });
      const evidence = await defaultArtifactStore(dir).put({
        kind: "trace",
        title: "Loop paused lifecycle validation",
        format: "text",
        body: "tsc, lint, boundaries, and tests passed for loop active paused lifecycle.",
        provenance: { producer: "task", projectRef: project.ref, taskRef: doneTask.ref },
      });
      graph.attachOutputArtifact(doneTask.ref, evidence.ref);
      graph.createTask({
        projectRef: project.ref,
        name: "role-tui-observability-backlog",
        title: "Build role TUI observability backlog",
        description:
          "Unrelated future role TUI work must not block the narrow loop lifecycle goal.",
        status: "pending",
        plan: executionReadyPlan("Build role TUI observability backlog"),
      });
    });
    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective:
        "将 Spark 的 /loop 与底层 pi-loop lifecycle 统一为 active/paused 语义，并完成持久前台驱动、/goal 互斥、widget 展示、文档与验证对齐。",
    });

    await executeSparkTool(tools, "goal", ctx, { action: "complete" });

    assert.equal(reviewerCalls, 1);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
    assert.ok(goal?.lastReviewArtifactRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal pause requires reviewer approval and preserves active goal on rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-pause-review-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createRejectingReviewerRunner("pause reason is not justified"),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Pause review" });

    await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Keep working until blocker is real",
    });
    const rejected = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "maybe stop",
    });

    assert.equal((rejected.details as { error?: string }).error, "goal_pause_review_failed");
    assert.match(toolText(rejected), /Goal pause blocked by reviewer/);
    assert.match(toolText(rejected), /pause reason is not justified/);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal rejects autonomous pause and keeps blocker resolution guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-autonomous-pause-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createApprovingReviewerRunner(),
    });
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Autonomous pause" });
    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Resolve blockers without lowering the goal",
    });
    const goalId = (started.details as { goal?: { goalId?: string } }).goal?.goalId;
    assert.ok(goalId);
    (ctx as SparkToolContext).sparkAutonomousGoalTurn = { goalId };

    const rejected = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      reason: "blocked by hard work",
    });

    assert.equal((rejected.details as { error?: string }).error, "autonomous_goal_pause_forbidden");
    assert.match(toolText(rejected), /Autonomous goal pause is not allowed/);
    assert.match(toolText(rejected), /resolve the blocker first/);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal((await defaultArtifactStore(dir).list({ kind: "record" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal start updates the active session goal in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-session-update-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, {
      project: "Tool persistence",
    });

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the session-scoped slice",
    });
    const startedText = toolText(started);
    assert.match(startedText, /Spark session goal active\./);
    assert.doesNotMatch(startedText, /Finish the session-scoped slice/);
    const firstGoalId = (started.details as { goal?: { goalId?: string } } | undefined)?.goal
      ?.goalId;
    assert.ok(firstGoalId);

    const updated = await executeSparkTool(tools, "goal", ctx, {
      action: "set",
      objective: "Finish the updated session slice",
    });
    assert.match(toolText(updated), /Spark session goal active\./);
    const updatedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(updatedGoal?.goalId, firstGoalId);
    assert.equal(updatedGoal?.objective, "Finish the updated session slice");

    const status = await executeSparkTool(tools, "goal", ctx, { action: "status" });
    assert.match(toolText(status), /Spark session goal active/);
    assert.match(toolText(status), /Goal: Finish the updated session slice/);
    assert.doesNotMatch(toolText(status), /Project\(/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/implement canonical ask uses UI instead of reviewer auto-answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-implement-ask-ui-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let answerAskCalls = 0;
    ctx.ui.select = async (_title, options) => {
      assert.ok(options.includes("Safe path"));
      return "Safe path";
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "should not auto-answer outside active goal mode" };
        },
      },
    });
    await useOnlySparkProject(run.tools, ctx);

    const implementCommand = run.commands.get("implement");
    assert.ok(implementCommand, "missing /implement command");
    await implementCommand.handler("work until a human decision is needed", ctx);
    assert.deepEqual(ctx.sparkActiveLens, { mode: "implement", driver: "interactive" });

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          label: "Mode",
          prompt: "Which path should implement mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });

    assert.equal(answerAskCalls, 0);
    assert.notEqual((asked.details as { autoAnswered?: boolean }).autoAnswered, true);
    assert.equal(
      (asked.details as { result?: { answers?: { mode?: { values?: string[] } } } }).result?.answers
        ?.mode?.values?.[0],
      "safe_mode",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/implement canonical ask does not inherit active goal reviewer auto-answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-implement-ask-active-goal-ui-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    let answerAskCalls = 0;
    let uiSelectCalls = 0;
    ctx.ui.select = async (_title, options) => {
      uiSelectCalls += 1;
      assert.ok(options.includes("Safe path"));
      return "Safe path";
    };
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          answerAskCalls += 1;
          return { blocked: true, reason: "implement must not inherit goal auto-answer" };
        },
      },
    });
    await executeSparkTool(run.tools, "impl_use_project", ctx, {
      project: "Implement ask active goal",
    });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Keep a goal active before manual implement mode",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);
    assert.equal(ctx.askAutoAnswer, "reviewer");

    const implementCommand = run.commands.get("implement");
    assert.ok(implementCommand, "missing /implement command");
    await implementCommand.handler("manual implementation should block for human asks", ctx);
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);
    assert.equal(ctx.askAutoAnswer, undefined);

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          label: "Mode",
          prompt: "Which path should manual implement mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });

    assert.equal(answerAskCalls, 0);
    assert.equal(uiSelectCalls, 1);
    assert.notEqual((asked.details as { autoAnswered?: boolean }).autoAnswered, true);
    assert.equal(
      (asked.details as { result?: { answers?: { mode?: { values?: string[] } } } }).result?.answers
        ?.mode?.values?.[0],
      "safe_mode",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active goal canonical ask uses reviewer auto-answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-ask-auto-answer-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("goal auto-answer should not invoke select UI");
    let answerAskRequest: unknown;
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk(input) {
          answerAskRequest = input.request;
          return {
            reason: "reviewer selected the safe continuation",
            answers: { mode: { values: ["safe_mode"] } },
          };
        },
      },
    });
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Goal ask" });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Use reviewer backed asks",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          label: "Mode",
          prompt: "Which path should goal mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });

    assert.ok(answerAskRequest);
    assert.equal((asked.details as { autoAnswered?: boolean }).autoAnswered, true);
    assert.equal(
      (asked.details as { result?: { answers?: { mode?: { values?: string[] } } } }).result?.answers
        ?.mode?.values?.[0],
      "safe_mode",
    );
    assert.equal(
      (asked.details as { autoAnswer?: { reason?: string } }).autoAnswer?.reason,
      "reviewer selected the safe continuation",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active goal canonical ask reports reviewer auto-answer blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-ask-auto-answer-blocker-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest({
      reviewerRunner: {
        async review(input: ReviewInput): Promise<ReviewerRunResult> {
          return createTaskApprovingGoalUnmetReviewerRunner().review(input);
        },
        async answerAsk() {
          return { blocked: true, reason: "reviewer needs more repository evidence" };
        },
      },
    });
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Goal ask blocker" });
    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Surface reviewer ask blockers",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) await handler({}, ctx);

    const asked = await executeSparkTool(run.tools, "ask", ctx, {
      title: "Choose path",
      mode: "decision",
      questions: [
        {
          id: "mode",
          label: "Mode",
          prompt: "Which path should goal mode take?",
          type: "single",
          options: [{ label: "Safe path", value: "safe_mode" }],
        },
      ],
    });

    assert.equal((asked.details as { blocked?: boolean }).blocked, true);
    assert.equal((asked.details as { autoAnswered?: boolean }).autoAnswered, false);
    assert.match(
      (asked.details as { reason?: string }).reason ?? "",
      /reviewer needs more repository evidence/,
    );
    assert.match(toolText(asked), /Ask auto-answer blocked/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active session goal keeps canonical ask but disables raw ask tools before agent turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-disable-asks-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Tool persistence" });
    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.ok(!run.getActiveToolNames().some((name) => name.startsWith("spark_")));

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Run without interactive asks",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }

    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.equal((ctx as SparkToolContext).askAutoAnswer, "reviewer");
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.ok(run.getActiveToolNames().includes("goal"));
    assert.ok(!run.getActiveToolNames().includes("task"));
    assert.ok(run.getActiveToolNames().includes("task_read"));
    assert.ok(run.getActiveToolNames().includes("task_write"));
    assert.ok(run.getActiveToolNames().includes("assign"));

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "waiting",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }

    assert.ok(run.getActiveToolNames().includes("ask"));
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active session goal preserves tools disabled by other extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-preserve-disabled-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "impl_use_project", ctx, { project: "Preserve disabled" });

    // Simulate another extension (pi-cue) that registers `bash` and then
    // deactivates it at session start, leaving it registered-but-inactive.
    run.registerActiveTool("bash");
    run.setActiveTools(run.getActiveToolNames().filter((name) => name !== "bash"));
    assert.ok(!run.getActiveToolNames().includes("bash"), "bash starts disabled");

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Run without re-enabling bash",
    });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }
    assert.ok(
      !run.getActiveToolNames().includes("bash"),
      "goal activation must not re-enable an externally disabled tool",
    );

    await executeSparkTool(run.tools, "goal", ctx, { action: "pause", reason: "waiting" });
    for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
      await handler({}, ctx);
    }
    assert.ok(
      !run.getActiveToolNames().includes("bash"),
      "goal deactivation must not re-enable an externally disabled tool",
    );
    assert.ok(run.getActiveToolNames().includes("ask"), "ask is restored after goal ends");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark project tools reject invalid explicit parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    assert.match(JSON.stringify(tools.get("impl_use_project")?.parameters), /purpose/);
    assert.match(JSON.stringify(tools.get("task_write")?.parameters), /Project purpose/);

    await assert.rejects(
      () => executeSparkTool(tools, "impl_project_mutation", ctx, { intent: "rename", title: "" }),
      /title must be a non-empty string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_project_mutation", ctx, {
          intent: "rename",
          project: 42,
          title: "Next",
        }),
      /project must be a string/,
    );
    const statusOnly = await executeSparkTool(tools, "impl_project_mutation", ctx, {
      intent: "metadata_update",
      status: "archived",
    });
    assert.equal(statusOnly.isError, true);
    assert.equal((statusOnly.details as { error?: string }).error, "project_status_removed");
    await assert.rejects(
      () => executeSparkTool(tools, "impl_use_project", ctx, { project: "" }),
      /project must be a non-empty string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_use_project", ctx, { title: "New", outputLanguage: "jp" }),
      /outputLanguage must be zh or en/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension exposes canonical tools instead of removed spark_* tools", () => {
  const run = registerSparkToolsForTest();
  assert.equal(run.tools.has("task"), false);
  assert.ok(run.tools.has("task_read"));
  assert.ok(run.tools.has("task_write"));
  assert.ok(run.tools.has("assign"));
  assert.ok(run.tools.has("learning"));
  assert.ok(run.tools.has("ask"));
  assert.ok(run.tools.has("goal"));
  assert.ok(run.tools.has("mode"));
  assert.deepEqual(
    run
      .getActiveToolNames()
      .filter((name) => name.startsWith("spark_"))
      .sort(),
    [],
  );
});

void test("mode tool returns per-turn Spark lens requirements without persisted mode state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-mode-tool-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });

    const switched = await executeSparkTool(tools, "mode", ctx, {
      action: "plan",
      focus: "tighten task graph",
    });
    assert.deepEqual(switched.details, { mode: "plan", statusOnly: false });
    assert.deepEqual(await loadSparkMode(dir, ctx), {
      mode: "research",
      projectRef: (await loadCurrentProjectState(dir, ctx))?.projectRef,
    });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_plan_tasks describes the public spark-tasks readiness contract", () => {
  const { tools } = registerSparkToolsForTest();
  const planTool = tools.get("impl_plan_tasks");
  assert.ok(planTool);
  assert.match(planTool.description, /Readiness rules:/);
  assert.ok(planTool.description.includes(renderTaskPlanReadinessRules()));
  assert.match(planTool.description, /dependsOn resolution is active-project scoped/);
});

void test("impl_list_projects returns structured permanent project summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-list-projects-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [activeProject] = graph.projects();
    assert.ok(activeProject);
    const doneProject = graph.createProject({
      title: "Finished project",
      description: "Project with only finished work.",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "active-work",
      title: "Active work",
      description: "Active work item.",
      status: "pending",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "finished-work",
      title: "Finished work",
      description: "Finished work item.",
      status: "done",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      name: "cancelled-work",
      title: "Cancelled work",
      description: "Cancelled work item.",
      status: "cancelled",
    });
    graph.createTask({
      projectRef: doneProject.ref,
      name: "done-project-work",
      title: "Done project work",
      description: "Done project work item.",
      status: "done",
    });
    await store.save(graph);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "impl_use_project", ctx, { project: activeProject.ref });

    const projects = JSON.parse(
      toolText(await executeSparkTool(tools, "impl_list_projects", ctx, {})),
    ) as Array<{
      ref: string;
      currentForSession: boolean;
      taskCounts: { total: number; active: number; done: number; cancelled: number };
    }>;
    assert.deepEqual(
      projects.map((project) => project.ref),
      [activeProject.ref, doneProject.ref],
    );
    assert.equal(projects[0]?.currentForSession, true);
    assert.equal(projects[1]?.currentForSession, false);
    assert.deepEqual(projects[0]?.taskCounts, { total: 3, active: 1, done: 1, cancelled: 1 });
    assert.deepEqual(projects[1]?.taskCounts, { total: 1, active: 0, done: 1, cancelled: 0 });
    assert.equal(Object.hasOwn(projects[0] ?? {}, "status"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status does not activate an arbitrary project for the Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-no-auto-project-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-no-auto");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const statusText = toolText(status);

    assert.doesNotMatch(statusText, /\[current\]/);
    assert.match(statusText, /Spark available: no project selected/);
    assert.doesNotMatch(statusText, /Project Tool persistence/);
    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Tool persistence/);
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, undefined);
    await assert.rejects(() => readFile(currentProjectStatePath(dir, ctx), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status surfaces corrupt current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-corrupt-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-corrupt-sessions");
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
    await writeFile(currentProjectStatePath(dir, ctx), "{not-json", "utf8");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, {}),
      (error) =>
        error instanceof JsonStoreFormatError &&
        /not valid JSON/.test(error.message) &&
        /sessions/.test(error.filePath),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status rejects non-object current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-non-object-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-non-object-sessions");
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });
    await writeFile(currentProjectStatePath(dir, ctx), "[]\n", "utf8");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, {}),
      (error) =>
        error instanceof JsonStoreFormatError &&
        /JSON root must be an object/.test(error.message) &&
        /sessions/.test(error.filePath),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session cache stores write JSON atomically without tmp leftovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-cache-atomic-"));
  try {
    const ctx = testSparkContext(dir, "cache-atomic");
    await saveCurrentProjectRef(dir, ctx, newRef("proj", "cache-atomic-project"));
    await saveIndependentTodos(dir, ctx, [
      { id: "todo-one", content: "One", status: "in_progress" },
    ]);
    const displayNumbers = await loadTodoDisplayNumberState(dir, ctx);
    assert.equal(assignTodoDisplayNumber(displayNumbers, "todo:one"), 1);
    await saveTodoDisplayNumberState(dir, ctx, displayNumbers);

    assert.deepEqual(
      (await readdir(join(dir, ".spark", "sessions"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      (await readdir(join(dir, ".spark", "todos"))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(
      (await readdir(sessionDirectoryPath(dir, ctx))).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("current project store ignores legacy mode and run control blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-sessions-invalid-"));
  try {
    const ctx = testSparkContext(dir, "sessions-invalid");
    const stateFile = currentProjectStatePath(dir, ctx);
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(stateFile, `${JSON.stringify({ projectRef: "proj:legacy" })}\n`, "utf8");
    assert.deepEqual(await loadCurrentProjectState(dir, ctx), {
      version: 1,
      projectRef: "proj:legacy",
    });

    await writeFile(
      stateFile,
      `${JSON.stringify({ version: 2, projectRef: "proj:demo" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(stateFile, `${JSON.stringify({ version: 1, projectRef: 42 })}\n`, "utf8");
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /projectRef must be a non-empty string/.test(error.message),
    );

    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        projectRef: "proj:demo",
        planningMode: { version: 1, projectRef: "proj:demo", source: "direct" },
        executionMode: {
          version: 1,
          projectRef: "proj:demo",
          kind: "single_task",
          enteredAt: "2026-05-28T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    assert.deepEqual(await loadCurrentProjectState(dir, ctx), {
      version: 1,
      projectRef: "proj:demo",
    });

    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        projectRef: "proj:demo",
        runMode: {
          version: 1,
          runRef: "run:demo",
          projectRef: "proj:demo",
          status: "waiting",
          enteredAt: "2026-05-28T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    const runControlState = await loadCurrentProjectState(dir, ctx);
    assert.deepEqual(runControlState, { version: 1, projectRef: "proj:demo" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("permanent projects remain visible as current selection without lifecycle reactivation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-permanent-project-current-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const doneProject = graph.createProject({
      title: "Completed workflow",
      description: "Should remain current for history visibility.",
    });
    graph.createProject({
      title: "Next workflow",
      description: "Should not become current automatically.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "impl_use_project", ctx, { project: doneProject.ref });
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, doneProject.ref);
    assert.doesNotMatch(toolText(status), /Spark available: no project selected/);
    assert.doesNotMatch(toolText(status), /Next workflow \[current\]/);
    assert.match(toolText(status), /Completed workflow \[current\]/);
    assert.doesNotMatch(toolText(status), /\[done\]/);
    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Completed workflow \[current\]/);
    assert.doesNotMatch(toolText(summary), /\[done\]/);

    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, doneProject.ref);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status includes persisted Spark orchestrator status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 3,
      timeoutMs: 456,
    });
    await dagStore.finishRun(dagRun.ref, { scheduled: 2, completed: 1, timedOut: true });
    const staleRun = await dagStore.startRun({
      ownerSessionId: "session:parent",
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);

    assert.match(text, /Spark workflow runs: idle actionable=run:/);
    assert.match(text, /actionable=2/);
    assert.doesNotMatch(text, /stale=1/);
    assert.doesNotMatch(text, /timed_out=1/);
    assert.match(
      text,
      new RegExp(
        `Actionable workflow run: ${staleRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.match(text, /Next steps \(stale\):/);
    assert.match(text, /stale: run task_read\(\{ action: "run_status"/);
    const workflowRunDetails = status.details as {
      workflowRunStatus?: {
        stale?: number;
        timedOut?: number;
        nextSteps?: Array<{ status: string; nextActions: string[] }>;
      };
    };
    assert.equal(workflowRunDetails.workflowRunStatus?.stale, 1);
    assert.equal(workflowRunDetails.workflowRunStatus?.timedOut, 1);
    assert.equal(workflowRunDetails.workflowRunStatus?.nextSteps?.[0]?.status, "stale");
    assert.match(
      workflowRunDetails.workflowRunStatus?.nextSteps?.[0]?.nextActions.join("\n") ?? "",
      /stale:/,
    );
    assert.deepEqual(
      workflowRunDetails.workflowRunStatus?.nextSteps?.map((step) => step.status),
      ["stale", "timed_out"],
    );
    assert.match(
      workflowRunDetails.workflowRunStatus?.nextSteps?.[1]?.nextActions.join("\n") ?? "",
      /timed_out: historical foreground timeout record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status reconciles DAG runs with current workspace active children only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-cwd-"));
  const otherDir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-other-cwd-"));
  let otherRunRef: RunRef | undefined;
  let otherRunPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const otherGraph = new TaskGraph();
    const otherProject = otherGraph.createProject({
      title: "Other workspace",
      description: "Owns an unrelated active child process.",
    });
    const otherTask = otherGraph.createTask({
      projectRef: otherProject.ref,
      name: "other-child",
      title: "Other child",
      description: "Keep an unrelated role-run active in another workspace.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Other child"),
    });
    const fakePi = join(otherDir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    otherRunPromise = runSparkTask({
      graph: otherGraph,
      taskRef: otherTask.ref,
      registry: new RoleRegistry(),
      cwd: otherDir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: "session:other-workspace" },
    }).catch((error: unknown) => error);
    await waitFor(() => {
      const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === otherDir);
      otherRunRef = active?.runRef;
      return Boolean(active);
    }, 5_000);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      false,
    );

    const currentDagRun = await defaultWorkflowRunStore(dir).startRun({
      ownerSessionId: ctxSessionKey(ctx),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);
    assert.match(
      text,
      new RegExp(
        `Actionable workflow run: ${currentDagRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.doesNotMatch(text, new RegExp(`Active workflow run: ${currentDagRun.ref}`));
    const dagStatus = await defaultWorkflowRunStore(dir).status();
    assert.equal(dagStatus.running, 0);
    assert.equal(dagStatus.stale, 1);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === otherRunRef),
      true,
    );
  } finally {
    if (otherRunRef)
      await killActiveSparkRoleRunProcesses({
        runRef: otherRunRef,
        forceAfterMs: 0,
        waitMs: 1_000,
      });
    await otherRunPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_workflow_runs kill_active only targets current workspace role-runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-run-kill-active-cwd-"));
  const otherDir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-run-kill-active-other-cwd-"));
  let otherRunRef: RunRef | undefined;
  let otherRunPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const otherGraph = new TaskGraph();
    const otherProject = otherGraph.createProject({
      title: "Other workspace",
      description: "Owns an unrelated active child process.",
    });
    const otherTask = otherGraph.createTask({
      projectRef: otherProject.ref,
      name: "other-child",
      title: "Other child",
      description: "Keep an unrelated role-run active in another workspace.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Other child"),
    });
    const fakePi = join(otherDir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    otherRunPromise = runSparkTask({
      graph: otherGraph,
      taskRef: otherTask.ref,
      registry: new RoleRegistry(),
      cwd: otherDir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: "session:other-workspace" },
    }).catch((error: unknown) => error);
    await waitFor(() => {
      const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === otherDir);
      otherRunRef = active?.runRef;
      return Boolean(active);
    }, 5_000);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      false,
    );

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill_active",
    });

    assert.match(toolText(result), /Stopped background child runs: 0/);
    assert.equal(((result.details as { killed?: unknown[] }).killed ?? []).length, 0);
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === otherRunRef),
      true,
    );
  } finally {
    if (otherRunRef)
      await killActiveSparkRoleRunProcesses({
        runRef: otherRunRef,
        forceAfterMs: 0,
        waitMs: 1_000,
      });
    await otherRunPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(otherDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_status includes active dynamic workflow snapshot projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-dynamic-workflow-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const store = defaultSparkDynamicWorkflowEventStore(dir);
    const runRef = "run:abcdef12-status" as const;
    await store.startRun({
      runRef,
      source: { kind: "inline", label: "inline workflow" },
      script:
        "export const meta = { name: 'status live', description: 'status live workflow' }\nreturn 'ok'",
      meta: { name: "status live", description: "status live workflow" },
      options: {},
      now: "2026-06-23T00:00:00.000Z",
    });
    await store.appendEvent(runRef, {
      type: "phase_started",
      nodeId: "phase:Watch",
      parentId: "run",
      nodeKind: "phase",
      title: "Watch",
      phase: "Watch",
      timestamp: "2026-06-23T00:00:01.000Z",
    });
    const resultRun = await store.start({
      source: { kind: "inline", label: "completed inline workflow" },
      script:
        "export const meta = { name: 'status result', description: 'status result workflow' }\nreturn 'ok'",
      meta: { name: "status result", description: "status result workflow" },
      options: {},
      now: "2026-06-23T00:00:02.000Z",
    });
    await store.finish(resultRun.ref, {
      meta: { name: "status result", description: "status result workflow" },
      result: { report: "ready" },
      phases: [],
      agentCount: 0,
      journal: [],
    });

    const status = await executeSparkTool(tools, "impl_status", ctx, { scope: "workspace" });
    const text = toolText(status);
    assert.match(text, /Dynamic workflow runs: running=1/);
    assert.match(text, /Dynamic workflow result inbox: 1 undelivered/);
    assert.ok(
      text.includes(`Result: ${resultRun.ref} [succeeded] status result · {"report":"ready"}`),
    );
    assert.match(
      text,
      new RegExp(`Active dynamic workflow: ${runRef} \\[running\\] status live nodes=0/2`),
    );
    const details = status.details as {
      dynamicWorkflowRuns?: {
        active?: Array<{ ref?: string; completedNodes?: number; totalNodes?: number }>;
        resultInbox?: Array<{ runRef?: string; status?: string; resultPreview?: string }>;
      };
    };
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.ref, runRef);
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.completedNodes, 0);
    assert.equal(details.dynamicWorkflowRuns?.active?.[0]?.totalNodes, 2);
    assert.equal(details.dynamicWorkflowRuns?.resultInbox?.[0]?.runRef, resultRun.ref);
    assert.equal(
      details.dynamicWorkflowRuns?.resultInbox?.[0]?.resultPreview,
      '{"report":"ready"}',
    );

    await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
      runRef: resultRun.ref,
    });
    const acknowledgedStatus = await executeSparkTool(tools, "impl_status", ctx, {
      scope: "workspace",
    });
    assert.doesNotMatch(toolText(acknowledgedStatus), /Dynamic workflow result inbox/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs renders and controls dynamic workflow_run records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dynamic-workflow-runs-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Dynamic workflows", description: "demo" });
    await defaultTaskGraphStore(dir).save(graph);
    await executeSparkTool(tools, "impl_use_project", ctx, { project: project.ref });
    const dynamicStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script =
      "export const meta = { name: 'control', description: 'control workflow' }\nreturn 'ok'";
    const meta = { name: "control", description: "control workflow" };

    const failedRun = await dynamicStore.start({
      source: { kind: "inline", label: "failed control workflow" },
      script,
      meta,
      options: {},
    });
    await dynamicStore.recordJournal(failedRun.ref, {
      index: 0,
      hash: "failedabc123",
      result: "partial child output",
    });
    await dynamicStore.fail(failedRun.ref, new Error("agent boom"));

    const staleRun = await dynamicStore.start({
      source: { kind: "inline", label: "stale control workflow" },
      script,
      meta,
      options: {},
      now: "2000-01-01T00:00:00.000Z",
    });
    await dynamicStore.reconcileStale({ now: "2000-01-01T01:00:00.000Z", staleAfterMs: 1_000 });

    const completedRun = await dynamicStore.start({
      source: { kind: "inline", label: "completed control workflow" },
      script,
      meta,
      options: {},
    });
    await dynamicStore.finish(completedRun.ref, {
      meta,
      result: { report: "delivered" },
      phases: [
        {
          title: "Synthesis",
          status: "success",
          startedAt: "2026-06-22T00:00:00.000Z",
          finishedAt: "2026-06-22T00:00:02.000Z",
        },
      ],
      agentCount: 1,
      journal: [{ index: 0, hash: "doneabc12345", result: "compact child output" }],
    });

    const pausedRun = await dynamicStore.start({
      source: { kind: "inline", label: "paused control workflow" },
      script,
      meta,
      options: {},
    });
    await dynamicStore.pause(pausedRun.ref);

    const run = await dynamicStore.start({
      source: { kind: "inline", label: "running control workflow" },
      script,
      meta,
      options: { concurrency: 2 },
      base: {
        baseRef: "graft:test",
        baseState: "state:test",
        baseTree: "tree:test",
        capturedAt: "2026-06-22T00:00:00.000Z",
      },
    });
    await dynamicStore.recordPhase(run.ref, {
      title: "Plan",
      status: "success",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
    });
    await dynamicStore.recordJournal(run.ref, { index: 0, hash: "abc123def456", result: "ok" });

    const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
      includeHistory: true,
    });
    const statusText = toolText(status);
    assert.match(
      statusText,
      /Dynamic workflow runs: runs=5 running=1 paused=1 failed=1 stale=1 stopped=0 succeeded=1 acknowledged=0/,
    );
    assert.match(statusText, /running control workflow/);
    assert.match(statusText, /failed control workflow/);
    assert.match(statusText, /stale control workflow/);
    assert.match(statusText, /paused control workflow/);
    assert.match(statusText, /completed control workflow/);
    assert.match(statusText, /Spark dynamic workflow dashboard \(status\)/);
    assert.match(statusText, /Tree:/);
    assert.match(statusText, /Event tail:/);
    assert.doesNotMatch(statusText, /Agent journal tail/);
    const statusDetails = status.details as {
      dynamicWorkflowRuns?: {
        dashboard?: {
          runs?: Array<{
            ref?: string;
            controls?: string[];
            tree?: unknown[];
            eventTail?: unknown[];
          }>;
        };
      };
    };
    const dashboardRun = statusDetails.dynamicWorkflowRuns?.dashboard?.runs?.find(
      (candidate) => candidate.ref === run.ref,
    );
    assert.ok(dashboardRun, "expected dynamic workflow dashboard view-model for running run");
    assert.deepEqual(dashboardRun.controls, ["inspect", "pause", "stop", "save"]);
    assert.ok((dashboardRun.tree?.length ?? 0) > 0);
    assert.ok((dashboardRun.eventTail?.length ?? 0) > 0);

    const inspectedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: run.ref,
    });
    const inspectedRunText = toolText(inspectedRun);
    assert.match(inspectedRunText, /Plan: success/);
    assert.match(inspectedRunText, /Timeline: ✓ Plan/);
    assert.match(inspectedRunText, /Controls: inspect runRef=.* · pause · stop/);
    assert.match(inspectedRunText, /Base: ref=graft:test state=state:test tree=tree:test/);
    assert.match(inspectedRunText, /result=ok/);

    const inspectedFailedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: failedRun.ref,
    });
    assert.match(toolText(inspectedFailedRun), /Error: agent boom/);

    const inspectedCompletedRun = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: completedRun.ref,
    });
    assert.match(toolText(inspectedCompletedRun), /Controls: inspect runRef=.* · save · ack/);
    assert.match(toolText(inspectedCompletedRun), /Result: \{"report":"delivered"\}/);
    assert.match(toolText(inspectedCompletedRun), /result=compact child output/);

    const paused = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "pause",
      runRef: run.ref,
    });
    assert.match(toolText(paused), new RegExp(`Dynamic workflow pause: ${run.ref} -> paused`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "paused");

    const resumed = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "resume",
      runRef: run.ref,
    });
    assert.match(toolText(resumed), new RegExp(`Dynamic workflow resume: ${run.ref} -> running`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");

    const stopped = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "stop",
      runRef: run.ref,
    });
    assert.match(toolText(stopped), new RegExp(`Dynamic workflow stop: ${run.ref} -> stopped`));
    assert.equal((await dynamicStore.get(run.ref))?.status, "stopped");

    const restarted = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "restart",
      runRef: run.ref,
    });
    assert.match(toolText(restarted), /workflow_run\(\{ runRef:/);
    const restartedRecord = await dynamicStore.get(run.ref);
    assert.equal(restartedRecord?.status, "running");
    assert.equal(restartedRecord?.journal.length, 0);
    assert.equal(restartedRecord?.phases.length, 0);

    const failedRestart = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "restart",
      runRef: failedRun.ref,
    });
    assert.match(
      toolText(failedRestart),
      new RegExp(`Dynamic workflow restart: ${failedRun.ref} -> running`),
    );
    assert.equal((await dynamicStore.get(failedRun.ref))?.status, "running");

    const staleResume = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "resume",
      runRef: staleRun.ref,
    });
    assert.match(
      toolText(staleResume),
      new RegExp(`Dynamic workflow resume: ${staleRun.ref} -> running`),
    );
    assert.equal((await dynamicStore.get(staleRun.ref))?.status, "running");

    const saved = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "save",
      runRef: completedRun.ref,
      workflowId: "completed-control",
    });
    assert.match(toolText(saved), /Dynamic workflow save:/);
    assert.match(toolText(saved), /workspace:completed-control/);
    assert.equal(existsSync(join(dir, ".spark", "workflows", "completed-control.js")), true);
    assert.equal(
      (await dynamicStore.get(completedRun.ref))?.savedWorkflow?.selector,
      "workspace:completed-control",
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
      runRef: completedRun.ref,
    });
    assert.match(toolText(acknowledged), /Dynamic workflow ack: acknowledged=1/);
    assert.ok((await dynamicStore.get(completedRun.ref))?.acknowledgedAt);

    const compactStatus = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
    });
    assert.doesNotMatch(toolText(compactStatus), new RegExp(completedRun.ref));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("workflow run slash commands expose direct dashboard controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workflow-run-slash-controls-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { commands } = registerSparkToolsForTest();
    const dynamicStore = defaultSparkDynamicWorkflowEventStore(dir);
    const script =
      "export const meta = { name: 'slash control', description: 'slash command workflow controls' }\nreturn 'ok'";
    const run = await dynamicStore.start({
      source: { kind: "inline", label: "slash control workflow" },
      script,
      meta: { name: "slash control", description: "slash command workflow controls" },
      options: {},
    });

    const dashboard = commands.get("workflow-runs");
    const inspect = commands.get("workflow-inspect");
    const pause = commands.get("workflow-pause");
    const resume = commands.get("workflow-resume");
    const stop = commands.get("workflow-stop");
    const restart = commands.get("workflow-restart");
    const save = commands.get("workflow-save");
    assert.ok(dashboard, "missing /workflow-runs");
    assert.ok(inspect, "missing /workflow-inspect");
    assert.ok(pause, "missing /workflow-pause");
    assert.ok(resume, "missing /workflow-resume");
    assert.ok(stop, "missing /workflow-stop");
    assert.ok(restart, "missing /workflow-restart");
    assert.ok(save, "missing /workflow-save");

    await dashboard.handler(run.ref, ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark dynamic workflow dashboard/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", new RegExp(run.ref));
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Actions: inspect, pause, stop, save/);

    await inspect.handler(run.ref, ctx);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Selected: run:/);

    await pause.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "paused");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: pause .* -> paused/);

    await resume.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: resume .* -> running/);

    await stop.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "stopped");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: stop .* -> stopped/);

    await restart.handler(run.ref, ctx);
    assert.equal((await dynamicStore.get(run.ref))?.status, "running");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Control: restart .* -> running/);

    await save.handler(run.ref, ctx);
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /Control: save .* -> workspace:slash-control/,
    );
    assert.match(
      (await dynamicStore.get(run.ref))?.savedWorkflow?.selector ?? "",
      /^workspace:slash-control/u,
    );

    await assert.rejects(async () => pause.handler("", ctx), /\/workflow-pause requires a runRef/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs rejects invalid explicit control parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "acknowledge" }),
      /task_read run_status action must be status, list, inspect, pause, resume, stop, restart, save, kill, reply, steer, reconcile, ack, prune, clear_inactive, or kill_active/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "ack", runRef: "task:one" }),
      /task_read run_status runRef must be a run ref/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "impl_workflow_runs", ctx, { action: "prune", dryRun: "true" }),
      /task_read run_status dryRun must be a boolean/,
    );

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_workflow_runs", ctx, {
          action: "prune",
          keepRecent: 1.5,
        }),
      /task_read run_status keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs reply and steer require one active visible role-run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-reply-no-active-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update((graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      const task = graph.createTask({
        projectRef: project.ref,
        name: "waiting-role",
        title: "Waiting role",
        description: "Pretend a role is waiting but has no active process.",
        kind: "implement",
        status: "running",
        roleRef: "role:builtin-worker" as RoleRef,
        plan: executionReadyPlan("Waiting role"),
      });
      graph.recordRun({
        ref: "run:waiting-role" as RunRef,
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-worker" as RoleRef,
        runName: "worker-waiting",
        ownerSessionId: "session:parent",
        status: "running",
        startedAt: new Date().toISOString(),
        outputArtifacts: [],
      });
    });
    const { tools } = registerSparkToolsForTest();

    const reply = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      taskRef: "waiting-role",
      message: "continue",
    });
    assert.match(toolText(reply), /control_requires_active_target/);
    assert.match(toolText(reply), /No active background role-run process matched/);
    const details = reply.details as { background?: { error?: string; childRuns?: unknown[] } };
    assert.equal(details.background?.error, "control_requires_active_target");
    assert.equal(details.background?.childRuns?.length, 1);

    const steer = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "steer",
      message: "focus on tests",
    });
    assert.match(toolText(steer), /control_requires_active_target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs reconciles and clears inactive records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const finished = await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(finished.ref, { scheduled: 0, completed: 0, timedOut: false });
    await dagStore.startRun({
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });

    const { tools } = registerSparkToolsForTest();
    const reconciled = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /Reconciled workflow records changed: 1/);
    assert.match(toolText(reconciled), /Background work: stale/);
    assert.match(toolText(reconciled), /Next: reconcile with task runs and active processes/);
    const reconciledDetails = reconciled.details as {
      background?: {
        summary?: { state?: string };
        runs?: Array<{ status?: string; nextActions?: string[] }>;
      };
    };
    assert.equal(reconciledDetails.background?.summary?.state, "stale");
    assert.match(
      reconciledDetails.background?.runs?.[0]?.nextActions?.join("\n") ?? "",
      /reconcile with task runs and active processes/,
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /Acknowledged background problem runs: 1 newly/);
    assert.doesNotMatch(toolText(acknowledged), /Next: reconcile with task runs/);
    const acknowledgedDetails = acknowledged.details as {
      background?: {
        acknowledged?: { acknowledged?: string[] };
        runs?: Array<{ acknowledgedBySession?: string }>;
      };
    };
    assert.equal(acknowledgedDetails.background?.acknowledged?.acknowledged?.length, 1);
    const ackSnapshot = await dagStore.load();
    assert.equal(
      ackSnapshot.runs.find((run) => run.acknowledgedBySession)?.acknowledgedBySession,
      ctxSessionKey(ctx),
    );

    const compactStatus = await executeSparkTool(tools, "impl_status", ctx, {});
    assert.doesNotMatch(toolText(compactStatus), /Spark workflow runs:/);
    assert.doesNotMatch(toolText(compactStatus), /stale=1/);

    const historicalRuns = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "list",
      includeHistory: true,
    });
    assert.match(toolText(historicalRuns), /Background work: idle/);
    assert.equal(
      (historicalRuns.details as { background?: { runs?: unknown[] } }).background?.runs?.length,
      2,
    );

    const cleared = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "clear_inactive",
    });
    assert.match(toolText(cleared), /Background work: idle/);
    assert.equal(
      (cleared.details as { background?: { runs?: unknown[] } }).background?.runs?.length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state workflow_run_prune defaults to dry-run and does not write workflow run store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-prune-dryrun-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultWorkflowRunStore(dir);
    const run = await dagStore.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await dagStore.finishRun(run.ref, { scheduled: 0, completed: 0, timedOut: false });
    const before = await readFile(join(dir, ".spark", "workflow-runs.json"), "utf8");

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "workflow_run_prune",
      olderThanDays: 0,
      keepRecent: 0,
      keepRecentPerProject: 0,
    });

    assert.match(toolText(result), /Spark workflow-run prune dry-run/);
    assert.match(toolText(result), /Candidates: 1; kept=0/);
    const prune = (result.details as { prune?: { dryRun?: boolean; candidates?: unknown[] } })
      .prune;
    assert.equal(prune?.dryRun, true);
    assert.equal(prune?.candidates?.length, 1);
    assert.equal(await readFile(join(dir, ".spark", "workflow-runs.json"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs exposes active child runs and refuses broad kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-active-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const roleStatuses: Array<{ key: string; text: string | undefined }> = [];
    const roleWidgets: Array<{ key: string; value: unknown; placement?: string }> = [];
    ctx.ui.setStatus = (key, text) => {
      if (key === "spark-role-runs") roleStatuses.push({ key, text });
    };
    ctx.ui.setWidget = (key, value, options) => {
      if (key === "spark-role-runs")
        roleWidgets.push({ key, value, placement: options?.placement });
    };
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "background-child",
      title: "Background child task",
      description: "Run a long-lived fake role-run for background inspection.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Background child task"),
    });
    graph.createTask({
      projectRef: project.ref,
      name: "background-child-two",
      title: "Background child task two",
      description: "Run a second long-lived fake role-run for explicit selector coverage.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Background child task two"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (args[0] === '--list-models') { process.stdout.write('No models matching ' + args[1] + '\\n'); process.exit(0); }",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    await executeSparkTool(tools, "impl_run_ready_tasks", ctx, {
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 50,
    });

    await waitFor(async () => {
      const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
        action: "status",
      });
      const background = (
        status.details as {
          background?: { childRuns?: Array<{ activeProcess?: boolean; taskName?: string }> };
        }
      ).background;
      const activeTaskNames =
        background?.childRuns
          ?.filter((child) => child.activeProcess)
          .map((child) => child.taskName) ?? [];
      return (
        activeTaskNames.includes("background-child") &&
        activeTaskNames.includes("background-child-two")
      );
    }, 5_000);

    const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
    });
    const statusText = toolText(status);
    assert.match(statusText, /Background work: running/);
    assert.match(statusText, /Active children:/);
    assert.match(statusText, /task=@background-child/);
    assert.match(statusText, /task=@background-child-two/);
    assert.match(statusText, /pid=\d+/);
    const statusDetails = status.details as {
      background?: {
        summary?: { state?: string; activeChildren?: number };
        childRuns?: Array<{
          runRef: string;
          taskName?: string;
          activeProcess?: boolean;
          pid?: number;
          claimKind?: string;
        }>;
      };
    };
    assert.equal(statusDetails.background?.summary?.state, "running");
    assert.equal(statusDetails.background?.summary?.activeChildren, 2);
    const activeChildren =
      statusDetails.background?.childRuns?.filter((entry) => entry.activeProcess) ?? [];
    const child = activeChildren.find((entry) => entry.taskName === "background-child");
    const sibling = activeChildren.find((entry) => entry.taskName === "background-child-two");
    assert.ok(child);
    assert.ok(child.runRef);
    assert.ok(sibling);
    assert.ok(sibling.runRef);
    assert.notEqual(child.runRef, sibling.runRef);
    assert.equal(child.claimKind, "role-run");
    assert.equal(typeof child.pid, "number");

    const ambiguousReply = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      message: "continue whichever role is ready",
    });
    assert.match(toolText(ambiguousReply), /control_target_ambiguous/);
    assert.equal(
      (ambiguousReply.details as { background?: { error?: string } }).background?.error,
      "control_target_ambiguous",
    );

    const inspect = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: child.runRef,
    });
    assert.match(toolText(inspect), new RegExp(`Background child run: ${child.runRef} active`));
    assert.match(toolText(inspect), /Task: @background-child/);

    const replied = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      runRef: child.runRef,
      message: "continue with the visible task",
    });
    assert.match(
      toolText(replied),
      new RegExp(`Spark background role-run reply: sent to ${child.runRef}`),
    );
    assert.match(toolText(replied), /Control artifact: artifact:/);
    const replyDetails = replied.details as {
      controlArtifactRef?: string;
      sent?: Array<{ delivered?: boolean; bytes?: number; runRef?: string }>;
      background?: {
        roleRunRegistry?: {
          entries?: Array<{
            runRef?: string;
            events?: Array<{ type?: string; message?: string; artifactRefs?: string[] }>;
          }>;
        };
      };
    };
    assert.match(replyDetails.controlArtifactRef ?? "", /^artifact:/);
    assert.equal(replyDetails.sent?.[0]?.runRef, child.runRef);
    assert.equal(replyDetails.sent?.[0]?.delivered, true);
    assert.ok((replyDetails.sent?.[0]?.bytes ?? 0) > 0);
    assert.match(roleStatuses.at(-1)?.text ?? "", /roles:/);
    assert.equal(roleWidgets.at(-1)?.key, "spark-role-runs");
    assert.equal(roleWidgets.at(-1)?.placement, "belowEditor");
    const replyEntry = replyDetails.background?.roleRunRegistry?.entries?.find(
      (entry) => entry.runRef === child.runRef,
    );
    assert.deepEqual(
      replyEntry?.events
        ?.filter((event) => event.type === "waiting_for_user" || event.type === "replied")
        .map((event) => event.type),
      ["waiting_for_user", "replied"],
    );
    assert.deepEqual(
      replyEntry?.events?.filter((event) => event.type === "replied").map((event) => event.message),
      ["continue with the visible task"],
    );
    assert.deepEqual(
      replyEntry?.events
        ?.filter((event) => event.type === "replied")
        .flatMap((event) => event.artifactRefs ?? []),
      [replyDetails.controlArtifactRef],
    );

    const steered = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "steer",
      taskRef: "background-child",
      message: "prioritize tests",
    });
    assert.match(
      toolText(steered),
      new RegExp(`Spark background role-run steer: sent to ${child.runRef}`),
    );
    assert.match(toolText(steered), /Control artifact: artifact:/);
    const steerDetails = steered.details as {
      background?: {
        roleRunRegistry?: {
          entries?: Array<{ runRef?: string; events?: Array<{ type?: string; message?: string }> }>;
        };
      };
    };
    const steerEntry = steerDetails.background?.roleRunRegistry?.entries?.find(
      (entry) => entry.runRef === child.runRef,
    );
    assert.deepEqual(
      steerEntry?.events
        ?.filter((event) => event.type === "message_activity")
        .map((event) => event.message),
      ["prioritize tests"],
    );

    const refused = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill",
    });
    assert.match(toolText(refused), /kill_requires_target/);
    assert.equal(
      (refused.details as { background?: { error?: string } }).background?.error,
      "kill_requires_target",
    );

    const roleStatusCountBeforeKill = roleStatuses.length;
    const roleWidgetCountBeforeKill = roleWidgets.length;
    const killed = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill",
      runRef: child.runRef,
      forceAfterMs: 0,
    });
    assert.match(toolText(killed), /Stopped background child runs: 1/);
    assert.equal(
      ((killed.details as { background?: { killed?: unknown[] } }).background?.killed ?? []).length,
      1,
    );
    assert.ok(roleStatuses.length > roleStatusCountBeforeKill);
    assert.ok(roleWidgets.length > roleWidgetCountBeforeKill);
    assert.match(roleStatuses.at(-1)?.text ?? "", /roles:/);
    assert.equal(roleWidgets.at(-1)?.key, "spark-role-runs");
    const roleStatusCountBeforeKillActive = roleStatuses.length;
    const roleWidgetCountBeforeKillActive = roleWidgets.length;
    const killedSibling = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill_active",
      runRef: sibling.runRef,
      forceAfterMs: 0,
    });
    assert.match(toolText(killedSibling), /Stopped background child runs: 1/);
    assert.equal(
      ((killedSibling.details as { background?: { killed?: unknown[] } }).background?.killed ?? [])
        .length,
      1,
    );
    assert.ok(roleStatuses.length > roleStatusCountBeforeKillActive);
    assert.ok(roleWidgets.length > roleWidgetCountBeforeKillActive);
    assert.match(roleStatuses.at(-1)?.text ?? "", /roles:/);
    assert.equal(roleWidgets.at(-1)?.key, "spark-role-runs");
    await waitFor(async () => {
      const reloaded = await defaultTaskGraphStore(dir).load();
      return !reloaded?.tasks(project.ref).some((task) => task.status === "running");
    }, 5_000);
    await waitFor(async () => (await defaultWorkflowRunStore(dir).status()).running === 0, 5_000);
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    if (existsSync(join(dir, ".spark", "workflow-runs.json"))) {
      await waitFor(async () => {
        const reloaded = await defaultTaskGraphStore(dir).load();
        return !reloaded?.tasks().some((task) => task.status === "running");
      }, 5_000).catch(() => undefined);
      await waitFor(
        async () => (await defaultWorkflowRunStore(dir).status()).running === 0,
        5_000,
      ).catch(() => undefined);
    }
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_workflow_runs reply records failed delivery without successful activity transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-workflow-runs-reply-failed-delivery-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
  const previousClosedStdinFile = process.env.CLOSED_STDIN_FILE;
  let runPromise: Promise<unknown> | undefined;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "closed-stdin-child",
      title: "Closed stdin child task",
      description: "Run a long-lived fake role-run that closes stdin before control delivery.",
      kind: "implement",
      status: "pending",
      roleRef: "role:builtin-worker" as RoleRef,
      plan: executionReadyPlan("Closed stdin child task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    const closedStdinFile = join(dir, "closed-stdin-ready");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (args[0] === '--list-models') { process.stdout.write('No models matching ' + args[1] + '\\n'); process.exit(0); }",
        "fs.closeSync(0);",
        "if (process.env.CLOSED_STDIN_FILE) fs.writeFileSync(process.env.CLOSED_STDIN_FILE, 'closed');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setTimeout(() => process.exit(0), 2000);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    process.env.CLOSED_STDIN_FILE = closedStdinFile;
    ctx.inputValue = "test/model";

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: ctxSessionKey(ctx) },
    }).catch((error: unknown) => error);
    await waitFor(
      () => listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      5_000,
    );
    const active = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(active);
    await waitFor(() => existsSync(closedStdinFile), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const failedDeliveryMessage = "x".repeat(1024 * 1024);

    const replied = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reply",
      runRef: active.runRef,
      message: failedDeliveryMessage,
    });

    assert.match(
      toolText(replied),
      new RegExp(`Spark background role-run reply: not delivered to ${active.runRef}`),
    );
    assert.match(toolText(replied), /Control artifact: artifact:/);
    const details = replied.details as {
      controlArtifactRef?: string;
      sent?: Array<{ delivered?: boolean; runRef?: string }>;
      background?: {
        roleRunRegistry?: {
          entries?: Array<{ runRef?: string; events?: Array<{ type?: string }> }>;
        };
      };
    };
    assert.match(details.controlArtifactRef ?? "", /^artifact:/);
    assert.equal(details.sent?.[0]?.runRef, active.runRef);
    assert.equal(details.sent?.[0]?.delivered, false);
    const controlArtifact = await defaultArtifactStore(dir).get(
      details.controlArtifactRef as ArtifactRef,
    );
    assert.equal(controlArtifact.provenance.runRef, active.runRef);
    const controlBody = controlArtifact.body as {
      sent?: Array<{ delivered?: boolean; runRef?: string; errorMessage?: string }>;
    };
    assert.equal(controlBody.sent?.[0]?.runRef, active.runRef);
    assert.equal(controlBody.sent?.[0]?.delivered, false);
    if (controlBody.sent?.[0]?.errorMessage)
      assert.match(controlBody.sent[0].errorMessage, /EPIPE|stdin/i);
    const entry = details.background?.roleRunRegistry?.entries?.find(
      (candidate) => candidate.runRef === active.runRef,
    );
    assert.deepEqual(
      (entry?.events ?? [])
        .filter((event) => event.type === "waiting_for_user" || event.type === "replied")
        .map((event) => event.type),
      [],
    );

    await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "kill",
      runRef: active.runRef,
      forceAfterMs: 0,
    });
    await waitFor(
      () => !listActiveSparkRoleRunProcesses().some((process) => process.runRef === active.runRef),
      5_000,
    );
    await runPromise;
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await waitFor(
      () => !listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir),
      5_000,
    ).catch(() => undefined);
    await runPromise?.catch(() => undefined);
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    if (previousClosedStdinFile === undefined) delete process.env.CLOSED_STDIN_FILE;
    else process.env.CLOSED_STDIN_FILE = previousClosedStdinFile;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_workflow_runs reports failed workflow run with stuck child as attention needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-failed-active-"));
  let runPromise: Promise<unknown> | undefined;
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "failed-stuck-child",
      title: "Failed stuck child",
      description: "Timeout child process that stays alive after runtime failure.",
      kind: "implement",
      roleRef: "role:builtin-worker" as RoleRef,
      status: "pending",
      plan: executionReadyPlan("Failed stuck child"),
    });
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);

    runPromise = runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      piCommand: fakePi,
      timeoutMs: 10_000,
      claim: { sessionId: ctxSessionKey(ctx) },
    }).catch((error: unknown) => error);
    await waitFor(() => listActiveSparkRoleRunProcesses().some((process) => process.cwd === dir));
    const activeProcess = listActiveSparkRoleRunProcesses().find((process) => process.cwd === dir);
    assert.ok(activeProcess);

    const finishedAt = new Date().toISOString();
    const failedRun = {
      ref: activeProcess.runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef: activeProcess.roleRef,
      runName: activeProcess.runName,
      ownerSessionId: ctxSessionKey(ctx),
      status: "failed" as const,
      failureKind: "runtime_error" as const,
      errorMessage: "role run failed while the child process was still active",
      startedAt: activeProcess.startedAt,
      finishedAt,
      outputArtifacts: [],
      completionSummary: {
        runRef: activeProcess.runRef,
        taskRef: task.ref,
        roleRef: activeProcess.roleRef,
        runName: activeProcess.runName,
        status: "failed" as const,
        summary: "role run failed while the child process was still active",
        artifactRefs: [],
        createdAt: finishedAt,
      },
    };
    graph.recordRun(failedRun);
    graph.setTaskStatus(task.ref, "failed");
    assert.equal(
      listActiveSparkRoleRunProcesses().some((process) => process.runRef === activeProcess.runRef),
      true,
    );
    await store.save(graph);

    const dagRunStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagRunStore.startRun({
      projectRef: project.ref,
      ownerSessionId: ctxSessionKey(ctx),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 1_000,
    });
    await dagRunStore.recordSchedule(dagRun.ref, {
      taskRef: task.ref,
      runRef: activeProcess.runRef,
      scheduled: 1,
    });
    await dagRunStore.recordProgress(dagRun.ref, {
      taskRef: task.ref,
      run: failedRun,
      completed: 1,
    });
    await dagRunStore.finishRun(dagRun.ref, {
      scheduled: 1,
      completed: 1,
      timedOut: false,
      failed: 1,
      cancelled: 0,
      runs: [failedRun],
    });

    const { tools } = registerSparkToolsForTest();
    const status = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "status",
      projectRef: project.ref,
    });
    const statusText = toolText(status);
    assert.match(statusText, /Background work: needs attention/);
    assert.match(statusText, /Active children:/);
    assert.doesNotMatch(statusText, /Background work: running/);
    const background = (
      status.details as {
        background?: {
          summary?: { state?: string; activeChildren?: number; actionableProblems?: number };
          childRuns?: Array<{ runRef?: string; activeProcess?: boolean; status?: string }>;
        };
      }
    ).background;
    assert.equal(background?.summary?.state, "needs_attention");
    assert.equal(background?.summary?.activeChildren, 1);
    assert.equal(background?.summary?.actionableProblems, 1);
    assert.equal(
      background?.childRuns?.some(
        (child) =>
          child.runRef === activeProcess.runRef && child.activeProcess && child.status === "active",
      ),
      true,
    );
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    await runPromise?.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_workflow_runs inspect/list use compact role-run summaries and tail refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-role-summary-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const failedTask = graph.createTask({
      projectRef: project.ref,
      name: "compact-failed-role-run",
      title: "Compact failed role-run task",
      description: "Represents a failed role-run with compact summary evidence.",
      kind: "implement",
      status: "failed",
      plan: executionReadyPlan("Compact failed role-run task"),
    });
    const succeededTask = graph.createTask({
      projectRef: project.ref,
      name: "compact-succeeded-role-run",
      title: "Compact succeeded role-run task",
      description: "Represents a succeeded role-run with compact summary evidence.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Compact succeeded role-run task"),
    });
    const now = new Date().toISOString();
    const roleRef = "role:builtin-worker" as RoleRef;
    const failedRunRef = "run:compact-failed-role-run" as RunRef;
    const succeededRunRef = "run:compact-succeeded-role-run" as RunRef;
    const transcript = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Failed role-run transcript",
      format: "text",
      body: "transcript body is intentionally behind a ref",
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const failedArtifact = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Failed compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        startedAt: now,
        finishedAt: now,
        summary: "Failed compact summary: missing required evidence",
        transcriptRef: transcript.ref,
        record: {
          ref: failedRunRef,
          roleRef,
          runName: "worker-compact-failed",
          status: "failed",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 50_000, tail: "bounded stdout tail", tailBytes: 19, truncated: true },
        stderr: { bytes: 120, tail: "bounded stderr tail", tailBytes: 19, truncated: false },
        jsonEvents: { count: 42, tail: ['{"type":"error"}'], tailEventCount: 1, truncated: true },
      },
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const succeededArtifact = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Succeeded compact role-run result",
      format: "json",
      body: {
        schemaVersion: 1,
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        startedAt: now,
        finishedAt: now,
        summary: "Succeeded compact summary: docs updated",
        record: {
          ref: succeededRunRef,
          roleRef,
          runName: "worker-compact-succeeded",
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
        },
        stdout: { bytes: 24, tail: "done", tailBytes: 4, truncated: false },
        stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
        jsonEvents: { count: 1, tail: ['{"type":"done"}'], tailEventCount: 1, truncated: false },
      },
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: succeededTask.ref,
        roleRef,
        runRef: succeededRunRef,
      },
    });
    const failedRun = graph.recordRun({
      ref: failedRunRef,
      projectRef: project.ref,
      taskRef: failedTask.ref,
      roleRef,
      runName: "worker-compact-failed",
      status: "failed",
      errorMessage: "missing required evidence",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [failedArtifact.ref],
      completionSummary: {
        runRef: failedRunRef,
        taskRef: failedTask.ref,
        roleRef,
        runName: "worker-compact-failed",
        status: "failed",
        summary: "Failed compact summary: missing required evidence",
        artifactRefs: [failedArtifact.ref],
        createdAt: now,
      },
    });
    const succeededRun = graph.recordRun({
      ref: succeededRunRef,
      projectRef: project.ref,
      taskRef: succeededTask.ref,
      roleRef,
      runName: "worker-compact-succeeded",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [succeededArtifact.ref],
      completionSummary: {
        runRef: succeededRunRef,
        taskRef: succeededTask.ref,
        roleRef,
        runName: "worker-compact-succeeded",
        status: "succeeded",
        summary: "Succeeded compact summary: docs updated",
        artifactRefs: [succeededArtifact.ref],
        createdAt: now,
      },
    });
    await store.save(graph);
    const dagStore = defaultWorkflowRunStore(dir);
    const dagRun = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 2,
      timeoutMs: 100,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: failedTask.ref,
      runRef: failedRunRef,
      scheduled: 1,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: failedTask.ref,
      run: failedRun,
      completed: 1,
    });
    await dagStore.recordSchedule(dagRun.ref, {
      taskRef: succeededTask.ref,
      runRef: succeededRunRef,
      scheduled: 2,
    });
    await dagStore.recordProgress(dagRun.ref, {
      taskRef: succeededTask.ref,
      run: succeededRun,
      completed: 2,
    });
    await dagStore.finishRun(dagRun.ref, {
      scheduled: 2,
      completed: 2,
      timedOut: false,
      failed: 1,
      runs: [failedRun, succeededRun],
    });

    const inspect = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef: failedRunRef,
    });
    const inspectText = toolText(inspect);
    assert.match(inspectText, /Background child run: run:compact-failed-role-run failed/);
    assert.match(inspectText, /Summary: Failed compact summary: missing required evidence/);
    assert.match(inspectText, new RegExp(`Transcript: ${transcript.ref}`));
    assert.match(inspectText, /Stdout tail: 50000 bytes, showing last 19 bytes \(truncated\)/);
    const inspectDetails = inspect.details as {
      background?: {
        childRuns?: Array<{
          transcriptRef?: string;
          stdoutTail?: { tail?: string; truncated?: boolean };
          jsonEventsTail?: { count?: number; tailEventCount?: number };
        }>;
      };
    };
    assert.equal(inspectDetails.background?.childRuns?.[0]?.transcriptRef, transcript.ref);
    assert.equal(
      inspectDetails.background?.childRuns?.[0]?.stdoutTail?.tail,
      "bounded stdout tail",
    );
    assert.equal(inspectDetails.background?.childRuns?.[0]?.stdoutTail?.truncated, true);
    assert.equal(inspectDetails.background?.childRuns?.[0]?.jsonEventsTail?.count, 42);

    const list = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "list",
      includeHistory: true,
    });
    const listText = toolText(list);
    assert.match(listText, /Child runs:/);
    assert.match(listText, /run:compact-failed-role-run: failed .*Failed compact summary/);
    assert.match(listText, /run:compact-succeeded-role-run: succeeded .*Succeeded compact summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs inspect keeps legacy large role-run artifacts behind refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-background-runs-large-role-artifact-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "legacy-large-background-role-run",
      title: "Legacy large background role-run task",
      description: "Represents an old background role-run with a large artifact body.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large background role-run task"),
    });
    const legacyBodyMarker = "BACKGROUND_LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const artifact = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Legacy large background role-run artifact",
      format: "text",
      body: legacyBodyMarker.repeat(4_000),
      provenance: { producer: "task", projectRef: project.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-background-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large-background",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [artifact.ref],
    });
    await store.save(graph);

    const inspect = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "inspect",
      runRef,
    });
    const text = toolText(inspect);
    assert.match(text, /Background child run: run:legacy-large-background-role-run succeeded/);
    assert.match(text, new RegExp(artifact.ref));
    assert.match(text, /unsupported_role_run_body: artifact body not loaded/);
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(inspect.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_workflow_runs reconciles, acks scoped problems, and renders historical timeouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-records-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const dagStore = defaultWorkflowRunStore(dir);
    const stale = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const legacy = await dagStore.startRun({
      projectRef: project.ref,
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    await dagStore.finishRun(legacy.ref, { scheduled: 1, completed: 0, timedOut: true });

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const reconciled = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /Reconciled workflow records changed: 1/);
    assert.doesNotMatch(toolText(reconciled), /Historical timeout record/);
    assert.doesNotMatch(toolText(reconciled), /Workflow run .*stale/);
    const reconcileDetails = reconciled.details as {
      background?: { runs?: Array<{ runRef: string; status: string; legacyTimedOut: boolean }> };
    };
    assert.equal(
      reconcileDetails.background?.runs?.some(
        (run) => run.runRef === stale.ref && run.status === "stale",
      ),
      true,
    );
    assert.equal(
      reconcileDetails.background?.runs?.some(
        (run) => run.runRef === legacy.ref && run.legacyTimedOut,
      ),
      true,
    );

    const acknowledged = await executeSparkTool(tools, "impl_workflow_runs", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /Acknowledged background problem runs: 2 newly/);
    const ackDetails = acknowledged.details as {
      background?: { acknowledged?: { acknowledged?: string[] }; childRuns?: unknown[] };
    };
    assert.deepEqual(
      ackDetails.background?.acknowledged?.acknowledged?.sort(),
      [legacy.ref, stale.ref].sort(),
    );
    assert.equal(ackDetails.background?.childRuns?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("legacy /run commands are not registered", () => {
  const { commands } = registerSparkToolsForTest();
  assert.equal(commands.get("run"), undefined);
  assert.equal(commands.get("run-sequential"), undefined);
  assert.equal(commands.get("run-parallel"), undefined);
});

void test("impl_run_ready_tasks preflights only the current ready frontier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-frontier-preflight-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  const previousPath = process.env.PATH;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "ready-worker",
      title: "Ready worker task",
      description: "Only this ready frontier task should be preflighted.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready worker task"),
    });
    graph.createTask({
      projectRef: project.ref,
      name: "blocked-reviewer",
      title: "Blocked reviewer task",
      description: "This future task must not block current frontier dispatch.",
      kind: "review",
      status: "blocked",
      plan: executionReadyPlan("Blocked reviewer task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (args[0] === '--list-models') { process.stdout.write('No models matching ' + args[1] + '\\n'); process.exit(0); }",
        "process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const result = await executeSparkTool(tools, "impl_run_ready_tasks", ctx, {
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 123,
    });

    assert.match(toolText(result), /Spark workflow-run scheduler started/);
    assert.deepEqual((result.details as { policy?: unknown }).policy, {
      maxConcurrency: 1,
      timeoutMs: 123,
    });
    const runControl = await defaultWorkflowRunStore(dir).loadControl();
    assert.equal(runControl?.policy.maxConcurrency, 1);
    assert.equal(runControl?.policy.timeoutMs, 123);
    const settingsFile = JSON.parse(
      await readFile(join(dir, ".agents", "role-model-settings.json"), "utf8"),
    ) as { roleModels: Record<string, string> };
    assert.deepEqual(settingsFile.roleModels, { "role:builtin-worker": "test/model" });
    await waitFor(async () => {
      const dagStatus = await defaultWorkflowRunStore(dir).status();
      return dagStatus.succeeded === 1 || dagStatus.failed > 0;
    }, 10_000);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_run_ready_tasks reports workflow-run completion without queuing a follow-up user message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-followup-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const otherProject = graph.createProject({
      title: "Other DAG project",
      description: "Must not be scheduled by sessions DAG execution.",
    });
    const otherTask = graph.createTask({
      projectRef: otherProject.ref,
      name: "other-ready-role",
      title: "Other ready role task",
      description: "This task is ready but belongs to another project.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Other ready role task"),
    });
    graph.createTask({
      projectRef: project.ref,
      name: "ready-role-one",
      title: "Ready role task one",
      description: "Run the first quick fake role-run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready role task one"),
    });
    graph.createTask({
      projectRef: project.ref,
      name: "ready-role-two",
      title: "Ready role task two",
      description: "Run the second quick fake role-run.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Ready role task two"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(
      fakePi,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');\nprocess.exit(0);\n",
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const extension = registerSparkToolsForTest();
    const { tools, messages } = extension;
    await useOnlySparkProject(tools, ctx);
    await executeSparkTool(tools, "impl_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Workflow run:")),
      10_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 10_000);

    const dagStatus = await defaultWorkflowRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.equal(dagStatus.lastRun?.projectRef, project.ref);
    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(reloadedGraph?.getTask(otherTask.ref).status, "pending");
    assert.doesNotMatch(messages.join("\n"), /Workflow run:/);
    assert.equal(ctx.notifications.at(-1)?.level, "info");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Workflow run:/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /scheduled 2, completed \d/);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Digest:/);
    assert.equal(dagStatus.lastRun?.completionDigest.length, 2);
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => summary.status === "succeeded"),
      true,
    );
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => summary.artifactRefs.length === 1),
      true,
    );
    assert.equal(
      dagStatus.lastRun?.completionDigest.every((summary) => /type.*done/.test(summary.summary)),
      true,
    );

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Recent role-run completions:/);
    assert.equal((statusText.match(/\[succeeded\] task=task:/gu) ?? []).length, 2);
    assert.equal((statusText.match(/artifacts=artifact:/gu) ?? []).length, 2);
    const statusDetails = status.details as {
      recentRoleRunCompletions?: Array<{ status?: string; artifactRefs?: string[] }>;
    };
    assert.equal(statusDetails.recentRoleRunCompletions?.length, 2);
    assert.equal(
      statusDetails.recentRoleRunCompletions?.every(
        (summary) => summary.status === "succeeded" && summary.artifactRefs?.length === 1,
      ),
      true,
    );

    const hiddenInbox = await consumeSparkModeContext(extension, ctx);
    assert.match(hiddenInbox, /Recent unread background role-run results:/);
    assert.equal((hiddenInbox.match(/\[succeeded\] task=task:/gu) ?? []).length, 2);
    assert.equal((hiddenInbox.match(/artifacts=artifact:/gu) ?? []).length, 2);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await waitFor(
      () => listActiveSparkRoleRunProcesses().every((process) => process.cwd !== dir),
      5_000,
    ).catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_status renders legacy large role-run artifacts by refs without artifact body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-status-large-role-run-artifact-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const task = graph.createTask({
      projectRef: project.ref,
      name: "legacy-large-role-run",
      title: "Legacy large role-run task",
      description: "Represents an old role-run with a large artifact body.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large role-run task"),
    });
    const legacyBodyMarker = "LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const artifact = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Legacy large role-run artifact",
      format: "text",
      body: legacyBodyMarker.repeat(3_000),
      provenance: { producer: "spark", projectRef: project.ref, taskRef: task.ref },
    });
    const now = new Date().toISOString();
    const runRef = "run:legacy-large-role-run" as RunRef;
    const roleRef = "role:builtin-worker" as RoleRef;
    graph.recordRun({
      ref: runRef,
      projectRef: project.ref,
      taskRef: task.ref,
      roleRef,
      runName: "worker-legacy-large",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      outputArtifacts: [artifact.ref],
      completionSummary: {
        runRef,
        taskRef: task.ref,
        roleRef,
        runName: "worker-legacy-large",
        status: "succeeded",
        summary: "Legacy compact summary only",
        artifactRefs: [artifact.ref],
        createdAt: now,
      },
    });
    await store.save(graph);

    const status = await executeSparkTool(tools, "impl_status", ctx, {});
    const text = toolText(status);
    assert.match(text, /Recent role-run completions:/);
    assert.match(text, /Legacy compact summary only/);
    assert.match(text, new RegExp(artifact.ref));
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(status.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_run_ready_tasks marks Spark workflow-run scheduler failed when child role-run fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-child-failed-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  try {
    process.env.PI_ROLES_HOME = dir;
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.inputValue = "test/model";
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "empty-role",
      title: "Empty role task",
      description: "Run a fake role-run that produces no evidence.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Empty role task"),
    });
    await store.save(graph);
    const fakePi = join(dir, "pi");
    await writeFile(fakePi, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    await chmod(fakePi, 0o755);
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;

    const extension = registerSparkToolsForTest();
    const { tools, messages } = extension;
    await useOnlySparkProject(tools, ctx);
    await executeSparkTool(tools, "impl_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Workflow run:")),
      3_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 3_000);

    const dagStatus = await defaultWorkflowRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 0);
    assert.equal(dagStatus.failed, 1);
    assert.equal(dagStatus.lastRun?.status, "failed");
    assert.doesNotMatch(messages.join("\n"), /Workflow run: .* failed: scheduled 1, completed 1/);
    assert.equal(ctx.notifications.at(-1)?.level, "error");
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /Workflow run: .* failed: scheduled 1, completed 1/,
    );
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /failed: inspect task_read\(\{ action: "run_status"/,
    );
    const hiddenInbox = await consumeSparkModeContext(extension, ctx);
    assert.match(hiddenInbox, /Recent unread background role-run results:/);
    assert.match(hiddenInbox, /\[failed\] task=task:/);
    assert.match(hiddenInbox, /next=inspect with task_read\(\{ action: "run_status"/);
    assert.doesNotMatch(hiddenInbox, /transcript body/i);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);
    assert.equal(existsSync(join(dir, ".spark", "todos")), false);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("impl_status reports derived ready frontier for pending execution-ready tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-derived-ready-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "pending-derived-ready",
      title: "Pending derived ready task",
      description:
        "A pending task with an execution-ready plan should appear in the ready frontier.",
      kind: "research",
      status: "pending",
      plan: executionReadyPlan("A pending task with an execution-ready plan should appear ready."),
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const status = await executeSparkTool(tools, "task_read", ctx, {
      action: "project_status",
    });
    const details = status.details as {
      renderedProjects: Array<{
        current?: boolean;
        taskCounts?: { ready?: number; statusCounts?: Record<string, number> };
        tasks?: Array<{ name?: string; status?: string }>;
      }>;
      ready?: Array<{ name?: string }>;
    };
    const current = details.renderedProjects.find((projectDetail) => projectDetail.current);
    assert.equal(current?.taskCounts?.ready, 1);
    assert.equal(current?.taskCounts?.statusCounts?.pending, 1);
    assert.equal(current?.tasks?.[0]?.name, "pending-derived-ready");
    assert.equal(current?.tasks?.[0]?.status, "pending");

    const active = await executeSparkTool(tools, "task_read", ctx, { action: "project_status" });
    const activeText = toolText(active);
    assert.match(activeText, /ready_frontier=1/);
    assert.match(
      activeText,
      /\[pending\] @pending-derived-ready: Pending derived ready task .*ready_frontier=yes/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_status defaults to active view, supports summary, limits, and state drill-down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-views-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const otherCtx = testSparkContext(dir, "other");
    const sessionKey = ctxSessionKey(ctx);
    const otherSessionKey = ctxSessionKey(otherCtx);
    const store = defaultTaskGraphStore(dir);
    const graph = await store.load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    graph.createTask({
      projectRef: project.ref,
      name: "mine",
      title: "Mine running task",
      description: "Visible unfinished work for the current session.",
      kind: "implement",
      status: "running",
      claim: {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    graph.createTask({
      projectRef: project.ref,
      name: "other",
      title: "Other pending task",
      description: "Visible unfinished work from another session.",
      kind: "review",
      status: "pending",
      claim: {
        kind: "main",
        claimedBy: otherSessionKey,
        sessionId: otherSessionKey,
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    });
    graph.createTask({
      projectRef: project.ref,
      name: "finished",
      title: "Finished task history",
      description: "Hidden from active view; completed counts stay summarized.",
      kind: "generic",
      status: "done",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "cancelled",
      title: "Cancelled task history",
      description: "Hidden from active view; completed counts stay summarized.",
      kind: "generic",
      status: "cancelled",
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const active = await executeSparkTool(tools, "impl_status", ctx, {});
    const activeText = toolText(active);
    assert.match(activeText, /Spark tasks \(active view, limit=8\):/);
    assert.match(activeText, /Tool persistence \[current\]/);
    assert.doesNotMatch(activeText, /Project status: active/);
    assert.match(activeText, /Active tasks:/);
    assert.match(activeText, /Mine running task/);
    assert.match(activeText, /Other pending task/);
    assert.doesNotMatch(activeText, /plan=present/);
    assert.doesNotMatch(activeText, /plan=/);
    assert.doesNotMatch(activeText, /missing-success|missing-evidence/);
    assert.doesNotMatch(activeText, /Finished task history/);
    assert.doesNotMatch(activeText, /Cancelled task history/);
    assert.doesNotMatch(activeText, /kind=implement/);
    assert.doesNotMatch(activeText, /claimed=session:/);
    assert.doesNotMatch(activeText, new RegExp(project.ref));
    assert.match(activeText, /Completed tasks: 2 total \| done=1 \| cancelled=1/);
    assert.equal(active.details?.view, "active");
    assert.equal(active.details?.limit, 8);
    assert.equal(active.details?.activeProjectRef, project.ref);
    assert.equal("tasks" in active.details!, false);
    assert.equal("dependencies" in active.details!, false);

    const json = await executeSparkTool(tools, "impl_status", ctx, { format: "json" });
    const jsonText = toolText(json);
    assert.doesNotMatch(jsonText, /Spark tasks \(/);
    const jsonStatus = JSON.parse(jsonText) as {
      found: boolean;
      compact: boolean;
      format: string;
      view: string;
      activeProject?: {
        ref: string;
        taskCounts: { total: number; claimedByCurrentSession: number };
      };
      currentClaim?: { name: string; title: string; claimedByCurrentSession: boolean };
      ready: unknown[];
      renderedProjects: Array<{
        ref: string;
        current: boolean;
        taskCounts: { total: number; claimedByCurrentSession: number };
        tasks?: unknown[];
      }>;
      projects?: unknown[];
      workflowRunStatus?: { recentRuns?: unknown[] };
      hints?: string[];
    };
    assert.equal(jsonStatus.found, true);
    assert.equal(jsonStatus.compact, true);
    assert.equal(jsonStatus.format, "json");
    assert.equal(jsonStatus.view, "active");
    assert.equal(jsonStatus.activeProject?.ref, project.ref);
    assert.equal(jsonStatus.activeProject?.taskCounts.total, 4);
    assert.equal(jsonStatus.activeProject?.taskCounts.claimedByCurrentSession, 1);
    assert.equal(jsonStatus.currentClaim?.name, "mine");
    assert.equal(jsonStatus.currentClaim?.claimedByCurrentSession, true);
    assert.deepEqual(jsonStatus.ready, []);
    assert.equal(jsonStatus.renderedProjects[0]?.ref, project.ref);
    assert.equal(jsonStatus.renderedProjects[0]?.current, true);
    assert.equal(jsonStatus.renderedProjects[0]?.taskCounts.total, 4);
    assert.equal(jsonStatus.renderedProjects[0]?.taskCounts.claimedByCurrentSession, 1);
    assert.equal(jsonStatus.renderedProjects[0]?.tasks, undefined);
    assert.equal(jsonStatus.projects, undefined);
    assert.equal(jsonStatus.workflowRunStatus?.recentRuns, undefined);
    assert.match(jsonStatus.hints?.join("\n") ?? "", /projectRef\/taskRef\/limit/);
    assert.equal(json.details?.format, "json");

    const limited = await executeSparkTool(tools, "impl_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^ {2}- \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "impl_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active tasks:/);
    assert.doesNotMatch(summaryText, /^ {2}- \[/m);
    assert.equal(summary.details?.view, "summary");
    assert.equal(summary.details?.limit, undefined);

    await writeFile(join(dir, ".spark", "projects.json"), "{}\n", "utf8");
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}\n", "utf8");

    const stateSummary = await executeSparkTool(tools, "impl_status", ctx, {
      includeStateSummary: true,
    });
    const stateSummaryText = toolText(stateSummary);
    assert.match(stateSummaryText, /Spark tasks \(active view, limit=8\):/);
    assert.match(stateSummaryText, /Active tasks:/);
    assert.doesNotMatch(stateSummaryText, /Finished task history/);
    assert.doesNotMatch(stateSummaryText, /Cancelled task history/);
    assert.match(stateSummaryText, /Completed tasks: 2 total \| done=1 \| cancelled=1/);
    assert.match(stateSummaryText, /Spark state cache:/);
    assert.match(stateSummaryText, /sessions: \d+ files/);
    assert.match(stateSummaryText, /V2 canonical stores \(protected\):/);
    assert.match(stateSummaryText, /project graph: \d+ files, .*\.spark\/projects/);
    assert.match(stateSummaryText, /Import-only paths: 2/);
    assert.match(stateSummaryText, /\.spark\/projects\.json/);
    assert.match(stateSummaryText, /\.spark\/review-gate\.json/);
    assert.doesNotMatch(stateSummaryText, /project graph: .*\.spark\/projects\.json/);
    assert.doesNotMatch(stateSummaryText, /Hidden finished tasks/);
    assert.equal(stateSummary.details?.view, "active");
    assert.equal(stateSummary.details?.limit, 8);
    const state = (
      stateSummary.details as
        | {
            state?: {
              caches: Array<{ kind: string; files: number }>;
              protectedStores: Array<{ reason: string; files: number }>;
              legacyImportOnly: string[];
            };
          }
        | undefined
    )?.state;
    assert.ok(state);
    assert.ok(state.caches.some((cache) => cache.kind === "sessions" && cache.files >= 1));
    assert.ok(
      state.protectedStores.some((store) => store.reason === "task-graph" && store.files >= 1),
    );

    await assert.rejects(
      () => executeSparkTool(tools, "impl_status", ctx, { view: "unsupported" }),
      /view must be active or summary/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state cache_cleanup previews and deletes only safe cache files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-cleanup-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const currentSessionScope = ctxSessionStoreScope(ctx);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);

    const currentProjectDir = join(dir, ".spark", "sessions");
    const taskTodoDir = join(dir, ".spark", "todos");
    const sessionTodoDir = join(dir, ".spark", "session-todos");
    const displayNumberDir = join(dir, ".spark", "todo-display-numbers");
    const artifactsDir = join(dir, ".spark", "artifacts");
    const notesDir = join(dir, ".spark", "notes");
    const roleReportsDir = join(dir, ".spark", "role-reports");
    const reviewsDir = join(dir, ".spark", "reviews");
    await mkdir(currentProjectDir, { recursive: true });
    await mkdir(taskTodoDir, { recursive: true });
    await mkdir(sessionTodoDir, { recursive: true });
    await mkdir(displayNumberDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await mkdir(roleReportsDir, { recursive: true });
    await mkdir(reviewsDir, { recursive: true });

    const missingProjectFile = join(currentProjectDir, "old-owner.json");
    const emptyOtherTaskTodos = join(taskTodoDir, "other-session.json");
    const currentTaskTodos = join(taskTodoDir, `${currentSessionScope}.json`);
    const terminalOtherSessionTodos = join(sessionTodoDir, "other-session.json");
    const staleDisplayNumbers = join(displayNumberDir, "other-session.json");
    const protectedArtifact = join(artifactsDir, "keep.txt");
    const protectedWorkflowRuns = join(dir, ".spark", "workflow-runs.json");
    const protectedReviewsIndex = join(reviewsDir, "index.json");
    const protectedNote = join(notesDir, "keep.md");
    const protectedRoleReport = join(roleReportsDir, "keep.md");

    await writeFile(missingProjectFile, JSON.stringify({ projectRef: "proj:missing" }), "utf8");
    await writeFile(emptyOtherTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(currentTaskTodos, JSON.stringify({ version: 1, todos: [] }), "utf8");
    await writeFile(
      terminalOtherSessionTodos,
      JSON.stringify({ version: 1, todos: [{ content: "done", status: "done" }] }),
      "utf8",
    );
    await writeFile(staleDisplayNumbers, JSON.stringify({ version: 1, entries: [] }), "utf8");
    await writeFile(protectedArtifact, "keep", "utf8");
    await writeFile(
      protectedWorkflowRuns,
      JSON.stringify({
        version: 1,
        manager: { status: "idle", updatedAt: new Date().toISOString() },
        runs: [],
      }),
      "utf8",
    );
    await writeFile(protectedReviewsIndex, JSON.stringify({ version: 1, reviews: [] }), "utf8");
    await writeFile(protectedNote, "keep", "utf8");
    await writeFile(protectedRoleReport, "keep", "utf8");
    await utimes(terminalOtherSessionTodos, oldDate, oldDate);
    await utimes(staleDisplayNumbers, oldDate, oldDate);

    const dryRun = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      olderThanDays: 30,
    });
    const dryRunText = toolText(dryRun);
    assert.match(dryRunText, /Spark state cleanup dry-run: would delete 4 safe cache file\(s\)/);
    assert.match(dryRunText, /old-owner\.json/);
    assert.match(dryRunText, /other-session\.json/);
    assert.equal(existsSync(missingProjectFile), true);
    assert.equal(existsSync(emptyOtherTaskTodos), true);
    assert.equal(existsSync(terminalOtherSessionTodos), true);
    assert.equal(existsSync(staleDisplayNumbers), true);

    const apply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
      olderThanDays: 30,
    });
    assert.match(toolText(apply), /Spark state cleanup apply: deleted 4 safe cache file\(s\)/);
    assert.equal(existsSync(missingProjectFile), false);
    assert.equal(existsSync(emptyOtherTaskTodos), false);
    assert.equal(existsSync(terminalOtherSessionTodos), false);
    assert.equal(existsSync(staleDisplayNumbers), false);
    assert.equal(existsSync(currentTaskTodos), true);
    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(protectedArtifact), true);
    assert.equal(existsSync(protectedWorkflowRuns), true);
    assert.equal(existsSync(protectedReviewsIndex), true);
    assert.equal(existsSync(protectedNote), true);
    assert.equal(existsSync(protectedRoleReport), true);

    const status = await executeSparkTool(tools, "impl_state", ctx, { action: "state_status" });
    assert.match(toolText(status), /Spark state status:/);
    assert.match(toolText(status), /V2 canonical stores \(protected\):/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state reports broken cache files without counting them safe by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-cleanup-broken-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const brokenCurrentProject = join(dir, ".spark", "sessions", "broken-owner.json");
    const brokenDisplayNumbers = join(dir, ".spark", "todo-display-numbers", "broken-display.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await mkdir(join(dir, ".spark", "todo-display-numbers"), { recursive: true });
    await writeFile(brokenCurrentProject, "{not-json", "utf8");
    await writeFile(brokenDisplayNumbers, "{not-json", "utf8");

    const status = await executeSparkTool(tools, "impl_state", ctx, { action: "state_status" });
    const caches = (
      status.details as {
        state?: {
          caches?: Array<{
            kind: string;
            brokenFiles: number;
            safeToDeleteFiles: number;
          }>;
        };
      }
    ).state?.caches;
    assert.ok(caches);
    assert.equal(caches.find((cache) => cache.kind === "sessions")?.brokenFiles, 1);
    assert.equal(caches.find((cache) => cache.kind === "sessions")?.safeToDeleteFiles, 0);
    assert.equal(caches.find((cache) => cache.kind === "todo-display-numbers")?.brokenFiles, 1);
    assert.equal(
      caches.find((cache) => cache.kind === "todo-display-numbers")?.safeToDeleteFiles,
      0,
    );

    const defaultCleanup = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
    });
    assert.match(toolText(defaultCleanup), /deleted 0 safe cache file\(s\)/);
    assert.equal(existsSync(brokenCurrentProject), true);
    assert.equal(existsSync(brokenDisplayNumbers), true);

    const explicitBrokenCleanup = await executeSparkTool(tools, "impl_state", ctx, {
      action: "cache_cleanup",
      dryRun: false,
      includeBroken: true,
    });
    assert.match(toolText(explicitBrokenCleanup), /deleted 2 safe cache file\(s\)/);
    assert.equal(existsSync(brokenCurrentProject), false);
    assert.equal(existsSync(brokenDisplayNumbers), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state state_doctor reports protected-store candidates without deleting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const terminalProject = graph.createProject({
      title: "Completed diagnostics project",
      description: "Project with no unfinished work.",
    });
    const activeProject = graph.createProject({
      title: "Active diagnostics project",
      description: "Project with unfinished work.",
    });
    graph.createTask({
      projectRef: activeProject.ref,
      title: "Active task",
      description: "Keep this project out of terminal diagnostics.",
      status: "ready",
    });
    await defaultTaskGraphStore(dir).save(graph);

    const now = new Date().toISOString();
    await defaultWorkflowRunStore(dir).save({
      version: 1,
      manager: { status: "idle", updatedAt: now },
      runs: [
        {
          ref: "run:inactive-diagnostics",
          projectRef: terminalProject.ref,
          dryRun: true,
          maxConcurrency: 1,
          timeoutMs: 1_000,
          status: "succeeded",
          startedAt: now,
          updatedAt: now,
          finishedAt: now,
          scheduled: 1,
          completed: 1,
          timedOut: false,
          scheduledTaskRefs: [],
          completedTaskRefs: [],
          taskRunRefs: [],
          completionDigest: [],
        },
      ],
    });

    const artifact = await defaultArtifactStore(dir).put({
      kind: "trace",
      title: "Large diagnostics artifact",
      format: "text",
      body: "x".repeat(70 * 1024),
      provenance: { producer: "spark", projectRef: terminalProject.ref },
    });
    const orphanBlob = join(dir, ".spark", "artifacts", "blobs", "orphan-diagnostics.txt");
    const noteFile = join(dir, ".spark", "notes", "diagnostics-note.md");
    const roleReportFile = join(dir, ".spark", "role-reports", "diagnostics-report.md");
    const reviewsIndexFile = join(dir, ".spark", "reviews", "index.json");
    await mkdir(join(dir, ".spark", "artifacts", "blobs"), { recursive: true });
    await mkdir(join(dir, ".spark", "notes"), { recursive: true });
    await mkdir(join(dir, ".spark", "role-reports"), { recursive: true });
    await mkdir(join(dir, ".spark", "reviews"), { recursive: true });
    await writeFile(orphanBlob, "orphan", "utf8");
    await writeFile(noteFile, "note", "utf8");
    await writeFile(roleReportFile, "role report", "utf8");
    await writeFile(reviewsIndexFile, JSON.stringify({ version: 1, reviews: [] }), "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const diagnostics = await executeSparkTool(tools, "impl_state", ctx, {
      action: "state_doctor",
    });
    const text = toolText(diagnostics);
    assert.match(text, /Spark state diagnostics \(read-only\):/);
    assert.match(text, /Terminal\/no-unfinished projects: 1/);
    assert.match(text, /Completed diagnostics project/);
    assert.doesNotMatch(text, /Active diagnostics project/);
    assert.match(text, /Inactive workflow runs: 1/);
    assert.match(text, /run:inactive-diagnostics/);
    assert.match(text, /Large artifacts: 1/);
    assert.match(text, new RegExp(artifact.ref));
    assert.match(text, /Orphan artifact blobs: 1/);
    assert.match(text, /orphan-diagnostics\.txt/);
    assert.match(text, /notes: 1/);
    assert.match(text, /diagnostics-note\.md/);
    assert.match(text, /role reports: 1/);
    assert.match(text, /diagnostics-report\.md/);
    assert.doesNotMatch(text, /x{100}/);

    const details = diagnostics.details as {
      diagnostics?: {
        largeArtifacts: { candidates: Array<Record<string, unknown>> };
        orphanBlobs: { candidates: Array<Record<string, unknown>> };
        terminalProjects: { candidates: Array<Record<string, unknown>> };
      };
    };
    assert.equal(details.diagnostics?.largeArtifacts.candidates[0]?.ref, artifact.ref);
    assert.equal("body" in (details.diagnostics?.largeArtifacts.candidates[0] ?? {}), false);
    assert.equal(
      details.diagnostics?.orphanBlobs.candidates[0]?.path,
      ".spark/artifacts/blobs/orphan-diagnostics.txt",
    );
    assert.equal(details.diagnostics?.terminalProjects.candidates[0]?.ref, terminalProject.ref);

    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(defaultArtifactStore(dir).pathFor(artifact.ref)), true);
    assert.equal(existsSync(orphanBlob), true);
    assert.equal(existsSync(noteFile), true);
    assert.equal(existsSync(roleReportFile), true);
    assert.equal(existsSync(reviewsIndexFile), true);
    assert.equal(existsSync(join(dir, ".spark", "workflow-runs.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state state_doctor reports store-v2 migration diagnostics with stable codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-doctor-store-v2-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Doctor project", description: "doctor" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Doctor task",
      description: "doctor task",
    });
    await defaultTaskGraphStore(dir).save(graph);

    await writeFile(join(dir, ".spark", "projects.json"), "{}", "utf8");
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}", "utf8");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "legacy-owner.json"),
      `${JSON.stringify({ version: 1, projectRef: "proj:missing" })}\n`,
      "utf8",
    );
    await mkdir(join(dir, ".spark", "sessions", "dangling-session"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "dangling-session", "state.json"),
      `${JSON.stringify({ version: 1, projectRef: "proj:missing", currentTaskRef: "task:missing" })}\n`,
      "utf8",
    );
    const reviewDir = join(
      dir,
      ".spark",
      "projects",
      storeDirNameForTest(project.ref),
      "tasks",
      storeDirNameForTest(task.ref),
      "reviews",
    );
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "artifact-dangling-review.json"),
      `${JSON.stringify({
        version: 1,
        subjectKind: "task",
        subjectRef: "task:missing",
        artifactRef: "artifact:dangling-review",
        outcome: "approved",
        summary: "dangling review",
        reviewedAt: "2026-06-18T00:00:00.000Z",
        recordedAt: "2026-06-18T00:00:00.000Z",
        reviewerRun: {},
        verdict: {},
        legacyImportOnly: [".spark/review-gate.json"],
      })}\n`,
      "utf8",
    );

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const doctor = await executeSparkTool(tools, "impl_state", ctx, { action: "state_doctor" });
    const text = toolText(doctor);
    assert.match(text, /Store V2 doctor findings:/);
    assert.match(text, /STORE_V2_LEGACY_IMPORT_ONLY_PRESENT/);
    assert.match(text, /\.spark\/sessions\/legacy-owner\.json/);
    assert.match(text, /STORE_V2_DANGLING_CURRENT_PROJECT_REF/);
    assert.match(text, /STORE_V2_DANGLING_CURRENT_TASK_REF/);
    assert.match(text, /STORE_V2_REVIEW_INDEX_MISSING/);
    assert.match(text, /STORE_V2_REVIEW_SUBJECT_MISSING_TASK/);
    const codes = new Set(
      (
        doctor.details as {
          diagnostics?: { doctor?: { findings?: Array<{ code?: string }> } };
        }
      ).diagnostics?.doctor?.findings?.map((finding) => finding.code),
    );
    assert.equal(codes.has("STORE_V2_LEGACY_IMPORT_ONLY_PRESENT"), true);
    assert.equal(codes.has("STORE_V2_DANGLING_CURRENT_PROJECT_REF"), true);
    assert.equal(codes.has("STORE_V2_DANGLING_CURRENT_TASK_REF"), true);
    assert.equal(codes.has("STORE_V2_REVIEW_INDEX_MISSING"), true);
    assert.equal(codes.has("STORE_V2_REVIEW_SUBJECT_MISSING_TASK"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state store_v2_migrate previews, backs up, applies legacy graph import idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-migrate-v2-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const legacyGraph = new TaskGraph();
    const project = legacyGraph.createProject({ title: "Legacy project", description: "legacy" });
    const task = legacyGraph.createTask({
      projectRef: project.ref,
      title: "Legacy task",
      description: "legacy task",
    });
    await new TaskGraphStore(join(dir, ".spark", "projects.json")).save(legacyGraph);
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await mkdir(join(dir, ".spark", "todos"), { recursive: true });
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", "legacy-owner.json"),
      `${JSON.stringify({ version: 1, projectRef: project.ref, currentTaskRef: task.ref })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".spark", "todos", "legacy-owner.json"),
      `${JSON.stringify({
        version: 1,
        todos: [
          {
            id: "todo-task-legacy",
            taskRef: task.ref,
            content: "Imported task plan item",
            status: "done",
          },
        ],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".spark", "session-todos", "legacy-owner.json"),
      `${JSON.stringify({
        version: 1,
        todos: [{ id: "todo-session-legacy", content: "Imported legacy item", status: "pending" }],
      })}\n`,
      "utf8",
    );
    await writeFile(join(dir, ".spark", "review-gate.json"), "{}\n", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const dryRun = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: true,
    });
    assert.match(toolText(dryRun), /Spark store V2 migration dry-run:/);
    assert.match(toolText(dryRun), /import-project-graph/);
    assert.match(toolText(dryRun), /import-session-state/);
    assert.match(toolText(dryRun), /import-task-todos/);
    assert.match(toolText(dryRun), /import-session-todos/);
    assert.match(toolText(dryRun), /record-cutover-marker/);
    assert.match(toolText(dryRun), /Import-only paths: \d+/);
    assert.match(toolText(dryRun), /\.spark\/projects\.json/);
    assert.match(toolText(dryRun), /\.spark\/sessions\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/todos\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/session-todos\/legacy-owner\.json/);
    assert.match(toolText(dryRun), /\.spark\/review-gate\.json/);
    await assert.rejects(() => readFile(projectTreeIndexPath(dir), "utf8"));

    const apply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: false,
    });
    assert.match(toolText(apply), /Spark store V2 migration apply:/);
    const backupDir = (apply.details as { migration?: { backupDir?: string } }).migration
      ?.backupDir;
    assert.ok(backupDir);
    assert.equal(existsSync(join(dir, backupDir, "projects.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "sessions", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "todos", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "session-todos", "legacy-owner.json")), true);
    assert.equal(existsSync(join(dir, backupDir, "review-gate.json")), true);
    const migrated = await defaultTaskGraphStore(dir).load();
    assert.equal(migrated?.getTask(task.ref).title, "Legacy task");
    assert.equal(existsSync(projectTreeIndexPath(dir)), true);
    assert.equal(existsSync(join(dir, ".spark", "sessions", "index.json")), true);
    assert.equal(existsSync(join(dir, ".spark", "reviews", "index.json")), true);
    assert.equal(existsSync(join(dir, ".spark", "sessions", "legacy-owner", "state.json")), true);
    assert.equal(
      (await defaultTaskTodoStore(dir, "migration").load())?.[0]?.id,
      "todo-task-legacy",
    );
    assert.equal(
      (await defaultTaskTodoStore(dir, "migration").loadSessionTodos("legacy-owner"))[0]?.id,
      "todo-session-legacy",
    );
    assert.equal(existsSync(join(dir, ".spark", "projects.json")), true);
    const marker = JSON.parse(
      await readFile(join(dir, ".spark", "store-v2-cutover.json"), "utf8"),
    ) as { version?: number; storeVersion?: string; status?: string };
    assert.deepEqual(
      { version: marker.version, storeVersion: marker.storeVersion, status: marker.status },
      { version: 1, storeVersion: "v2", status: "complete" },
    );
    const actionKinds = (
      apply.details as { migration?: { actions?: Array<{ kind: string; status: string }> } }
    ).migration?.actions?.map((action) => action.kind);
    assert.equal(actionKinds?.at(-1), "record-cutover-marker");
    assert.ok(
      actionKinds &&
        actionKinds.indexOf("validate-invariants") >= 0 &&
        actionKinds.indexOf("validate-invariants") < actionKinds.indexOf("record-cutover-marker"),
    );

    const secondApply = await executeSparkTool(tools, "impl_state", ctx, {
      action: "store_v2_migrate",
      dryRun: false,
    });
    assert.match(toolText(secondApply), /Spark store V2 migration apply:/);
    assert.equal((await defaultTaskGraphStore(dir).load())?.getTask(task.ref).title, "Legacy task");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state state_doctor surfaces artifact blob stat failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-stat-"));
  try {
    await writeEmptySparkProject(dir);
    const artifactDir = join(dir, ".spark", "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "too-long-blob.json"),
      `${JSON.stringify(
        {
          ref: "artifact:diagnostics-stat-failure",
          kind: "role-run",
          title: "Diagnostics stat failure",
          format: "text",
          blobPath: `blobs/${"x".repeat(4096)}/body.txt`,
          provenance: { producer: "spark" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await assert.rejects(
      () => executeSparkTool(tools, "impl_state", ctx, { action: "state_doctor" }),
      /ENAMETOOLONG|name too long/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state rejects invalid explicit action and path parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-action-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "impl_state", ctx, { action: "repair" }),
      /action must be state_status, state_doctor, store_v2_migrate, cache_cleanup, workflow_run_prune, or role_run_artifact_compact/,
    );
    for (const oldAction of [
      "status",
      "diagnostics",
      "doctor",
      "migrate-v2",
      "cleanup",
      "prune",
      "compact-role-run-artifacts",
    ]) {
      await assert.rejects(
        () => executeSparkTool(tools, "impl_state", ctx, { action: oldAction }),
        /action must be state_status, state_doctor, store_v2_migrate, cache_cleanup, workflow_run_prune, or role_run_artifact_compact/,
      );
    }
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_artifact_compact",
          exportDir: 42,
        }),
      /exportDir must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_artifact_compact",
          exportDir: "",
        }),
      /exportDir must be a non-empty string/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state rejects invalid numeric parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-numeric-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_artifact_compact",
          thresholdBytes: "1024",
        }),
      /thresholdBytes must be a finite number/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "role_run_artifact_compact",
          tailBytes: 0,
        }),
      /tailBytes must be a positive integer/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "workflow_run_prune",
          keepRecent: 1.5,
        }),
      /keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state rejects invalid boolean parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-boolean-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, { action: "cache_cleanup", dryRun: "false" }),
      /dryRun must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_state", ctx, {
          action: "cache_cleanup",
          includeBroken: "true",
        }),
      /includeBroken must be a boolean/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state role_run_artifact_compact dry-run lists large role-run candidates and keeps non-role artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-dry-run-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "Large historical role run",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-dry-run", "worker-large-dry-run", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-dry-run" as ProjectRef,
        taskRef: "task:retention-dry-run" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const research = await store.put({
      kind: "document",
      title: "Large research artifact",
      format: "text",
      body: "research\n".repeat(2 * 1024),
      provenance: { producer: "spark" },
    });
    const roleRunMetadata = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const researchMetadata = JSON.parse(await readFile(store.pathFor(research.ref), "utf8")) as {
      blobPath: string;
    };
    const roleRunBlob = join(dir, ".spark", "artifacts", roleRunMetadata.blobPath);
    const researchBlob = join(dir, ".spark", "artifacts", researchMetadata.blobPath);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_artifact_compact",
      thresholdBytes: 1024,
      tailBytes: 80,
    });

    const text = toolText(result);
    assert.match(text, /Spark role-run artifact retention dry-run/);
    assert.match(text, new RegExp(roleRun.ref));
    assert.doesNotMatch(text, new RegExp(research.ref));
    assert.match(text, /non-role-run=1/);
    assert.equal(existsSync(roleRunBlob), true);
    assert.equal(existsSync(researchBlob), true);

    const details = result.details as {
      retention?: {
        dryRun: boolean;
        candidates: Array<{
          ref: string;
          taskRef?: string;
          runRef?: string;
          candidateReason: string;
          replacementSummary: string;
          transcriptTail?: { tail: string; tailBytes: number };
        }>;
        skipped: Array<{ ref?: string; reason: string }>;
        deleted: unknown[];
      };
    };
    assert.equal(details.retention?.dryRun, true);
    assert.equal(details.retention?.deleted.length, 0);
    assert.equal(details.retention?.candidates.length, 1);
    assert.equal(details.retention?.candidates[0]?.ref, roleRun.ref);
    assert.equal(
      details.retention?.candidates[0]?.candidateReason,
      "large_role-run_transcript_blob",
    );
    assert.equal(details.retention?.candidates[0]?.taskRef, "task:retention-dry-run");
    assert.equal(details.retention?.candidates[0]?.runRef, "run:large-retention-dry-run");
    assert.match(details.retention?.candidates[0]?.replacementSummary ?? "", /compacted from/);
    assert.match(details.retention?.candidates[0]?.transcriptTail?.tail ?? "", /tail-marker/);
    assert.equal(
      details.retention?.skipped.some(
        (entry) => entry.ref === research.ref && entry.reason === "not_role_run_artifact",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state role_run_artifact_compact skips blob paths outside artifact root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-boundary-"));
  const outsidePath = `${dir}-outside-role-run.json`;
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "External role run blob",
      format: "json",
      body: largeLegacyRoleRunBody("run:external-retention", "worker-external", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-boundary" as ProjectRef,
        taskRef: "task:retention-boundary" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const metadataPath = store.pathFor(roleRun.ref);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { blobPath?: string };
    metadata.blobPath = outsidePath;
    await writeFile(outsidePath, "outside role-run transcript", "utf8");
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_artifact_compact",
      thresholdBytes: 1,
      tailBytes: 80,
    });

    assert.match(toolText(result), /invalid-blob-path=1/);
    assert.equal(existsSync(outsidePath), true);
    const details = result.details as {
      retention?: {
        candidates: unknown[];
        skipped: Array<{ ref?: string; reason: string }>;
      };
    };
    assert.equal(details.retention?.candidates.length, 0);
    assert.equal(
      details.retention?.skipped.some(
        (entry) => entry.ref === roleRun.ref && entry.reason === "invalid_blob_path",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

void test("impl_state role_run_artifact_compact reports invalid artifact metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-invalid-json-"));
  try {
    await writeEmptySparkProject(dir);
    const metadataDir = join(dir, ".spark", "artifacts");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "broken-role-run.json"), "{not-json", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_artifact_compact",
      thresholdBytes: 1,
      tailBytes: 80,
    });

    assert.match(toolText(result), /invalid-json=1/);
    const details = result.details as {
      retention?: {
        candidates: unknown[];
        skipped: Array<{ path: string; reason: string; message?: string }>;
      };
    };
    assert.equal(details.retention?.candidates.length, 0);
    const skipped = details.retention?.skipped.find((entry) => entry.reason === "invalid_json");
    assert.ok(skipped);
    assert.match(skipped.path, /broken-role-run\.json$/);
    assert.match(skipped.message ?? "", /Expected property name|not valid JSON|Unexpected token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_state role_run_artifact_compact apply writes replacement summary before deleting blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-apply-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "trace",
      title: "Large historical role run apply",
      format: "json",
      body: largeLegacyRoleRunBody("run:large-retention-apply", "worker-large-apply", 8 * 1024),
      provenance: {
        producer: "task",
        projectRef: "proj:retention-apply" as ProjectRef,
        taskRef: "task:retention-apply" as TaskRef,
        roleRef: "role:builtin-worker" as RoleRef,
      },
    });
    const before = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      blobPath: string;
    };
    const blob = join(dir, ".spark", "artifacts", before.blobPath);
    assert.equal(existsSync(blob), true);

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const applied = await executeSparkTool(tools, "impl_state", ctx, {
      action: "role_run_artifact_compact",
      dryRun: false,
      thresholdBytes: 1024,
      tailBytes: 80,
      exportDir: "exports/role-run-transcripts",
    });
    assert.match(toolText(applied), /Apply complete/);
    assert.equal(existsSync(blob), false);

    const after = JSON.parse(await readFile(store.pathFor(roleRun.ref), "utf8")) as {
      body: { summary: string; stdout: { tail: string } };
      bodyTruncated?: boolean;
      blobPath?: string;
      transcriptRetention?: {
        originalBlobPath?: string;
        replacementSummary?: string;
        exportPath?: string;
        fullTranscriptDeletedAt?: string;
      };
    };
    assert.equal(after.bodyTruncated, false);
    assert.equal(after.blobPath, undefined);
    assert.match(after.body.summary, /worker-large-apply/);
    assert.match(after.body.stdout.tail, /tail-marker/);
    assert.equal(after.transcriptRetention?.originalBlobPath, before.blobPath);
    assert.match(after.transcriptRetention?.replacementSummary ?? "", /compacted from/);
    assert.ok(after.transcriptRetention?.fullTranscriptDeletedAt);
    assert.ok(after.transcriptRetention?.exportPath);
    assert.equal(existsSync(join(dir, after.transcriptRetention.exportPath)), true);

    const fetched = await executeSparkTool(tools, "artifact", ctx, {
      action: "read",
      artifactRef: roleRun.ref,
    });
    assert.match(toolText(fetched), /Historical role-run transcript worker-large-apply/);
    assert.match(toolText(fetched), /transcriptRetention/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_plan_tasks keeps large plan output bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-bounded-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "impl_plan_tasks", ctx, {
      tasks: Array.from({ length: 8 }, (_, index) => ({
        name: `task-${index + 1}`,
        title: `Task ${index + 1}`,
        description: `Bounded output task ${index + 1}.`,
        plan: executionReadyPlan(`Bounded output task ${index + 1}.`),
      })),
    });
    const text = toolText(planned);

    assert.match(text, /Planned tasks: created=8 updated=0 dependencies=0/);
    assert.match(text, /… 3 more changed task\(s\)/);
    assert.equal((text.match(/^- created/gm) ?? []).length, 5);
    assert.doesNotMatch(text, /\(task:/);
    const details = planned.details as { result?: { created?: unknown[]; dependencies?: number } };
    assert.equal(details.result?.created?.length, 8);
    assert.equal(details.result?.dependencies, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session-scoped todo implementation is not registered", () => {
  const { tools } = registerSparkToolsForTest();
  assert.equal(tools.has("impl_update_todos"), false);
});

void test("spark todo tools reject invalid explicit ops without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-todos-invalid-ops-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    assert.equal(tools.has("impl_update_todos"), false);
    assert.equal(existsSync(sessionIndependentTodoPath(dir, ctx)), false);

    await useOnlySparkProject(tools, ctx);
    const claim = await planAndClaimTask(tools, ctx, {
      name: "todo-invalid",
      title: "Reject invalid plan item ops",
      description: "Invalid plan item ops must not alter task plan item state.",
      plan: executionReadyPlan("Reject invalid plan item ops."),
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "impl_update_task_plan_items", ctx, {
          ops: [{ op: "init", items: [42] }],
        }),
      /ops\[0\]\.items must be an array of strings/,
    );

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.equal(loaded?.getTask(taskRef).status, "running");
    const todoFile = sessionTaskTodoPath(dir, ctx);
    assert.equal(existsSync(todoFile), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("legacy session-scoped snapshot import rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const todoFile = sessionIndependentTodoPath(dir, ctx);
    assert.deepEqual(await loadIndependentTodos(dir, ctx), []);
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });

    await writeFile(todoFile, "[]\n", "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 2, todos: [] })}\n`, "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 1, todos: {} })}\n`, "utf8");
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /todos must be an array/.test(error.message),
    );

    await writeFile(
      todoFile,
      `${JSON.stringify({
        version: 1,
        todos: [{ content: "Coordinate review", status: "unknown" }],
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => importLegacyIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /todos\[0\]\.status must be a valid status/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("todo display number store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-display-numbers-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const displayNumberFile = todoDisplayNumberPath(dir, ctx);
    assert.deepEqual(await loadTodoDisplayNumberState(dir, ctx), {
      version: 1,
      next: 1,
      numbers: {},
    });
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: "2", numbers: { "todo:one": 1 } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /next must be a positive integer/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 2, numbers: { "todo:one": "1" } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /numbers\.todo:one must be a positive integer/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 2, numbers: { "todo:one": 2 } })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadTodoDisplayNumberState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === displayNumberFile &&
        /next must be greater than every display number/.test(error.message),
    );

    await writeFile(
      displayNumberFile,
      `${JSON.stringify({ version: 1, next: 3, numbers: { "todo:one": 2 } })}\n`,
      "utf8",
    );
    assert.deepEqual(await loadTodoDisplayNumberState(dir, ctx), {
      version: 1,
      next: 3,
      numbers: { "todo:one": 2 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("hidden role-run inbox store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-hidden-inbox-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const inboxFile = hiddenRoleRunInboxPath(dir, ctx);
    assert.deepEqual(await loadHiddenRoleRunInboxState(dir, ctx), { version: 1, delivered: [] });
    await mkdir(sessionDirectoryPath(dir, ctx), { recursive: true });

    await writeFile(inboxFile, `${JSON.stringify({ deliveredRunRefs: ["run:legacy"] })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /deliveredRunRefs is no longer supported/.test(error.message),
    );

    await writeFile(inboxFile, "[]\n", "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(inboxFile, `${JSON.stringify({ version: 2, delivered: [] })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(inboxFile, `${JSON.stringify({ version: 1, delivered: {} })}\n`, "utf8");
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /delivered must be an array/.test(error.message),
    );

    await writeFile(
      inboxFile,
      `${JSON.stringify({ version: 1, delivered: [{ runRef: "run:one" }] })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadHiddenRoleRunInboxState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === inboxFile &&
        /delivered\[0\]\.deliveredAt must be a non-empty string/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeEmptySparkProject(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".spark"), { recursive: true });
  const graph = new TaskGraph();
  graph.createProject({ title: "Tool persistence", description: "Test Spark tool persistence." });
  await defaultTaskGraphStore(cwd).save(graph);
}

async function writeRoadmap(
  cwd: string,
  input: {
    activeItemRef?: string;
    items: Array<{
      ref: string;
      title?: string;
      objective: string;
      scope?: string;
      status?: string;
      successCriteria?: string[];
      evidenceRequired?: string[];
    }>;
  },
): Promise<void> {
  const store = defaultTaskGraphStore(cwd);
  const graph = (await store.load()) ?? new TaskGraph();
  const project =
    graph.projects()[0] ??
    graph.createProject({ title: "Tool persistence", description: "Test Spark tool persistence." });
  const now = new Date().toISOString();
  graph.replaceProjectRoadmap(project.ref, {
    ref: "roadmap:main",
    title: "Project roadmap",
    status: "active",
    activeItemRef: input.activeItemRef as `roadmap-item:${string}` | undefined,
    items: input.items.map((item) => ({
      ...item,
      ref: item.ref as `roadmap-item:${string}`,
      status: item.status as "active" | "pending" | "blocked" | "done" | undefined,
    })),
    createdAt: now,
    updatedAt: now,
  });
  await store.save(graph);
}

function createTaskApprovingGoalUnmetReviewerRunner(): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      if (input.targetKind === "task") return createApprovingReviewerRunner().review(input);
      if (input.requestedStatus === "paused") return createApprovingReviewerRunner().review(input);
      return createRejectingReviewerRunner("goal still has remaining work").review(input);
    },
  };
}

function createApprovingReviewerRunner(): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      const timestamp = new Date().toISOString();
      const base = {
        outcome: "approved" as const,
        summary: "approved by test reviewer",
        findings: [],
        blockers: [],
        confidence: "high" as const,
      };
      return {
        verdict:
          input.targetKind === "task"
            ? {
                ...base,
                targetKind: "task" as const,
                taskRef: input.task.ref,
                approved: true,
              }
            : {
                ...base,
                targetKind: "goal" as const,
                goalId: input.goalId,
                achieved: input.requestedStatus === "complete",
                remainingWork: "",
              },
        record: {
          runRef: newRef("run"),
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "test-reviewer",
          startedAt: timestamp,
          finishedAt: timestamp,
        },
      };
    },
  };
}

function createRejectingReviewerRunner(
  summary = "needs changes from test reviewer",
): ReviewerRunner {
  return {
    async review(input: ReviewInput): Promise<ReviewerRunResult> {
      const timestamp = new Date().toISOString();
      return {
        verdict:
          input.targetKind === "task"
            ? {
                targetKind: "task" as const,
                taskRef: input.task.ref,
                approved: false,
                outcome: "needs_changes" as const,
                summary,
                findings: ["missing validation evidence"],
                blockers: ["run the focused tests"],
                confidence: "high" as const,
              }
            : {
                targetKind: "goal" as const,
                goalId: input.goalId,
                achieved: false,
                remainingWork: summary,
                outcome: "needs_changes" as const,
                summary,
                findings: ["goal remains incomplete"],
                blockers: ["finish remaining work"],
                confidence: "high" as const,
              },
        record: {
          runRef: newRef("run"),
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "test-reviewer",
          startedAt: timestamp,
          finishedAt: timestamp,
          stdout: "test reviewer raw stdout",
          stderr: "",
        },
      };
    },
  };
}

function registerSparkToolsForTest(options: { reviewerRunner?: ReviewerRunner } = {}): {
  tools: Map<string, SparkToolConfig>;
  messages: string[];
  customMessages: Array<{
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }>;
  commands: Map<string, Parameters<SparkExtensionApiForTest["registerCommand"]>[1]>;
  shortcuts: Map<string, Parameters<NonNullable<SparkExtensionApiForTest["registerShortcut"]>>[1]>;
  eventHandlers: Map<string, Array<(event: unknown, ctx: TestSparkContext) => unknown>>;
  getActiveToolNames: () => string[];
  registerActiveTool: (name: string) => void;
  setActiveTools: (names: string[]) => void;
} {
  const tools = new Map<string, SparkToolConfig>();
  const activeToolNames = new Set<string>();
  const messages: string[] = [];
  const customMessages: Array<{
    customType: string;
    content: string;
    display?: boolean;
    details?: Record<string, unknown>;
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }> = [];
  const commands = new Map<string, Parameters<SparkExtensionApiForTest["registerCommand"]>[1]>();
  const shortcuts = new Map<
    string,
    Parameters<NonNullable<SparkExtensionApiForTest["registerShortcut"]>>[1]
  >();
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: TestSparkContext) => unknown>
  >();
  const pi: SparkExtensionApiForTest & {
    getActiveTools: () => string[];
    getAllTools: () => Array<{ name: string }>;
    setActiveTools: (names: string[]) => void;
    createReviewerRunner: NonNullable<SparkExtensionApiForTest["createReviewerRunner"]>;
  } = {
    registerCommand: (name, config) => {
      commands.set(name, config);
    },
    registerTool: (config) => {
      tools.set(config.name, config);
      activeToolNames.add(config.name);
    },
    registerInternalTool: (config) => {
      tools.set(config.name, config);
    },
    registerShortcut: (shortcut, options) => {
      shortcuts.set(shortcut, options);
    },
    on: (event, handler) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler as (event: unknown, ctx: TestSparkContext) => unknown);
      eventHandlers.set(event, handlers);
    },
    sendMessage: (message, options) => {
      customMessages.push({ ...message, options });
    },
    getActiveTools: () => [...activeToolNames],
    // Mirror the real host: getAllTools() reports every registered tool,
    // including ones that are currently inactive. getActiveTools() reports
    // only the active subset.
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: (names) => {
      activeToolNames.clear();
      for (const name of names) {
        if (tools.has(name)) activeToolNames.add(name);
      }
    },
    createReviewerRunner: () =>
      options.reviewerRunner ?? createTaskApprovingGoalUnmetReviewerRunner(),
  };
  registerPiArtifactTool({
    registerTool: (config) => {
      tools.set(config.name, config as SparkToolConfig);
      activeToolNames.add(config.name);
    },
  });
  piAskExtension(pi as never);
  sparkExtension(pi);
  return {
    tools,
    messages,
    customMessages,
    commands,
    shortcuts,
    eventHandlers,
    getActiveToolNames: () => [...activeToolNames],
    // Register a no-op tool and mark it active, simulating a tool contributed
    // by another extension (e.g. pi-cue's `bash`) so tests can verify Spark
    // goal toggling never silently re-activates externally disabled tools.
    registerActiveTool: (name: string) => {
      tools.set(name, {
        name,
        description: `synthetic ${name}`,
        parameters: { type: "object" },
        async execute() {
          return { content: [{ type: "text" as const, text: "" }] };
        },
      } as SparkToolConfig);
      activeToolNames.add(name);
    },
    setActiveTools: (names: string[]) => pi.setActiveTools(names),
  };
}

function isForegroundGoalTickMessage(
  message: ReturnType<typeof registerSparkToolsForTest>["customMessages"][number] | undefined,
): boolean {
  return (
    message?.customType === "spark-goal-request" &&
    message.details?.purpose === "foreground-goal-tick"
  );
}

async function tryConsumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string | undefined> {
  for (const handler of run.eventHandlers.get("before_agent_start") ?? []) {
    const result = (await handler({}, ctx)) as
      | { message?: { customType?: string; content?: string; display?: boolean } }
      | undefined;
    if (result?.message?.customType === "spark-mode-context") {
      assert.equal(result.message.display, false);
      assert.ok(result.message.content);
      return result.message.content;
    }
  }
  return undefined;
}

async function consumeSparkModeContext(
  run: ReturnType<typeof registerSparkToolsForTest>,
  ctx: TestSparkContext,
): Promise<string> {
  return (
    (await tryConsumeSparkModeContext(run, ctx)) ?? assert.fail("missing hidden Spark mode context")
  );
}

async function executeSparkTool(
  tools: Map<string, SparkToolConfig>,
  name: string,
  ctx: TestSparkContext,
  params: Record<string, unknown>,
): Promise<SparkToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `missing Spark tool: ${name}`);
  return tool.execute(`call-${name}`, params, new AbortController().signal, () => undefined, ctx);
}

async function useOnlySparkProject(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await executeSparkTool(tools, "impl_use_project", ctx, { project: "Tool persistence" });
}

async function planAndClaimTask(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
  input: {
    [key: string]: unknown;
    name?: string;
    title: string;
    description: string;
    kind?: string;
    roleRef?: string;
    plan: TaskPlan;
  },
): Promise<SparkToolResult> {
  await executeSparkTool(tools, "impl_plan_tasks", ctx, {
    tasks: [
      {
        name: input.name,
        title: input.title,
        description: input.description,
        kind: input.kind,
        roleRef: input.roleRef,
        plan: input.plan,
      },
    ],
  });
  const graph = await defaultTaskGraphStore(ctx.cwd).load();
  const task = graph
    ?.tasks()
    .find((candidate) =>
      input.name ? candidate.name === input.name : candidate.title === input.title,
    );
  assert.ok(task, `planned task not found for claim: ${input.name ?? input.title}`);
  return executeSparkTool(tools, "impl_claim_task", ctx, { taskRef: task.ref });
}

async function useOnlySparkProjectInExplicitPlanMode(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await useOnlySparkProject(tools, ctx);
  const statePath = currentProjectStatePath(ctx.cwd, ctx);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { projectRef?: string };
  assert.ok(state.projectRef);
}

function storeDirNameForTest(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

function testSparkContext(cwd: string, sessionName: string): TestSparkContext {
  const sessionFile = join(cwd, ".pi-sessions", `${sessionName}.json`);
  const context: TestSparkContext = {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => `${sessionName}-leaf`,
    },
    hasUI: true,
    notifications: [],
    ui: {
      notify(message, level) {
        context.notifications.push({ message, level });
      },
      setWidget: () => undefined,
      setStatus: () => undefined,
      setEditorText: (text) => {
        context.editorText = text;
      },
      confirm: async () => true,
      input: async () => context.inputValue,
      select: async () => context.selected,
    },
  };
  return context;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await predicate(), "timed out waiting for condition");
}

function ctxSessionKey(ctx: TestSparkContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  return `session:${stableId(sessionFile)}`;
}

function ctxSessionStoreScope(ctx: TestSparkContext): string {
  return ctxSessionKey(ctx)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

function sessionTaskTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function sessionIndependentTodoPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "session-todos", `${ctxSessionStoreScope(ctx)}.json`);
}

function sessionDirectoryPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "sessions", ctxSessionStoreScope(ctx));
}

function hiddenRoleRunInboxPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "hidden-role-run-inbox.json");
}

function currentProjectStatePath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "state.json");
}

function projectTreeIndexPath(cwd: string): string {
  return join(cwd, ".spark", "projects", "index.json");
}

function projectTreeDirName(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-");
}

async function taskGraphSnapshotText(cwd: string): Promise<string> {
  const graph = await defaultTaskGraphStore(cwd).load();
  return JSON.stringify(graph?.snapshot() ?? null, null, 2);
}

function sessionGoalPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "goal.json");
}

function todoDisplayNumberPath(cwd: string, ctx: TestSparkContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "todo-display-numbers.json");
}

function toolText(result: SparkToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function largeLegacyRoleRunBody(runRef: RunRef, runName: string, paddingBytes: number) {
  return {
    record: {
      ref: runRef,
      roleRef: "role:builtin-worker",
      runName,
      instruction: "legacy instruction that should not be preserved in replacement metadata",
      status: "succeeded",
      startedAt: "2026-05-28T00:00:00.000Z",
      finishedAt: "2026-05-28T00:00:01.000Z",
    },
    stdout: `${"x".repeat(paddingBytes)}\ntail-marker ${runName}\n`,
    stderr: "",
    jsonEvents: [],
  };
}
