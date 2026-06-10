import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleRegistry } from "pi-roles";
import {
  newRef,
  stableId,
  type RoleRef,
  type RunRef,
  type TaskPlan,
  type TaskRef,
  type ProjectRef,
} from "pi-extension-api";
import { defaultArtifactStore } from "pi-artifacts";
import { defaultLearningStore, LearningExportFormatError } from "pi-learnings";
import { defaultSparkDagRunStore } from "../packages/pi-workflows/src/index.ts";
import {
  killActiveSparkRoleRunProcesses,
  listActiveSparkRoleRunProcesses,
  runSparkTask,
} from "spark-runtime";
import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  renderTaskPlanReadinessRules,
  TaskGraph,
} from "pi-tasks";
import { registerPiArtifactTool } from "pi-artifacts/extension";
import piAskExtension from "../packages/pi-ask/src/extension.ts";
import sparkExtension from "../packages/spark/src/extension/index.ts";
import { JsonStoreFormatError } from "../packages/spark/src/extension/json-store.ts";
import {
  loadCurrentProjectState,
  loadHiddenRoleRunInboxState,
  loadSparkMode,
  loadSparkRunMode,
  saveCurrentProjectRef,
} from "../packages/spark/src/extension/session-state.ts";
import {
  assignTodoDisplayNumber,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveIndependentTodos,
  saveTodoDisplayNumberState,
} from "../packages/spark/src/extension/session-todos.ts";
import {
  normalizeSparkProjectListStatus,
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusShowFinished,
  normalizeSparkStatusView,
} from "../packages/spark/src/extension/spark-status.ts";
import {
  normalizeForceAfterMs,
  normalizeKillSignal,
  normalizeOptionalProjectRef,
  normalizeOptionalRunRef,
  normalizeSparkBackgroundAction,
  normalizeSparkBackgroundBoolean,
} from "../packages/spark/src/extension/background-runs.ts";
import {
  normalizeSparkRunReadyTasksBoolean,
  normalizeSparkRunReadyTasksPositiveInteger,
} from "../packages/spark/src/extension/spark-run-ready-tasks-tool-registration.ts";
import { normalizeSparkPlanTaskInputs } from "../packages/spark/src/extension/spark-plan-tasks-tool-registration.ts";
import { normalizeSparkClaimTaskInput } from "../packages/spark/src/extension/spark-claim-task-tool-registration.ts";
import { normalizeSparkFinishTaskInput } from "../packages/spark/src/extension/spark-finish-task-tool-registration.ts";
import { normalizeSparkTodoOps } from "../packages/spark/src/extension/spark-todo-tool-registration.ts";
import {
  normalizeArtifactBoolean,
  normalizeArtifactKind,
  normalizeArtifactLimit,
  normalizeArtifactProducer,
  normalizeArtifactProjectRef,
  normalizeArtifactRef,
  normalizeArtifactRoleRef,
  normalizeArtifactTaskRef,
  normalizePositiveInteger,
} from "../packages/spark/src/extension/artifact-tools.ts";
import {
  normalizeLearningBoolean,
  normalizeLearningCategory,
  normalizeLearningConfidence,
  normalizeLearningInput,
  normalizeLearningLocation,
  normalizeLearningStatusFilter,
  normalizeStringArray,
} from "../packages/spark/src/extension/learning-tools.ts";
import {
  normalizeSparkDagManagerAction,
  normalizeSparkDagManagerBoolean,
  normalizeSparkDagManagerNonNegativeInteger,
  normalizeSparkDagManagerRunRef,
} from "../packages/spark/src/extension/spark-dag-manager-tool-registration.ts";
import {
  normalizeSparkNewProjectInput,
  normalizeSparkProjectOptionalString,
  normalizeSparkProjectOutputLanguage,
  normalizeSparkProjectPatch,
  normalizeSparkProjectStatus,
} from "../packages/spark/src/extension/spark-project-tools.ts";
import {
  normalizeSparkStateAction,
  normalizeSparkStateOptionalString,
} from "../packages/spark/src/extension/spark-state-tool-registration.ts";
import {
  normalizeTaskKind,
  normalizeTaskStatus,
} from "../packages/spark/src/extension/task-plan-tool.ts";
import { normalizeSparkAskReplayArtifactRef } from "../packages/spark/src/extension/spark-ask-tool-registration.ts";
import {
  loadSessionGoal,
  setSessionGoal,
} from "../packages/spark/src/extension/spark-session-goals.ts";
import type {
  ReviewInput,
  ReviewerRunResult,
  ReviewerRunner,
} from "../packages/spark/src/extension/reviewer-runner.ts";

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

void test("Spark status normalizers reject invalid explicit parameters instead of using defaults", () => {
  assert.equal(normalizeSparkStatusView({}), "active");
  assert.equal(normalizeSparkStatusFormat({}), "text");
  assert.equal(normalizeSparkProjectListStatus({}), "active");
  assert.equal(normalizeSparkStatusLimit({}), undefined);
  assert.equal(normalizeSparkStatusShowFinished({}), false);

  assert.throws(() => normalizeSparkStatusView({ view: "compact" }), /view must be active/);
  assert.throws(
    () => normalizeSparkStatusFormat({ format: "yaml" }),
    /format must be text or json/,
  );
  assert.throws(
    () => normalizeSparkProjectListStatus({ status: "archived" }),
    /status must be active, done, or all/,
  );
  assert.throws(() => normalizeSparkStatusLimit({ limit: "20" }), /limit must be a finite number/);
  assert.throws(
    () => normalizeSparkStatusLimit({ limit: 1.5 }),
    /limit must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeSparkStatusShowFinished({ showFinished: "true" }),
    /showFinished must be a boolean/,
  );
});

void test("Spark background-run normalizers reject invalid explicit parameters instead of using defaults", () => {
  assert.equal(normalizeSparkBackgroundAction(undefined), "status");
  assert.equal(normalizeSparkBackgroundAction("kill"), "kill");
  assert.equal(normalizeOptionalRunRef(" run:child "), "run:child");
  assert.equal(normalizeOptionalProjectRef(" proj:main "), "proj:main");
  assert.equal(normalizeKillSignal("sigkill"), "SIGKILL");
  assert.equal(normalizeForceAfterMs(0), 0);
  assert.equal(normalizeSparkBackgroundBoolean(undefined, false, "field"), false);

  assert.throws(
    () => normalizeSparkBackgroundAction("stop"),
    /action must be status, list, inspect, kill, reconcile, or ack/,
  );
  assert.throws(() => normalizeOptionalRunRef("child"), /runRef must be a run ref/);
  assert.throws(() => normalizeOptionalRunRef(123), /runRef must be a string/);
  assert.throws(() => normalizeOptionalProjectRef("project"), /projectRef must be a project ref/);
  assert.throws(() => normalizeKillSignal("TERM"), /signal must be one of/);
  assert.throws(() => normalizeForceAfterMs("0"), /forceAfterMs must be a finite number/);
  assert.throws(() => normalizeForceAfterMs(1.5), /forceAfterMs must be a non-negative integer/);
  assert.throws(
    () => normalizeSparkBackgroundBoolean("true", false, "includeHistory"),
    /includeHistory must be a boolean/,
  );
});

void test("Spark ready-task runner tool normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeSparkRunReadyTasksBoolean(undefined, true, "dryRun"), true);
  assert.equal(normalizeSparkRunReadyTasksBoolean(false, true, "dryRun"), false);
  assert.throws(
    () => normalizeSparkRunReadyTasksBoolean("false", true, "dryRun"),
    /dryRun must be a boolean/,
  );

  assert.equal(normalizeSparkRunReadyTasksPositiveInteger(undefined, 4, "maxConcurrency"), 4);
  assert.equal(normalizeSparkRunReadyTasksPositiveInteger(2, 4, "maxConcurrency"), 2);
  assert.throws(
    () => normalizeSparkRunReadyTasksPositiveInteger("2", 4, "maxConcurrency"),
    /maxConcurrency must be a finite number/,
  );
  assert.throws(
    () => normalizeSparkRunReadyTasksPositiveInteger(2.5, 4, "maxConcurrency"),
    /maxConcurrency must be a positive integer/,
  );
  assert.throws(
    () => normalizeSparkRunReadyTasksPositiveInteger(0, 4, "maxConcurrency"),
    /maxConcurrency must be a positive integer/,
  );
});

void test("Spark DAG manager normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeSparkDagManagerAction(undefined), "status");
  assert.equal(normalizeSparkDagManagerAction("prune"), "prune");
  assert.throws(
    () => normalizeSparkDagManagerAction("acknowledge"),
    /action must be status, reconcile, ack, clear_inactive, prune, or kill_active/,
  );
  assert.throws(
    () => normalizeSparkDagManagerAction(""),
    /action must be status, reconcile, ack, clear_inactive, prune, or kill_active/,
  );

  assert.equal(normalizeSparkDagManagerRunRef(undefined), undefined);
  assert.equal(normalizeSparkDagManagerRunRef("run:one"), "run:one");
  assert.throws(() => normalizeSparkDagManagerRunRef("task:one"), /runRef must be a run: ref/);

  assert.equal(normalizeSparkDagManagerBoolean(undefined, true, "dryRun"), true);
  assert.equal(normalizeSparkDagManagerBoolean(false, true, "dryRun"), false);
  assert.throws(
    () => normalizeSparkDagManagerBoolean("false", true, "dryRun"),
    /dryRun must be a boolean/,
  );

  assert.equal(normalizeSparkDagManagerNonNegativeInteger(undefined, 10, "keepRecent"), 10);
  assert.equal(normalizeSparkDagManagerNonNegativeInteger(0, 10, "keepRecent"), 0);
  assert.throws(
    () => normalizeSparkDagManagerNonNegativeInteger("0", 10, "keepRecent"),
    /keepRecent must be a finite number/,
  );
  assert.throws(
    () => normalizeSparkDagManagerNonNegativeInteger(1.5, 10, "keepRecent"),
    /keepRecent must be a non-negative integer/,
  );
  assert.throws(
    () => normalizeSparkDagManagerNonNegativeInteger(-1, 10, "keepRecent"),
    /keepRecent must be a non-negative integer/,
  );
});

void test("Spark artifact normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeArtifactLimit(undefined, 20), 20);
  assert.equal(normalizeArtifactLimit(0, 20), 0);
  assert.equal(normalizeArtifactLimit(12, 20), 12);
  assert.throws(() => normalizeArtifactLimit("12", 20), /limit must be a finite number/);
  assert.throws(() => normalizeArtifactLimit(1.5, 20), /limit must be a non-negative integer/);
  assert.throws(() => normalizeArtifactLimit(-1, 20), /limit must be a non-negative integer/);

  assert.equal(normalizePositiveInteger(undefined, 1, "thresholdBytes"), 1);
  assert.equal(normalizePositiveInteger(8, 1, "thresholdBytes"), 8);
  assert.throws(
    () => normalizePositiveInteger(0, 1, "thresholdBytes"),
    /thresholdBytes must be a positive integer/,
  );

  assert.equal(normalizeArtifactKind(undefined), undefined);
  assert.equal(normalizeArtifactKind("research"), "research");
  assert.throws(() => normalizeArtifactKind("note"), /kind must be spark-md/);
  assert.equal(normalizeArtifactProducer(undefined), undefined);
  assert.equal(normalizeArtifactProducer("spark"), "spark");
  assert.throws(() => normalizeArtifactProducer("agent"), /producer must be spark/);

  assert.equal(normalizeArtifactBoolean(undefined, false, "full"), false);
  assert.equal(normalizeArtifactBoolean(true, false, "full"), true);
  assert.throws(() => normalizeArtifactBoolean("true", false, "full"), /full must be a boolean/);

  assert.equal(normalizeArtifactProjectRef("proj:one"), "proj:one");
  assert.equal(normalizeArtifactTaskRef("task:one"), "task:one");
  assert.equal(normalizeArtifactRoleRef("role:one"), "role:one");
  assert.equal(normalizeArtifactRef("artifact:one"), "artifact:one");
  assert.throws(() => normalizeArtifactProjectRef("project:one"), /projectRef must be a proj: ref/);
  assert.throws(() => normalizeArtifactTaskRef(42), /taskRef must be a string/);
  assert.throws(() => normalizeArtifactRoleRef("task:one"), /roleRef must be a role: ref/);
  assert.throws(() => normalizeArtifactRef("note:one"), /artifactRef must be an artifact: ref/);
});

void test("Spark learning normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeLearningStatusFilter(undefined), undefined);
  assert.equal(normalizeLearningStatusFilter("active"), "active");
  assert.deepEqual(normalizeLearningStatusFilter(["active", "candidate"]), ["active", "candidate"]);
  assert.throws(() => normalizeLearningStatusFilter("archived"), /status must be candidate/);
  assert.throws(() => normalizeLearningStatusFilter(["active", "archived"]), /status must be/);

  assert.equal(normalizeLearningLocation("workspace"), "workspace");
  assert.equal(normalizeLearningLocation("repo"), "repo");
  assert.throws(() => normalizeLearningLocation("thread"), /location must be user/);
  assert.equal(normalizeLearningCategory("decision"), "decision");
  assert.throws(() => normalizeLearningCategory("lesson"), /category must be pattern/);

  assert.deepEqual(normalizeStringArray(["a", "b"], "tags"), ["a", "b"]);
  assert.throws(() => normalizeStringArray(["a", 1], "tags"), /tags must be a string array/);
  assert.equal(normalizeLearningBoolean(undefined, false, "includeCandidates"), false);
  assert.throws(
    () => normalizeLearningBoolean("true", false, "includeCandidates"),
    /includeCandidates must be a boolean/,
  );

  assert.equal(normalizeLearningConfidence(undefined), undefined);
  assert.equal(normalizeLearningConfidence(0.75), 0.75);
  assert.throws(() => normalizeLearningConfidence(1.2), /confidence must be a finite number/);
  assert.throws(
    () =>
      normalizeLearningInput({
        title: "Bad learning",
        statement: "Bad learning statement",
        tags: ["valid", 1],
      }),
    /tags must be a string array/,
  );
});

void test("Spark state normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeSparkStateAction(undefined), "status");
  assert.equal(
    normalizeSparkStateAction("compact-role-run-artifacts"),
    "compact-role-run-artifacts",
  );
  assert.throws(() => normalizeSparkStateAction("repair"), /action must be status/);
  assert.throws(() => normalizeSparkStateAction(42), /action must be status/);

  assert.equal(normalizeSparkStateOptionalString(undefined, "exportDir"), undefined);
  assert.equal(normalizeSparkStateOptionalString("exports", "exportDir"), "exports");
  assert.throws(() => normalizeSparkStateOptionalString("", "exportDir"), /exportDir must be/);
  assert.throws(() => normalizeSparkStateOptionalString(1, "exportDir"), /exportDir must be/);
});

void test("Spark project normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeSparkProjectOptionalString(undefined, "title"), undefined);
  assert.equal(normalizeSparkProjectOptionalString(" Demo ", "title"), "Demo");
  assert.throws(() => normalizeSparkProjectOptionalString("", "title"), /title must be/);
  assert.throws(() => normalizeSparkProjectOptionalString(1, "title"), /title must be/);

  assert.equal(normalizeSparkProjectStatus(undefined), undefined);
  assert.equal(normalizeSparkProjectStatus("done"), "done");
  assert.throws(() => normalizeSparkProjectStatus("archived"), /status must be active or done/);

  assert.equal(normalizeSparkProjectOutputLanguage(undefined), undefined);
  assert.equal(normalizeSparkProjectOutputLanguage("zh"), "zh");
  assert.throws(() => normalizeSparkProjectOutputLanguage("fr"), /outputLanguage must be zh or en/);

  assert.deepEqual(
    normalizeSparkProjectPatch({ title: " Renamed ", purpose: " Ship v0 ", status: "active" }),
    {
      title: "Renamed",
      description: undefined,
      purpose: "Ship v0",
      status: "active",
      outputLanguage: undefined,
    },
  );
  assert.throws(() => normalizeSparkProjectPatch({ title: "" }), /title must be/);
  assert.throws(() => normalizeSparkProjectPatch({ outputLanguage: "jp" }), /outputLanguage/);

  assert.deepEqual(
    normalizeSparkNewProjectInput({ project: " Demo ", title: " Next ", purpose: " Ship v0 " }),
    {
      project: "Demo",
      title: "Next",
      description: undefined,
      purpose: "Ship v0",
      outputLanguage: undefined,
    },
  );
  assert.deepEqual(normalizeSparkProjectPatch({ intent: "legacy alias" }), {
    title: undefined,
    description: undefined,
    purpose: undefined,
    status: undefined,
    outputLanguage: undefined,
  });
  assert.throws(() => normalizeSparkNewProjectInput({ project: "" }), /project must be/);
});

void test("Spark task plan normalizers reject invalid explicit parameters", () => {
  assert.equal(normalizeTaskKind(undefined), undefined);
  assert.equal(normalizeTaskKind("implement"), "implement");
  assert.throws(() => normalizeTaskKind("build"), /kind must be research/);
  assert.throws(() => normalizeTaskKind(1), /kind must be research/);

  assert.equal(normalizeTaskStatus(undefined), undefined);
  assert.equal(normalizeTaskStatus("pending"), "pending");
  assert.throws(() => normalizeTaskStatus("waiting"), /status must be pending/);
  assert.throws(() => normalizeTaskStatus(false), /status must be pending/);

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

  assert.equal(normalizeSparkPlanTaskInputs({}, new RoleRegistry()), undefined);
  assert.throws(
    () => normalizeSparkPlanTaskInputs({ tasks: {} }, new RoleRegistry()),
    /tasks must be a non-empty array/,
  );
  assert.throws(
    () =>
      normalizeSparkPlanTaskInputs(
        { tasks: [{ title: 42, description: "Implement focused task." }] },
        new RoleRegistry(),
      ),
    /tasks\[0\]\.title must be a string/,
  );
  assert.throws(
    () =>
      normalizeSparkPlanTaskInputs(
        { tasks: [{ title: "Focused task", description: "Implement.", dependsOn: [1] }] },
        new RoleRegistry(),
      ),
    /tasks\[0\]\.dependsOn must be an array of strings/,
  );
  assert.throws(
    () =>
      normalizeSparkPlanTaskInputs(
        { tasks: [{ title: "Focused task", description: "Implement.", plan: "later" }] },
        new RoleRegistry(),
      ),
    /tasks\[0\]\.plan must be an object/,
  );
  assert.throws(
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
  );

  const claimInput = normalizeSparkClaimTaskInput(
    {
      name: " focused-claim ",
      title: " Focused claim ",
      description: " Claim focused work. ",
      kind: "implement",
      status: "ready",
      plan: {
        objective: " Ship focused claim ",
        successCriteria: [" command passes "],
        evidenceRequired: [" focused test output "],
        riskLevel: "trivial",
      },
      todos: [" Inspect ", " Verify "],
    },
    new RoleRegistry(),
  );
  assert.equal(claimInput.name, "focused-claim");
  assert.equal(claimInput.title, "Focused claim");
  assert.equal(claimInput.description, "Claim focused work.");
  assert.equal(claimInput.kind, "implement");
  assert.equal(claimInput.requestedStatus, "ready");
  assert.equal(claimInput.plan?.riskLevel, "trivial");
  assert.deepEqual(claimInput.todos, ["Inspect", "Verify"]);

  assert.throws(
    () =>
      normalizeSparkClaimTaskInput(
        { title: 42, description: "Claim focused work." },
        new RoleRegistry(),
      ),
    /title must be a string/,
  );
  assert.throws(
    () =>
      normalizeSparkClaimTaskInput(
        { title: "Focused claim", description: "Claim.", todos: [1] },
        new RoleRegistry(),
      ),
    /todos must be an array of strings/,
  );
  assert.throws(
    () =>
      normalizeSparkClaimTaskInput(
        { title: "Focused claim", description: "Claim.", plan: "later" },
        new RoleRegistry(),
      ),
    /plan must be an object/,
  );
  assert.throws(
    () =>
      normalizeSparkClaimTaskInput(
        { title: "Focused claim", description: "Claim.", plan: { riskLevel: "urgent" } },
        new RoleRegistry(),
      ),
    /plan\.riskLevel must be trivial, normal, or high/,
  );

  assert.deepEqual(normalizeSparkFinishTaskInput({}), {
    task: undefined,
    status: "done",
    summary: undefined,
    evidenceRefs: [],
  });
  assert.deepEqual(
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
    },
  );
  assert.throws(
    () => normalizeSparkFinishTaskInput({ status: "cancel" }),
    /status must be done, failed, or cancelled/,
  );
  assert.throws(
    () => normalizeSparkFinishTaskInput({ evidenceRefs: "artifact:focused-validation" }),
    /evidenceRefs must be an array of artifact refs/,
  );
  assert.throws(
    () => normalizeSparkFinishTaskInput({ evidenceRefs: ["task:not-an-artifact"] }),
    /evidenceRefs\[0\] must be an artifact: ref/,
  );
  assert.throws(() => normalizeSparkFinishTaskInput({ summary: 42 }), /summary must be a string/);

  assert.deepEqual(normalizeSparkTodoOps(undefined), undefined);
  assert.deepEqual(normalizeSparkTodoOps([{ op: "init", items: [" One ", "Two"] }]), [
    { op: "init", items: ["One", "Two"] },
  ]);
  assert.deepEqual(normalizeSparkTodoOps([{ op: "block", item: "One", blockedBy: [" Gate "] }]), [
    { op: "block", item: "One", blockedBy: ["Gate"] },
  ]);
  assert.throws(() => normalizeSparkTodoOps({}), /ops must be a non-empty array/);
  assert.throws(
    () => normalizeSparkTodoOps([{ op: "pause", item: "One" }]),
    /ops\[0\]\.op must be init/,
  );
  assert.throws(
    () => normalizeSparkTodoOps([{ op: "init", items: [1] }]),
    /ops\[0\]\.items must be an array of strings/,
  );
});

void test("Spark ask replay normalizer rejects invalid explicit artifact refs", () => {
  assert.equal(normalizeSparkAskReplayArtifactRef(undefined), undefined);
  assert.equal(normalizeSparkAskReplayArtifactRef("artifact:ask-one"), "artifact:ask-one");
  assert.throws(() => normalizeSparkAskReplayArtifactRef(42), /artifactRef must be a string/);
  assert.throws(
    () => normalizeSparkAskReplayArtifactRef("ask:one"),
    /artifactRef must be an artifact: ref/,
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
  ui: {
    notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    setWidget: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus: (key: string, text: string | undefined) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
    input: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    custom?: (...args: unknown[]) => unknown;
  };
};

interface TaskTodoStoreFile {
  version: 1;
  todos: Array<{
    taskRef: string;
    content: string;
    status: string;
    notes?: string[];
  }>;
}

interface IndependentTodoStoreFile {
  version: 1;
  todos: Array<{
    id?: string;
    content: string;
    status: string;
    notes?: string[];
    blockedBy?: string[];
    deletedAt?: string;
  }>;
}

void test("/spark command detects empty, existing, and initialized project modes", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "spark-command-empty-"));
  const existingDir = await mkdtemp(join(tmpdir(), "spark-command-existing-"));
  const initializedDir = await mkdtemp(join(tmpdir(), "spark-command-initialized-"));
  try {
    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyCommand = emptyRun.commands.get("spark");
    assert.ok(emptyCommand, "missing /spark command");
    await emptyCommand.handler("Build a contextual Spark cockpit", emptyCtx);
    assert.ok(existsSync(join(emptyDir, ".spark", "projects.json")));
    assert.equal(emptyRun.messages.length, 0);
    const emptyMessage = emptyRun.customMessages[0]?.content ?? "";
    assert.match(emptyMessage, /Spark initialized|Spark 已初始化/);
    const emptyHidden = await consumeSparkModeContext(emptyRun, emptyCtx);
    assert.match(emptyHidden, /minimal local state/);
    assert.match(emptyHidden, /task\(\{ action: "project_update" \}\)/);
    assert.match(emptyHidden, /do not create tasks merely because Spark just initialized/);

    await mkdir(join(existingDir, ".git"));
    await writeFile(join(existingDir, "README.md"), "# Existing project\n", "utf8");
    const existingCtx = testSparkContext(existingDir, "main");
    existingCtx.inputValue = "Audit existing project structure";
    const existingRun = registerSparkToolsForTest();
    const existingCommand = existingRun.commands.get("spark");
    assert.ok(existingCommand, "missing /spark command");
    await existingCommand.handler("", existingCtx);
    assert.ok(existsSync(join(existingDir, ".spark", "projects.json")));
    assert.ok(existsSync(join(existingDir, "SPARK.md")));
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.doesNotMatch(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark plan mode requested/);
    const existingMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(existingMessage, /Enter Spark planning mode/);
    assert.match(existingMessage, /Audit existing project structure/);
    assert.match(existingMessage, /answer directly for a simple research\/read-and-comment turn/);
    assert.match(
      existingMessage,
      /task\(\{ action: "plan" \}\) only when there are concrete plan-bound tasks/,
    );
    assert.match(existingMessage, /context-specific ask questions/);
    assert.match(existingMessage, /Do not use generic intake templates/);
    assert.match(existingMessage, /Reminder for planning mode/);
    assert.match(existingMessage, /plan\.openQuestions/);
    const existingProjectJson = await readFile(
      join(existingDir, ".spark", "projects.json"),
      "utf8",
    );
    assert.doesNotMatch(existingProjectJson, /Plan existing project/);
    assert.doesNotMatch(existingProjectJson, /Analyze project intent/);
    assert.doesNotMatch(existingProjectJson, /Plan targeted clarification/);
    assert.doesNotMatch(existingProjectJson, /Review initial direction/);

    await writeEmptySparkProject(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(join(initializedDir, ".spark", "sessions"), { recursive: true });
      await writeFile(
        join(initializedDir, ".spark", "sessions", `${ctxSessionStoreScope(initializedCtx)}.json`),
        JSON.stringify({ projectRef: project.ref }, null, 2),
        "utf8",
      );
      graph.createTask({
        projectRef: project.ref,
        title: "Implementation task needing a plan",
        description: "Implementation task needing a plan",
        status: "pending",
      });
    });
    const initializedRun = registerSparkToolsForTest();
    const initializedCommand = initializedRun.commands.get("spark");
    assert.ok(initializedCommand, "missing /spark command");
    await initializedCommand.handler("", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /Spark plan mode requested/);
    assert.match(
      await consumeSparkModeContext(initializedRun, initializedCtx),
      /Enter Spark planning mode/,
    );

    await initializedCommand.handler("investigate current context", initializedCtx);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark research mode requested/,
    );
    {
      const researchMsg = await consumeSparkModeContext(initializedRun, initializedCtx);
      assert.match(researchMsg, /Enter Spark research mode/);
      assert.match(researchMsg, /Do not call task\(\{ action: "plan" \| "claim" \| "finish" \}\)/);
    }

    initializedCtx.ui.select = async () =>
      assert.fail("clear /spark execution prompts should not ask for mode");
    await initializedCommand.handler("execute the ready task", initializedCtx);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execute mode requested/,
    );
    assert.match(
      await consumeSparkModeContext(initializedRun, initializedCtx),
      /Enter Spark execution mode/,
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(existingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(initializedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("bare /spark in an existing project infers a context planning focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-command-existing-no-focus-"));
  try {
    await writeFile(
      join(dir, "README.md"),
      "# Existing project\n\nA focused repository for Spark workflow tests.\n",
      "utf8",
    );
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const command = run.commands.get("spark");
    assert.ok(command, "missing /spark command");

    await command.handler("", ctx);

    assert.ok(existsSync(join(dir, ".spark", "projects.json")));
    assert.ok(
      ctx.notifications.some((notification) =>
        /inferred a planning focus/.test(notification.message),
      ),
    );
    assert.equal(run.messages.length, 0);
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark plan mode requested/);
    const message = await consumeSparkModeContext(run, ctx);
    assert.match(message, /Existing project/);
    assert.match(message, /focused repository for Spark workflow tests/);
    assert.match(message, /infer the current project purpose/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/research, /plan, /execute, /goal, and /workflow selector commands enter Spark modes directly", async () => {
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
    assert.ok(existsSync(join(existingDir, ".spark", "projects.json")));
    assert.equal(existsSync(join(existingDir, "SPARK.md")), false);
    assert.equal(existingRun.messages.length, 0);
    assert.equal(existingRun.customMessages.length, 1);
    assert.doesNotMatch(existingRun.customMessages[0]?.content ?? "", /Spark initialized/);
    assert.doesNotMatch(
      existingRun.customMessages[0]?.content ?? "",
      /Enter Spark planning mode from \/plan/,
    );
    assert.match(existingRun.customMessages[0]?.content ?? "", /Spark plan mode requested/);
    assert.match(existingRun.customMessages[0]?.content ?? "", /Audit current task flow/);
    const planMessage = await consumeSparkModeContext(existingRun, existingCtx);
    assert.match(planMessage, /Enter Spark planning mode from \/plan/);
    assert.match(planMessage, /not as a permission gate/);
    assert.match(planMessage, /Audit current task flow/);
    assert.match(planMessage, /context-specific ask questions/);
    assert.match(planMessage, /target project selection/);
    assert.match(planMessage, /design options only or durable task planning/);
    assert.match(
      planMessage,
      /Do not call task\(\{ action: "plan" \}\) while those choices remain unresolved/,
    );
    assert.match(planMessage, /do not leave them as prose/);
    assert.match(planMessage, /do not use canned intake templates/);
    assert.match(planMessage, /Reminder for planning mode/);
    assert.match(planMessage, /call ask with context-specific questions/);
    assert.match(
      planMessage,
      /Once planning-affecting uncertainty is resolved, call task\(\{ action: "plan" \}\) directly/,
    );
    assert.doesNotMatch(
      planMessage,
      /answer directly for a simple research\/read-and-comment turn/,
    );
    const planningState = JSON.parse(
      await readFile(
        join(existingDir, ".spark", "sessions", `${ctxSessionStoreScope(existingCtx)}.json`),
        "utf8",
      ),
    ) as { planningMode?: { source?: string; projectRef?: string; focus?: string } };
    assert.equal(planningState.planningMode?.source, "direct");
    assert.match(planningState.planningMode?.projectRef ?? "", /^proj:/);
    assert.equal(planningState.planningMode?.focus, "Audit current task flow");

    await writeEmptySparkProject(initializedDir);
    const initializedCtx = testSparkContext(initializedDir, "main");
    await defaultTaskGraphStore(initializedDir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(join(initializedDir, ".spark", "sessions"), { recursive: true });
      await writeFile(
        join(initializedDir, ".spark", "sessions", `${ctxSessionStoreScope(initializedCtx)}.json`),
        JSON.stringify({ projectRef: project.ref }, null, 2),
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
    const executeCommand = initializedRun.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Finish the direct execution task", initializedCtx);
    assert.equal(initializedRun.messages.length, 0);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execute mode requested/,
    );
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Finish the direct execution task/,
    );
    const executeMessage = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(executeMessage, /Enter Spark execution mode/);
    assert.match(executeMessage, /Execution focus: Finish the direct execution task/);
    assert.match(executeMessage, /Claim at most one concrete task/);
    assert.match(executeMessage, /Stop after that task finishes/);
    assert.match(executeMessage, /suggest \/goal/);
    assert.match(executeMessage, /suggest \/workflow/);
    assert.match(executeMessage, /missing user decision blocks execution/);
    assert.match(executeMessage, /do not guess user intent/);
    assert.doesNotMatch(executeMessage, /continue by auto-claiming/);
    assert.equal(
      initializedCtx.notifications.at(-1)?.message,
      "Spark execute mode: default strategy selected.",
    );

    initializedCtx.ui.select = async () =>
      assert.fail("/execute should not open a canned execute-strategy ask");
    await executeCommand.handler("keep going until done", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /strategy: default/);
    const askedGoalState = JSON.parse(
      await readFile(
        join(initializedDir, ".spark", "sessions", `${ctxSessionStoreScope(initializedCtx)}.json`),
        "utf8",
      ),
    ) as { executionMode?: { mode?: string; strategy?: string } };
    assert.equal(askedGoalState.executionMode?.mode, "execute");
    assert.equal(askedGoalState.executionMode?.strategy, "default");
    const untilDoneExecutePrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(untilDoneExecutePrompt, /suggest \/goal/);
    assert.match(untilDoneExecutePrompt, /suggest \/workflow/);
    initializedCtx.ui.select = async () =>
      assert.fail("explicit /workflow selector aliases should not ask for strategy");

    const goalCommand = initializedRun.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(initializedRun.commands.get("workflow:goal"), undefined);
    assert.equal(initializedRun.commands.get("workflow:deep-research"), undefined);
    assert.equal(initializedRun.commands.get("workflow:adversarial-review"), undefined);
    await goalCommand.handler("Finish the queue until done", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /Spark goal active/);
    assert.doesNotMatch(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Spark execute mode requested/,
    );
    assert.doesNotMatch(initializedRun.customMessages.at(-1)?.content ?? "", /strategy: goal/);
    assert.match(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /Finish the queue until done/,
    );
    const goalPrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(goalPrompt, /Spark session goal is active/);
    assert.match(goalPrompt, /Finish the queue until done/);
    const goalSessionStateRaw = await readFile(
      join(
        initializedDir,
        ".spark",
        "session-goals",
        `${ctxSessionStoreScope(initializedCtx)}.json`,
      ),
      "utf8",
    );
    const goalSessionState = JSON.parse(goalSessionStateRaw) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalSessionState.goal?.objective, "Finish the queue until done");
    assert.equal(goalSessionState.goal?.status, "active");
    const sessionAfterGoal = JSON.parse(
      await readFile(
        join(initializedDir, ".spark", "sessions", `${ctxSessionStoreScope(initializedCtx)}.json`),
        "utf8",
      ),
    ) as { executionMode?: unknown };
    assert.equal(sessionAfterGoal.executionMode, undefined);

    await goalCommand.handler("", initializedCtx);
    const inferredGoalPrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(inferredGoalPrompt, /Spark foreground goal loop tick/);
    assert.match(inferredGoalPrompt, /Finish the queue until done/);
    assert.doesNotMatch(inferredGoalPrompt, /Advance project/);
    const pauseGoalCommand = initializedRun.commands.get("pause-goal");
    assert.ok(pauseGoalCommand, "missing /pause-goal command");
    assert.equal(initializedRun.commands.get("pause_goal"), undefined);
    await pauseGoalCommand.handler("waiting for user", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /Spark goal paused/);

    assert.equal(initializedRun.commands.get("workflow:ready"), undefined);

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
    await workflowCommand.handler("workspace:triage Review with a workflow", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /strategy: workflow/);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /workflow: workspace:triage/);
    const workflowPrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(workflowPrompt, /Workflow selector: workspace:triage/);
    assert.match(workflowPrompt, /Selected saved workflow: workspace:triage/);
    assert.match(workflowPrompt, /Spark workflow runtime and role-run adapter boundaries/);
    assert.match(workflowPrompt, /Workflow budget:/);
    assert.match(workflowPrompt, /Token budget: none/);
    assert.match(workflowPrompt, /Tokens remaining: unbounded/);
    assert.match(workflowPrompt, /Saved workflows discovered in \.spark\/workflows\/\*\.js/);
    assert.match(workflowPrompt, /triage: Triage incidents with specialist phases/);
    assert.match(workflowPrompt, /Saved workflow validation issues/);
    assert.match(workflowPrompt, /broken\.js/);
    assert.match(workflowPrompt, /discovery never executes saved workflow bodies/);

    initializedCtx.ui.select = async () =>
      assert.fail("/workflow should not open a canned selector ask");
    await workflowCommand.handler("", initializedCtx);
    assert.match(initializedRun.customMessages.at(-1)?.content ?? "", /strategy: workflow/);
    assert.doesNotMatch(
      initializedRun.customMessages.at(-1)?.content ?? "",
      /workflow: workspace:triage/,
    );
    const autoWorkflowPrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(autoWorkflowPrompt, /No workflow selector was provided/);
    assert.match(autoWorkflowPrompt, /Agent must choose an existing saved workflow or create/);
    assert.match(autoWorkflowPrompt, /workflow\(\{ action: "list" \}\)/);
    assert.match(autoWorkflowPrompt, /\.spark\/workflows\/<name>\.js/);
    assert.doesNotMatch(autoWorkflowPrompt, /Workflow selector: workspace:triage/);
    assert.doesNotMatch(autoWorkflowPrompt, /Selected saved workflow: workspace:triage/);
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
    const inlineWorkflowPrompt = await consumeSparkModeContext(initializedRun, initializedCtx);
    assert.match(inlineWorkflowPrompt, /No workflow selector was provided/);
    assert.match(inlineWorkflowPrompt, /Agent must choose an existing saved workflow or create/);
    assert.match(inlineWorkflowPrompt, /\.spark\/workflows\/<name>\.js/);
    assert.doesNotMatch(
      inlineWorkflowPrompt,
      /\/workflow only accepts saved workspace:\/user: workflow selectors/,
    );
    assert.doesNotMatch(inlineWorkflowPrompt, /Inline workflow detected/);
    assert.doesNotMatch(inlineWorkflowPrompt, /metadata only/);

    assert.equal(initializedRun.commands.get("run"), undefined);
    assert.equal(initializedRun.commands.get("run-sequential"), undefined);
    assert.equal(initializedRun.commands.get("run-parallel"), undefined);

    const emptyCtx = testSparkContext(emptyDir, "main");
    const emptyRun = registerSparkToolsForTest();
    const emptyExecute = emptyRun.commands.get("execute");
    assert.ok(emptyExecute, "missing /execute command");
    await emptyExecute.handler("", emptyCtx);
    assert.match(emptyCtx.notifications.at(-1)?.message ?? "", /needs initialized Spark state/);
    const emptyGoalCommand = emptyRun.commands.get("goal");
    assert.ok(emptyGoalCommand, "missing /goal command");
    assert.equal(emptyRun.commands.get("workflow:goal"), undefined);
    await emptyGoalCommand.handler("", emptyCtx);
    assert.match(emptyCtx.notifications.at(-1)?.message ?? "", /no active goal/);
    assert.equal(emptyRun.customMessages.length, 1);
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
    const executeCommand = run.commands.get("execute");
    const planCommand = run.commands.get("plan");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    assert.ok(executeCommand, "missing /execute command");
    assert.ok(planCommand, "missing /plan command");

    await goalCommand.handler("work through background queue", ctx);
    await executeCommand.handler("take one task", ctx);
    await planCommand.handler("revise the failed task plan", ctx);

    const hidden = await consumeSparkModeContext(run, ctx);
    assert.match(hidden, /Enter Spark planning mode from \/plan/);
    assert.match(hidden, /revise the failed task plan/);
    assert.doesNotMatch(hidden, /Enter Spark research mode/);
    assert.doesNotMatch(hidden, /Enter Spark execution mode/);
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
          scope: "Only planning-mode task organization.",
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
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark plan mode requested/);
    const message = await consumeSparkModeContext(run, ctx);
    assert.match(message, /Roadmap planning context:/);
    assert.match(message, /Roadmap assisted planning/);
    assert.match(message, /Use roadmap item intent while planning tasks/);
    assert.match(message, /Only planning-mode task organization/);
    assert.match(message, /Roadmap item refs are visible to planning/);
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
    const projectsPath = join(dir, ".spark", "projects.json");
    const snapshot = JSON.parse(await readFile(projectsPath, "utf8")) as {
      projects: Array<{ roadmap?: { items?: unknown } }>;
    };
    snapshot.projects[0]!.roadmap!.items = "not-array";
    await writeFile(projectsPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    const planCommand = run.commands.get("plan");
    assert.ok(planCommand, "missing /plan command");

    await assert.rejects(async () => {
      await planCommand.handler("Roadmap assisted planning", ctx);
    }, /invalid project roadmap: .*\.items must be an array/);
    assert.equal(run.customMessages.length, 0);
    const currentState = await loadCurrentProjectState(dir, ctx);
    assert.equal(currentState?.planningMode, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks maps active roadmap item hints into task plans and attaches refs", async () => {
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

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks writes directly whenever durable planning is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-any-mode-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools, commands } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const noMode = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

    const executeCommand = commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("Do one task", ctx);
    const duringExecute = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks writes directly without approval UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-direct-write-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = undefined as never;
    ctx.ui.input = undefined as never;
    ctx.ui.custom = undefined;
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks blocks mixed readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-readiness-mixed-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await readFile(join(dir, ".spark", "projects.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
    assert.equal(details?.dryRun, undefined);
    assert.equal(details?.error, "task_plan_not_ready");
    assert.equal(details?.result?.created?.length, 2);
    assert.equal(details?.planDecisions?.[0]?.accepted, true);
    assert.equal(details?.planDecisions?.[1]?.blocked, true);
    assert.equal(await readFile(join(dir, ".spark", "projects.json"), "utf8"), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_plan_tasks reports all-rejected readiness without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-plan-rejected-"));
  try {
    await writeEmptySparkProject(dir);
    const before = await readFile(join(dir, ".spark", "projects.json"), "utf8");
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("readiness validation should not open a task-plan ask");
    ctx.ui.custom = async () =>
      assert.fail("readiness validation should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
    assert.equal(await readFile(join(dir, ".spark", "projects.json"), "utf8"), before);
    assert.equal((await defaultTaskGraphStore(dir).load())?.tasks().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("/execute stops after one task and only hints the next ready task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-execute-one-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    await defaultTaskGraphStore(dir).update(async (graph) => {
      const project = graph.projects()[0];
      assert.ok(project);
      await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
      await writeFile(
        join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`),
        JSON.stringify({ projectRef: project.ref }, null, 2),
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
    const executeCommand = run.commands.get("execute");
    assert.ok(executeCommand, "missing /execute command");
    await executeCommand.handler("work through the ready queue", ctx);
    const executePrompt = await consumeSparkModeContext(run, ctx);
    assert.match(executePrompt, /Claim at most one concrete task/);
    assert.match(executePrompt, /Stop after that task finishes/);
    assert.doesNotMatch(executePrompt, /continue through ready tasks until blocked/i);
    assert.doesNotMatch(executePrompt, /auto-claiming or dispatching the next ready task/i);

    await executeSparkTool(run.tools, "spark_claim_task", ctx, {
      name: "first-ready",
      title: "First ready task",
      description: "First ready task",
      status: "running",
      todos: ["Finish first ready task"],
    });
    await executeSparkTool(run.tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Finish first ready task" }],
    });
    const finished = await executeSparkTool(run.tools, "spark_finish_task", ctx, {
      summary: "Finished first ready task.",
    });

    const text = finished.content.map((item) => item.text).join("\n");
    assert.match(text, /Execution mode stopped after one task/);
    assert.match(text, /Next ready task: @second-ready/);
    assert.match(text, /Run \/execute to take one more step, or \/goal to continue autonomously/);
    assert.doesNotMatch(text, /auto-claimed next ready task/);
    assert.equal((finished.details as { autoClaimedTask?: unknown }).autoClaimedTask, undefined);
    assert.ok((finished.details as { nextReadyTask?: unknown }).nextReadyTask);
    assert.equal(await tryConsumeSparkModeContext(run, ctx), undefined);

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
      await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
      await writeFile(
        join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`),
        JSON.stringify({ projectRef: project.ref }, null, 2),
        "utf8",
      );
    });

    const run = registerSparkToolsForTest();
    const goalCommand = run.commands.get("goal");
    assert.ok(goalCommand, "missing /goal command");
    assert.equal(run.commands.get("workflow:goal"), undefined);
    await goalCommand.handler("work through the ready queue until done", ctx);
    const goalPrompt = await consumeSparkModeContext(run, ctx);
    assert.match(goalPrompt, /Spark session goal is active/);
    assert.match(goalPrompt, /goal completion is reviewer-owned/);
    assert.doesNotMatch(goalPrompt, /goal\(\{ action: "complete" \}\).*concise verified reason/);
    assert.doesNotMatch(goalPrompt, /Enter Spark execution mode/);
    assert.doesNotMatch(run.customMessages.at(-1)?.content ?? "", /strategy: goal/);
    assert.doesNotMatch(run.customMessages.at(-1)?.content ?? "", /workflow: builtin:goal/);
    const goalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as {
      goal?: { objective?: string; status?: string };
    };
    assert.equal(goalState.goal?.objective, "work through the ready queue until done");
    assert.equal(goalState.goal?.status, "active");

    const sessionState = JSON.parse(
      await readFile(join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`), "utf8"),
    ) as { executionMode?: unknown; runMode?: unknown };
    assert.equal(sessionState.executionMode, undefined);
    assert.equal(sessionState.runMode, undefined);
    assert.match(goalPrompt, /foreground goal loop/);
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
    assert.match(ctx.notifications.at(-1)?.message ?? "", /no active goal/);
    assert.match(run.customMessages.at(-1)?.content ?? "", /infer it now/);
    const prompt = await consumeSparkModeContext(run, ctx);
    assert.match(prompt, /Spark session goal is not set/);
    assert.match(prompt, /goal\(\{ action: "set"/);
    assert.doesNotMatch(prompt, /Unfinished tasks: \d+\. Ready tasks: \d+/);
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
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark goal continuing/);
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    const goalPrompt = await consumeSparkModeContext(run, ctx);
    assert.match(goalPrompt, /Spark foreground goal loop tick/);
    assert.match(goalPrompt, /finish the original queue/);
    assert.doesNotMatch(goalPrompt, /replace with a different goal/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal handles stale inferred project goals after the project is done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-stale-done-project-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Done goal project",
      description: "Already finished project.",
      status: "done",
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
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Cleared stale Spark goal/);
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
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /replaced a stale completed-project goal/,
    );
    const goalPrompt = await consumeSparkModeContext(run, ctx);
    assert.match(goalPrompt, /Spark session goal is active/);
    assert.match(goalPrompt, /review 全盘代码进行改进/);
    assert.doesNotMatch(goalPrompt, /Unfinished tasks: 3/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("session reset shutdown auto-pauses active foreground goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-shutdown-pause-"));
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

    const paused = await loadSessionGoal(dir, ctx);
    assert.equal(paused?.status, "paused");
    assert.match(paused?.pauseReason ?? "", /Auto-paused before session reload/);
    assert.ok(timers.every((timer) => timer.cleared));

    await goalCommand.handler("survive until revert", ctx);
    assert.equal((await loadSessionGoal(dir, ctx))?.status, "active");
    for (const handler of run.eventHandlers.get("session_shutdown") ?? []) {
      await handler({ reason: "revert" }, ctx);
    }
    const revertPaused = await loadSessionGoal(dir, ctx);
    assert.equal(revertPaused?.status, "paused");
    assert.match(revertPaused?.pauseReason ?? "", /Auto-paused before session revert/);

    const reloadedRun = registerSparkToolsForTest();
    const before = timers.length;
    for (const handler of reloadedRun.eventHandlers.get("session_start") ?? []) {
      await handler({ reason: "reload" }, ctx);
    }
    assert.equal(timers.length, before, "paused goals must not reschedule after reload");
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
    assert.match(restartedRun.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    assert.equal(restartedRun.customMessages.at(-1)?.display, false);
    assert.equal(restartedRun.customMessages.at(-1)?.options?.deliverAs, "followUp");
    const tickPrompt = await consumeSparkModeContext(restartedRun, ctx);
    assert.match(tickPrompt, /Spark foreground goal loop tick/);
    assert.match(tickPrompt, /reviewer-owned/i);
    assert.doesNotMatch(tickPrompt, /call goal\(\{ action: "complete" \}\)/);
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
    assert.equal(
      run.customMessages.some((message) => /Spark goal tick/.test(message.content)),
      false,
    );

    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }

    assert.equal(timers.length, 2, "ordinary completed turns re-arm idle goal ticks");
    assert.equal(timers[1]?.delay, 30_000);
    assert.equal(
      run.customMessages.some((message) => /Spark goal tick/.test(message.content)),
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
      objective: "Drop stale tick after pause",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    timers[0]?.callback();
    await flushAsyncWork();
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      reason: "stop before hidden tick context is consumed",
    });

    assert.equal(await tryConsumeSparkModeContext(run, ctx), undefined);
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
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.lastReview?.achieved, true);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop includes completed project evidence after current project clears", async () => {
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
      kind: "review",
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
      graph.updateProject(project.ref, { status: "done" });
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
    assert.equal(reviewerInput?.projectRef, completedProjectRef);
    assert.equal(reviewerInput?.projectStatus?.taskCounts.total, 1);
    assert.equal(reviewerInput?.projectStatus?.taskCounts.unfinished, 0);
    assert.deepEqual(reviewerInput?.evidenceRefs, [evidence.ref]);
    const reviewArtifact = await defaultArtifactStore(dir).get(
      (await defaultArtifactStore(dir).list({ kind: "review" })).at(-1)!.ref,
    );
    const reviewBody = reviewArtifact.body as {
      reviewPacket?: { projectRef?: ProjectRef; evidenceRefs?: string[] };
    };
    assert.equal(reviewBody.reviewPacket?.projectRef, completedProjectRef);
    assert.deepEqual(reviewBody.reviewPacket?.evidenceRefs, [evidence.ref]);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
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
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.lastReview?.achieved, false);
    assert.match(goal?.lastReview?.remainingWork ?? "", /goal needs one more verified task/);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("/goal foreground loop lets reviewer decide despite active session TODOs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-loop-session-todo-blocker-"));
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
    await saveIndependentTodos(dir, ctx, [
      { id: "todo-1", content: "Resolve session blocker", status: "pending" },
    ]);
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
      objective: "Finish only after session TODOs clear",
    });
    for (const handler of run.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    const messagesBefore = run.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();

    assert.equal(reviewerCalls, 1);
    assert.equal(run.customMessages.length, messagesBefore);
    const goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.lastReview?.achieved, true);
    assert.doesNotMatch(goal?.lastReview?.reason ?? "", /active session TODO/);
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 1);
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
    await executeSparkTool(run.tools, "spark_claim_task", ctx, {
      name: "finish-review-lease",
      title: "Finish review lease",
      description: "Task finish reviewer should hold the shared reviewer lease.",
      plan: executionReadyPlan("Finish review lease"),
      todos: ["Run finish review reviewer flow"],
    });
    await executeSparkTool(run.tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Run finish review reviewer flow" }],
    });

    const finishPromise = executeSparkTool(run.tools, "spark_finish_task", ctx, {
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

void test("goal reviewer state machine covers scope conflict, restart, idle review, and task finish gates", async () => {
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
  async function flushAsyncWork(): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
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
      scope: "session",
    });
    assert.match(toolText(sessionStarted), /Spark session goal active/);

    const projectConflict = await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Project goal should conflict until session pauses",
      scope: "project",
    });
    assert.equal((projectConflict.details as { error?: string }).error, "active_goal_conflict");

    await executeSparkTool(run.tools, "goal", ctx, {
      action: "pause",
      scope: "session",
      reason: "switch to project",
    });
    const projectStarted = await executeSparkTool(run.tools, "goal", ctx, {
      action: "start",
      objective: "Project goal for state-machine e2e",
      scope: "project",
    });
    assert.equal(
      (projectStarted.details as { goal?: { scope?: string } } | undefined)?.goal?.scope,
      "project",
    );

    const restarted = registerSparkToolsForTest({ reviewerRunner });
    for (const handler of restarted.eventHandlers.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.delay, 30_000);

    const messagesBeforeUnmet = restarted.customMessages.length;
    timers[0]?.callback();
    await flushAsyncWork();
    assert.equal(goalReviewerCalls, 1);
    assert.ok(restarted.customMessages.length > messagesBeforeUnmet);
    assert.equal(restarted.customMessages.at(-1)?.display, false);
    assert.equal(restarted.customMessages.at(-1)?.options?.deliverAs, "followUp");
    let goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.lastReview?.achieved, false);
    assert.match(goal?.lastReview?.remainingWork ?? "", /project goal still needs one task/);

    for (const handler of restarted.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    assert.equal(timers.length, 2);
    const messagesBeforeAchieved = restarted.customMessages.length;
    timers[1]?.callback();
    await flushAsyncWork();
    assert.equal(goalReviewerCalls, 2);
    assert.equal(restarted.customMessages.length, messagesBeforeAchieved);
    goal = await loadSessionGoal(dir, ctx);
    assert.equal(goal?.status, "complete");
    assert.equal(goal?.lastReview?.achieved, true);

    await executeSparkTool(run.tools, "spark_claim_task", ctx, {
      name: "e2e-task-finish-gate",
      title: "E2E task finish gate",
      description: "Task finish should reject then approve through the reviewer gate.",
      plan: executionReadyPlan("E2E task finish gate"),
      todos: ["Validate task finish reviewer gate"],
    });
    await executeSparkTool(run.tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Validate task finish reviewer gate" }],
    });
    const rejected = await executeSparkTool(run.tools, "spark_finish_task", ctx, {
      summary: "First finish attempt should be rejected.",
    });
    assert.equal((rejected.details as { error?: string }).error, "task_review_failed");
    assert.match(toolText(rejected), /task finish needs revision/);

    rejectTaskFinish = false;
    const finished = await executeSparkTool(run.tools, "spark_finish_task", ctx, {
      summary: "Second finish attempt is approved.",
    });
    assert.match(toolText(finished), /Finished Spark task: \[done\]/);
    assert.equal((finished.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal(taskReviewerCalls, 2);

    const reviews = await defaultArtifactStore(dir).list({ kind: "review" });
    assert.equal(
      reviews.length,
      5,
      "pause review, two goal reviews, and two task finish reviews are persisted",
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

    const failedGoalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as {
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

    const abortedGoalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as {
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
    const retryGoalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as { goal?: { retryState?: { consecutiveFailures?: number } } };
    assert.equal(retryGoalState.goal?.retryState?.consecutiveFailures, 1);

    timers[1]?.callback();
    await flushAsyncWork();
    for (const handler of run.eventHandlers.get("agent_end") ?? []) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    const resetGoalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as { goal?: { status?: string; retryState?: unknown } };
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
    const pauseGoalCommand = run.commands.get("pause-goal");
    assert.ok(goalCommand, "missing /goal command");
    assert.ok(pauseGoalCommand, "missing /pause-goal command");
    assert.equal(run.commands.get("pause_goal"), undefined);

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
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    assert.match(await consumeSparkModeContext(run, ctx), /Spark foreground goal loop tick/);
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

    await pauseGoalCommand.handler("waiting for review", ctx);
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
    assert.match(run.customMessages.at(-1)?.content ?? "", /Spark goal tick/);
    assert.equal(run.customMessages.at(-1)?.display, false);
    assert.equal(run.customMessages.at(-1)?.options?.deliverAs, "followUp");
    assert.match(await consumeSparkModeContext(run, ctx), /Spark foreground goal loop tick/);
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
    const failedGoalState = JSON.parse(
      await readFile(
        join(dir, ".spark", "session-goals", `${ctxSessionStoreScope(ctx)}.json`),
        "utf8",
      ),
    ) as { goal?: { status?: string; lastReview?: { reason?: string; blockers?: string[] } } };
    assert.equal(failedGoalState.goal?.status, "active");
    assert.match(
      failedGoalState.goal?.lastReview?.reason ?? "",
      /Context overflow recovery failed: invalidated oauth token/,
    );
    assert.match(
      failedGoalState.goal?.lastReview?.blockers?.join("\n") ?? "",
      /Context overflow recovery failed: invalidated oauth token/,
    );
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

void test("Shift+Tab shortcut cycles Spark mode when Spark is active", async () => {
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

    await executeSparkTool(run.tools, "spark_use_project", ctx, { project: "Tool persistence" });
    await shortcut.handler(ctx);
    assert.equal((await loadSparkMode(dir, ctx)).mode, "research");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark mode: research/);

    await shortcut.handler(ctx);
    const planMode = await loadSparkMode(dir, ctx);
    assert.equal(planMode.mode, "plan");
    assert.equal(planMode.planningSource, "direct");

    await shortcut.handler(ctx);
    const executeMode = await loadSparkMode(dir, ctx);
    assert.equal(executeMode.mode, "execute");
    assert.equal(executeMode.executeStrategy, "default");

    await shortcut.handler(ctx);
    assert.equal((await loadSparkMode(dir, ctx)).mode, "auto");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    await rm(inactiveDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_plan_tasks blocks underspecified executable tasks without opening a canned ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-plan-not-ready-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    ctx.ui.select = async () => assert.fail("spark_plan_tasks should not open a task-plan ask");
    ctx.ui.custom = async () => assert.fail("spark_plan_tasks should not open fullscreen ask UI");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks rejects standalone design/planning tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-not-concrete-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "background-role-results-design",
          title: "设计 DAG 子 agent 完成结果的用户/父 agent 可见机制",
          description: "Decide how background child role-run results should be visible.",
          kind: "plan",
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

void test("spark_plan_tasks rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
      /kind must be research, plan, implement, review, ask, cue, interaction, or generic/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-invalid-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
        executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_plan_tasks accepts cancelled cleanup tasks without success/evidence readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-cancelled-plan-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
      tasks: [
        {
          name: "retire-placeholder",
          title: "Retire placeholder task",
          description:
            "Historical placeholder that should be cancelled without execution evidence.",
          kind: "interaction",
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

void test("spark_plan_tasks refuses to cancel tasks that still have dependents", async () => {
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
    const before = await readFile(join(dir, ".spark", "projects.json"), "utf8");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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
    assert.equal(await readFile(join(dir, ".spark", "projects.json"), "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task accepts a task plan patch without explicit /plan mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-no-mode-gate-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const claimed = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "claim-plan-patch",
      title: "Claim with plan patch",
      description: "A claim-time plan patch can be saved without explicit /plan mode.",
      kind: "implement",
      plan: executionReadyPlan("A claim-time plan patch can be saved without explicit /plan mode."),
      todos: ["Apply the plan and capture evidence."],
    });

    assert.match(toolText(claimed), /Claimed Spark task/);
    const task = (await defaultTaskGraphStore(dir).load())?.tasks()[0];
    assert.equal(task?.name, "claim-plan-patch");
    assert.equal(
      task?.plan?.objective,
      "A claim-time plan patch can be saved without explicit /plan mode.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task renders plan summary and task TODO hint in claim text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-claim-plan-output-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "claim-plan-output",
      title: "Claim plan output",
      description: "Claim output should surface the plan.",
      kind: "implement",
      plan: {
        ...executionReadyPlan("Surface the claim plan summary."),
        constraints: ["Keep output compact", "Do not remove details.task"],
        successCriteria: ["The text includes success criteria"],
        evidenceRequired: ["Focused test proves plan fields are rendered"],
        steps: ["Render the plan", "Prompt for task TODOs"],
      },
      todos: ["Render the plan", "Prompt for task TODOs"],
    });

    const text = toolText(claim);
    assert.match(text, /Claimed Spark task: @claim-plan-output/);
    assert.match(text, /Plan:/);
    assert.match(text, /objective: Surface the claim plan summary/);
    assert.match(text, /successCriteria: The text includes success criteria/);
    assert.match(text, /evidenceRequired: Focused test proves plan fields are rendered/);
    assert.match(text, /steps: Render the plan; Prompt for task TODOs/);
    assert.match(text, /constraints: Keep output compact; Do not remove details\.task/);
    assert.match(text, /Initial task TODOs are present for this claim/);
    assert.match(text, /task\(\{ action: "todo_update", scope: "task"/);
    assert.ok((claim.details as { task?: unknown } | undefined)?.task);
    const todoFile = sessionTaskTodoPath(dir, ctx);
    const afterClaim = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.deepEqual(
      afterClaim.todos.map((todo) => [todo.content, todo.status]),
      [
        ["Render the plan", "in_progress"],
        ["Prompt for task TODOs", "pending"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task requires a task plan instead of asking at claim time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-claim-no-plan-ask-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "claim-plan",
      title: "Claim underspecified plan",
      description: "Claiming should not ask for task plan refinement.",
      kind: "implement",
    });

    assert.match(toolText(claim), /Cannot claim Claim underspecified plan/);
    assert.match(toolText(claim), /task\.plan is not allowed/);
    assert.equal((claim.details as { error?: string }).error, "task_plan_required");
    assert.equal((await defaultArtifactStore(dir).list({ kind: "ask-answer" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task and spark_update_task_todos persist task TODOs across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-task-todos-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "persist-todos",
      title: "Persist task TODOs",
      description: "Exercise task-scoped TODO persistence through Spark tools.",
      kind: "implement",
      plan: executionReadyPlan("Exercise task-scoped TODO persistence through Spark tools."),
      todos: ["Read sources", "Run focused tests"],
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

    const todoFile = sessionTaskTodoPath(dir, ctx);
    const afterClaim = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.equal(afterClaim.version, 1);
    assert.equal(afterClaim.todos.length, 2);
    assert.deepEqual(
      afterClaim.todos.map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "in_progress"],
        ["Run focused tests", "pending"],
      ],
    );
    assert.doesNotMatch(
      await readFile(join(dir, ".spark", "projects.json"), "utf8"),
      /Read sources/,
    );

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [
        { op: "done", item: "Read sources" },
        { op: "append", items: ["Check reload"] },
        { op: "note", item: "Run focused tests", text: "Persisted after reload" },
      ],
    });

    const afterUpdate = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.deepEqual(
      afterUpdate.todos.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Read sources", "done", []],
        ["Run focused tests", "in_progress", ["Persisted after reload"]],
        ["Check reload", "pending", []],
      ],
    );

    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.ok(reloadedGraph);
    await defaultTaskTodoStore(dir, ctxSessionKey(ctx)).hydrate(reloadedGraph);
    assert.deepEqual(
      reloadedGraph.taskTodos(claimedTask.ref).map((todo) => [todo.content, todo.status]),
      [
        ["Read sources", "done"],
        ["Run focused tests", "in_progress"],
        ["Check reload", "pending"],
      ],
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "spark_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Persist task TODOs/);
    assert.match(statusText, /\[done\].*Read sources/);
    assert.match(statusText, /\[in_progress\].*Run focused tests/);
    assert.match(statusText, /\[pending\].*Check reload/);
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
    await executeSparkTool(tools, "spark_use_project", ctx, { project: project.ref });

    const renamedProject = await executeSparkTool(tools, "spark_rename_project", ctx, {
      title: "Autonomous Spark naming quality",
      description: "Improve obvious placeholder Spark display names.",
    });
    const renamedProjectDetails = renamedProject.details?.project as
      | { ref?: ProjectRef; title?: string; status?: string }
      | undefined;
    assert.equal(renamedProjectDetails?.ref, project.ref);
    assert.equal(renamedProjectDetails?.title, "Autonomous Spark naming quality");
    assert.equal(renamedProjectDetails?.status, "active");

    const doneProject = await executeSparkTool(tools, "spark_rename_project", ctx, {
      project: project.ref,
      status: "done",
    });
    const doneProjectDetails = doneProject.details?.project as
      | { ref?: ProjectRef; title?: string; status?: string }
      | undefined;
    assert.equal(doneProjectDetails?.status, "done");

    await executeSparkTool(tools, "spark_rename_project", ctx, {
      project: project.ref,
      status: "active",
    });
    await executeSparkTool(tools, "spark_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement safe naming",
      description: "Update generic task display names while preserving stable refs.",
      kind: "implement",
      plan: executionReadyPlan("Update generic task display names while preserving stable refs."),
      todos: ["Confirm rename and verify task ref"],
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
    assert.equal(loaded.getProject(project.ref).status, "active");
    assert.equal(loaded.getTask(generic.ref).name, "implement-safe-naming-2");
    assert.equal(loaded.getTask(existing.ref).name, "implement-safe-naming");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task preserves intentional task names when only the title improves", async () => {
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
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "spark_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement editor diagnostics slice",
      description: "Narrow the active Hypha work without replacing the intentional handle.",
      kind: "implement",
      plan: executionReadyPlan(
        "Narrow the active Hypha work without replacing the intentional handle.",
      ),
      todos: ["Verify rename keeps intentional name and updates title"],
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

void test("spark_claim_task creates a new task when multiple generic rename candidates are ambiguous", async () => {
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
    await executeSparkTool(tools, "spark_use_project", ctx, { project: project.ref });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      title: "Implement concrete naming policy test",
      description:
        "No existing task can be chosen without guessing because multiple generic tasks are present.",
      kind: "implement",
      plan: executionReadyPlan(
        "No existing task can be chosen without guessing because multiple generic tasks are present.",
      ),
      todos: ["Verify a new task is created when generic names are ambiguous"],
    });
    const claimedTask = claim.details?.task as
      | { ref?: TaskRef; name?: string; title?: string }
      | undefined;
    assert.ok(claimedTask?.ref);
    assert.notEqual(claimedTask.ref, first.ref);
    assert.notEqual(claimedTask.ref, second.ref);
    assert.equal(claimedTask.name, "implement-concrete-naming-policy-test");

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(first.ref).name, "task-deadbeefcafebabe");
    assert.equal(loaded.getTask(second.ref).name, "capture-project-intent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_claim_task rejects terminal statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-terminal-claim-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "spark_claim_task", ctx, {
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

void test("spark_claim_task rejects invalid explicit kind and status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-kind-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
          title: "Invalid claim kind",
          description: "Invalid kind must not become interaction.",
          kind: "build",
        }),
      /kind must be research, plan, implement, review, ask, cue, interaction, or generic/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
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

void test("spark_claim_task rejects invalid explicit task shapes without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-invalid-claim-shape-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
          title: 42,
          description: "Invalid title must not be trusted.",
        }),
      /title must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
          title: "Invalid todos",
          description: "Invalid TODO shape must not be trusted.",
          todos: [123],
        }),
      /todos must be an array of strings/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
          title: "Invalid risk",
          description: "Invalid plan risk must not be downgraded to normal.",
          plan: { ...executionReadyPlan("Reject invalid risk."), riskLevel: "urgent" },
        }),
      /plan\.riskLevel must be trivial, normal, or high/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_claim_task", ctx, {
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

void test("spark_finish_task completes this session's claimed task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-task-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-me",
      title: "Finish me",
      description: "Exercise task lifecycle completion.",
      plan: executionReadyPlan("Finish me"),
      todos: ["Run focused finish lifecycle test"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(finished), /Task finish blocked by open task TODOs/);
    assert.equal((finished.details as { error?: string } | undefined)?.error, "open_task_todos");

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Run focused finish lifecycle test" }],
    });
    const completed = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Done for test.",
    });
    assert.match(toolText(completed), /Finished Spark task: \[done\] @finish-me: Finish me/);
    assert.match(
      toolText(completed),
      /Completion evidence warning: Task completion needs evidence artifacts/,
    );
    assert.match(toolText(completed), /Learning candidate: artifact:/);
    assert.equal((completed.details?.task as { status?: string } | undefined)?.status, "done");
    assert.equal(
      (completed.details?.completionReadiness as { ready?: boolean } | undefined)?.ready,
      false,
    );
    assert.equal(
      (completed.details?.learningCandidate as { status?: string } | undefined)?.status,
      "candidate",
    );
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.ok(loaded);
    assert.equal(loaded.getTask(taskRef).status, "done");
    assert.equal(loaded.getTask(taskRef).claim, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task attaches evidenceRefs before reviewer gate", async () => {
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
      kind: "review",
      title: "Focused validation evidence",
      format: "markdown",
      body: "Targeted tests passed.",
      provenance: { producer: "task" },
    });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-evidence",
      title: "Finish with evidence",
      description: "Finish should pass explicit evidence refs to reviewer.",
      plan: executionReadyPlan("Finish with evidence"),
      todos: ["Attach evidence and finish task"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Attach evidence and finish task" }],
    });

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Validated with attached evidence.",
      evidenceRefs: [evidence.ref],
    });

    assert.match(toolText(finished), /Finished Spark task: \[done\] @finish-evidence/);
    assert.deepEqual(reviewerEvidenceRefs, [evidence.ref]);
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

void test("spark_finish_task does not persist evidenceRefs when follow-up gate blocks", async () => {
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
      kind: "review",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a follow-up before this research can close.",
      provenance: { producer: "task" },
    });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-evidence-followup-block",
      title: "Finish evidence follow-up block",
      description: "Blocked follow-up checks must not persist explicit finish evidence.",
      kind: "research",
      plan: executionReadyPlan("Finish evidence follow-up block"),
      todos: ["Validate follow-up gate blocks before evidence persistence"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Validate follow-up gate blocks before evidence persistence" }],
    });

    const blocked = await executeSparkTool(tools, "spark_finish_task", ctx, {
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

void test("spark_finish_task keeps task unfinished when reviewer rejects done transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-review-reject-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest({
      reviewerRunner: createRejectingReviewerRunner("reviewer requires focused validation"),
    });
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-review-reject",
      title: "Finish review reject",
      description: "Reviewer rejection must keep this task unfinished.",
      plan: executionReadyPlan("Finish review reject"),
      todos: ["Validate reviewer rejection keeps task unfinished"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Validate reviewer rejection keeps task unfinished" }],
    });

    const rejected = await executeSparkTool(tools, "spark_finish_task", ctx, {
      summary: "Pretend complete without validation.",
    });

    assert.match(toolText(rejected), /Task finish blocked by reviewer/);
    assert.match(toolText(rejected), /reviewer requires focused validation/);
    assert.match(toolText(rejected), /The task was not marked done/);
    assert.equal((rejected.details as { error?: string }).error, "task_review_failed");
    assert.equal((rejected.details?.task as { status?: string } | undefined)?.status, "running");
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
    const reviewArtifacts = await defaultArtifactStore(dir).list({ kind: "review" });
    assert.equal(reviewArtifacts.length, 1);
    assert.equal(reviewArtifacts[0]?.provenance.producer, "review");
    assert.equal(reviewArtifacts[0]?.provenance.taskRef, taskRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task treats malformed reviewer verdict as blocking feedback", async () => {
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

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-review-malformed",
      title: "Finish review malformed",
      description: "Malformed reviewer output must block completion transparently.",
      plan: executionReadyPlan("Finish review malformed"),
      todos: ["Verify malformed reviewer output blocks finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Verify malformed reviewer output blocks finish" }],
    });

    const blocked = await executeSparkTool(tools, "spark_finish_task", ctx, {
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
    const reviewArtifacts = await defaultArtifactStore(dir).list({ kind: "review" });
    assert.equal(reviewArtifacts.length, 1);
    assert.equal(reviewArtifacts[0]?.provenance.producer, "review");
    assert.equal(reviewArtifacts[0]?.provenance.taskRef, taskRef);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task blocks research follow-ups without explicit disposition", async () => {
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

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-research-followup-block",
      title: "Finish research follow-up block",
      description: "Research outputs with orphan follow-ups must not be marked done.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up block"),
      todos: ["Verify orphan follow-ups block research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    const blocked = await executeSparkTool(tools, "spark_finish_task", ctx, {
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
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 0);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task accepts summary disposition for artifact follow-ups", async () => {
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
      kind: "review",
      title: "Follow-up evidence",
      format: "markdown",
      body: "TODO: create a separate follow-up.",
      provenance: { producer: "task" },
    });

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-artifact-followup-disposition",
      title: "Finish artifact follow-up disposition",
      description: "Summary disposition may explicitly cover artifact follow-up signals.",
      kind: "research",
      plan: executionReadyPlan("Finish artifact follow-up disposition"),
      todos: ["Validate artifact follow-up disposition"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Validate artifact follow-up disposition" }],
    });

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
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

void test("spark_finish_task completes research when follow-ups are dispositioned", async () => {
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

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-research-followup-pass",
      title: "Finish research follow-up pass",
      description: "Research outputs with dispositioned follow-ups may complete.",
      kind: "research",
      plan: executionReadyPlan("Finish research follow-up pass"),
      todos: ["Verify dispositioned follow-ups allow research finish"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await executeSparkTool(tools, "spark_update_task_todos", ctx, {
      ops: [{ op: "done", item: "Verify dispositioned follow-ups allow research finish" }],
    });

    const finished = await executeSparkTool(tools, "spark_finish_task", ctx, {
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
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 1);
    assert.equal((await defaultLearningStore(dir).list({ includeCandidates: true })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_finish_task rejects invalid explicit parameters without changing status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-finish-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "finish-invalid",
      title: "Finish invalid",
      description: "Invalid finish parameters must not alter task state.",
      plan: executionReadyPlan("Reject invalid finish parameters."),
      todos: ["Validate finish parameters"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () => executeSparkTool(tools, "spark_finish_task", ctx, { status: "cancel" }),
      /status must be done, failed, or cancelled/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_finish_task", ctx, { summary: 42 }),
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

void test("spark_finish_task refuses to cancel a claimed prerequisite with dependents", async () => {
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

    const cancelled = await executeSparkTool(tools, "spark_finish_task", ctx, {
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

void test("task tool dispatches canonical project, plan, claim, TODO, and finish actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-tool-canonical-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    assert.ok(tools.has("task"), "missing canonical task tool");

    const created = await executeSparkTool(tools, "task", ctx, {
      action: "project_use",
      title: "Canonical task tool project",
      description: "Exercise the canonical task action tool.",
    });
    assert.match(toolText(created), /Created new Spark project/);

    const planned = await executeSparkTool(tools, "task", ctx, {
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

    const claimed = await executeSparkTool(tools, "task", ctx, {
      action: "claim",
      name: "canonical-task-tool",
      title: "Canonical task tool",
      description: "Exercise task action routing.",
      todos: ["Validate canonical task action routing"],
    });
    assert.match(toolText(claimed), /Claimed Spark task/);

    const todos = await executeSparkTool(tools, "task", ctx, {
      action: "todo_update",
      scope: "task",
      ops: [
        { op: "append", items: ["Validate canonical task routing"] },
        { op: "done", item: "Validate canonical task action routing" },
        { op: "done", item: "Validate canonical task routing" },
      ],
    });
    assert.match(toolText(todos), /Updated TODOs/);

    const finished = await executeSparkTool(tools, "task", ctx, {
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
    assert.match(toolText(contextPreview), /Spark active state/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("artifact tool lists and reads artifacts with truncated default body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-artifacts-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const artifact = await defaultArtifactStore(dir).put({
      kind: "research",
      title: "Long research note",
      format: "text",
      body: "abcdef".repeat(20_000),
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    const listed = await executeSparkTool(tools, "artifact", ctx, {
      action: "list",
      kind: "research",
    });
    assert.match(toolText(listed), new RegExp(`${artifact.ref}.*Long research note`));
    const [listedArtifact] =
      (listed.details as { artifacts?: Array<{ bodyTruncated?: boolean; links?: unknown[] }> })
        .artifacts ?? [];
    assert.equal((listed.details as { view?: string }).view, "summary");
    assert.equal(listedArtifact?.bodyTruncated, true);
    assert.equal(listedArtifact?.links, undefined);

    const refOnly = await executeSparkTool(tools, "artifact", ctx, {
      action: "list",
      kind: "research",
      view: "ref-only",
    });
    assert.match(toolText(refOnly), new RegExp(`- ${artifact.ref}`));
    assert.doesNotMatch(toolText(refOnly), /Long research note/);
    assert.equal((refOnly.details as { view?: string }).view, "ref-only");

    const fullList = await executeSparkTool(tools, "artifact", ctx, {
      action: "list",
      kind: "research",
      view: "full",
    });
    assert.match(toolText(fullList), /producer=spark/);
    const [fullListedArtifact] =
      (fullList.details as { artifacts?: Array<{ links?: unknown[] }> }).artifacts ?? [];
    assert.ok(Array.isArray(fullListedArtifact?.links));

    const defaultRead = await executeSparkTool(tools, "artifact", ctx, {
      action: "read",
      artifactRef: artifact.ref,
    });
    assert.match(toolText(defaultRead), /truncated/);
    assert.ok(
      ((defaultRead.details as { shownChars?: number }).shownChars ?? 0) <
        "abcdef".repeat(20_000).length,
    );
    assert.ok(((defaultRead.details as { shownChars?: number }).shownChars ?? 0) < 1_600);

    const read = await executeSparkTool(tools, "artifact", ctx, {
      action: "read",
      artifactRef: artifact.ref,
      maxChars: 40,
    });
    assert.match(toolText(read), /Long research note/);
    assert.match(toolText(read), /truncated/);
    assert.equal((read.details as { truncated?: boolean }).truncated, true);

    const fullRead = await executeSparkTool(tools, "artifact", ctx, {
      action: "read",
      artifactRef: artifact.ref,
      full: true,
    });
    assert.equal((fullRead.details as { truncated?: boolean }).truncated, false);
    assert.equal(
      (fullRead.details as { shownChars?: number }).shownChars,
      "abcdef".repeat(20_000).length,
    );
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
      kind: "research",
      title: "Boundary note",
      format: "text",
      body: "artifact body",
      provenance: { producer: "spark" },
    });
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", kind: "note" }),
      /kind must be a valid artifact kind; valid values: .*research.*plan.*learning-export; received: note/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "artifact", ctx, { action: "list", producer: "agent" }),
      /producer must be a valid artifact producer; valid values: spark, role, task, review, ask, cue, user; received: agent.*producer=role.*producer=task/,
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
      /kind must be a valid artifact kind; valid values: .*research.*plan.*received: plan-draft.*kind=research/,
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
      () =>
        executeSparkTool(tools, "artifact", ctx, {
          action: "read",
          artifactRef: artifact.ref,
          full: "true",
        }),
      /full must be a boolean/,
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

void test("learning tool records, searches, exports, and imports learnings", async () => {
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

    const search = await executeSparkTool(tools, "learning", ctx, {
      action: "search",
      query: "explicit Markdown exports",
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
    });
    assert.match(toolText(exported), /Exported 1 learning/);
    assert.match(await readFile(join(dir, exportPath), "utf8"), /```json spark-learning/);

    const dryRun = await executeSparkTool(tools, "learning", importCtx, {
      action: "import_markdown",
      inputPath: join(dir, exportPath),
    });
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((await defaultLearningStore(importDir).list()).length, 0);

    const imported = await executeSparkTool(tools, "learning", importCtx, {
      action: "import_markdown",
      inputPath: join(dir, exportPath),
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);
    assert.equal((await defaultLearningStore(importDir).list()).length, 1);
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
        executeSparkTool(tools, "spark_learning_record", ctx, {
          title: "Invalid category",
          statement: "This category should not be accepted.",
          category: "lesson",
        }),
      /category must be pattern/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_record", ctx, {
          title: "Invalid confidence",
          statement: "Confidence should stay normalized.",
          confidence: 2,
        }),
      /confidence must be a finite number between 0 and 1/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_search", ctx, {
          query: "anything",
          includeCandidates: "true",
        }),
      /includeCandidates must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_list", ctx, {
          status: ["active", "archived"],
        }),
      /status must be candidate/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_read", ctx, {
          ref: "artifact:missing",
          full: "true",
        }),
      /full must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_export_markdown", ctx, {
          includeInactive: "false",
        }),
      /includeInactive must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
          inputPath: ".learnings",
          apply: "true",
        }),
      /apply must be a boolean/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark learning import rejects malformed Spark export blocks during dry-run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learnings-invalid-import-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const invalidJsonPath = join(dir, "invalid-learning-export.md");
    await writeFile(
      invalidJsonPath,
      ["# Invalid export", "", "```json spark-learning", "{not-json", "```", ""].join("\n"),
      "utf8",
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
          inputPath: invalidJsonPath,
        }),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === invalidJsonPath &&
        error.blockIndex === 1 &&
        /not valid JSON/.test(error.message),
    );

    const invalidRecordPath = join(dir, "invalid-learning-record.md");
    await writeFile(
      invalidRecordPath,
      [
        "# Invalid export",
        "",
        "```json spark-learning",
        JSON.stringify({ id: 42, title: "Incomplete record" }, null, 2),
        "```",
        "",
      ].join("\n"),
      "utf8",
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
          inputPath: invalidRecordPath,
        }),
      (error) =>
        error instanceof LearningExportFormatError &&
        error.filePath === invalidRecordPath &&
        error.blockIndex === 1 &&
        /not valid learning record: learning id must be a string/.test(error.message),
    );

    assert.equal((await defaultLearningStore(dir).list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark learning import accepts legacy compound-learnings directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-legacy-learnings-"));
  try {
    await writeEmptySparkProject(dir);
    const learningDir = join(dir, ".learnings", "gotchas");
    await mkdir(learningDir, { recursive: true });
    await writeFile(
      join(learningDir, "stripe-webhook-raw-body.md"),
      `---
title: "Webhook 验证必须使用 raw body"
category: gotchas
tags: [stripe, webhook, python]
created: 2025-01-15
context: "集成 Stripe webhook 时验证始终失败"
---

## 问题

Stripe webhook 签名验证要求使用原始请求体（raw body），但 FastAPI 默认会解析 JSON。

## 解决方案

在验证前获取 raw body。
`,
    );
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const dryRun = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
    });
    assert.match(toolText(dryRun), /legacy-compound-learnings/);
    assert.match(toolText(dryRun), /Dry-run parsed 1 learning/);
    assert.equal((await defaultLearningStore(dir).list()).length, 0);

    const imported = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
    });
    assert.match(toolText(imported), /Imported 1 learning/);

    const results = await defaultLearningStore(dir).search({ query: "raw body stripe" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.record.category, "gotcha");
    assert.deepEqual(results[0]?.record.tags, ["stripe", "webhook", "python"]);
    assert.match(results[0]?.record.sourceContent ?? "", /FastAPI/);

    await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
    });
    assert.equal((await defaultLearningStore(dir).list()).length, 1);

    const deleted = await executeSparkTool(tools, "spark_learning_import_markdown", ctx, {
      inputPath: ".learnings",
      apply: true,
      deleteLegacyAfterVerifiedExport: true,
      verificationExportPath: "exports/verified-learnings.md",
    });
    assert.match(toolText(deleted), /deleted legacy source/);
    assert.equal(existsSync(join(dir, ".learnings")), true);
    assert.equal(existsSync(join(dir, ".learnings", "gotchas")), false);
    assert.equal(existsSync(join(dir, "exports", "verified-learnings.md")), true);
    assert.equal((await defaultLearningStore(dir).list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark learning tools keep candidate and inactive lifecycle explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-learning-lifecycle-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_learning_record", ctx, {
      id: "learning-review-candidates",
      title: "Review candidates before activation",
      statement: "Task-derived learning candidates should not enter active recall automatically.",
      status: "candidate",
      category: "workflow",
      location: "workspace",
    });
    const defaultSearch = await executeSparkTool(tools, "spark_learning_search", ctx, {
      query: "Task-derived",
      location: "workspace",
    });
    assert.match(toolText(defaultSearch), /No matching learnings/);

    const candidateSearch = await executeSparkTool(tools, "spark_learning_search", ctx, {
      query: "Task-derived",
      includeCandidates: true,
      location: "workspace",
    });
    assert.match(toolText(candidateSearch), /Review candidates before activation/);

    const rejected = await executeSparkTool(tools, "spark_learning_reject", ctx, {
      ref: "artifact:learning-review-candidates",
      reason: "Candidate was intentionally not promoted.",
      location: "workspace",
    });
    assert.match(toolText(rejected), /Rejected learning candidate/);

    await executeSparkTool(tools, "spark_learning_record", ctx, {
      id: "learning-old-policy",
      title: "Old policy",
      statement: "Old learning policy.",
      location: "workspace",
    });
    const stale = await executeSparkTool(tools, "spark_learning_mark_stale", ctx, {
      ref: "artifact:learning-old-policy",
      reason: "Policy was replaced.",
      location: "workspace",
    });
    assert.match(toolText(stale), /Marked stale/);

    const all = await executeSparkTool(tools, "spark_learning_list", ctx, {
      includeInactive: true,
      location: "workspace",
    });
    assert.match(toolText(all), /rejected/);
    assert.match(toolText(all), /stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_ask_replay rejects invalid explicit artifact refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-ask-replay-invalid-ref-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_ask_replay", ctx, { artifactRef: 42 }),
      /artifactRef must be a string/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_ask_replay", ctx, { artifactRef: "ask:one" }),
      /artifactRef must be an artifact: ref/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_project clarifies generic new project intent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-intent-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const created = await executeSparkTool(tools, "spark_use_project", ctx, { title: "tasks" });
    assert.match(toolText(created), /Created new Spark project/);
    assert.equal((created.details as { created?: boolean } | undefined)?.created, true);
    const artifacts = await defaultArtifactStore(dir).list({
      kind: "ask-answer",
    });
    assert.equal(artifacts.length, 1);
    const traces = await defaultArtifactStore(dir).list({
      kind: "run-trace",
    });
    const askArtifact = await defaultArtifactStore(dir).get(artifacts[0].ref);
    const askBody = askArtifact.body as {
      request?: { questions?: Array<{ id: string; prompt?: string }> };
    };
    assert.ok(askBody.request?.questions?.every((question) => question.prompt?.includes("tasks")));
    assert.ok(traces.some((artifact) => artifact.title === "Project purpose clarification"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_project blocks active duplicate project creation without writing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-active-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeGraph = await defaultTaskGraphStore(dir).load();
    const beforeCount = beforeGraph?.projects().length ?? 0;
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);

    const blocked = await executeSparkTool(tools, "spark_use_project", ctx, {
      title: "Tool persistence",
      description: "Same work as the existing Tool persistence project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.match(toolText(blocked), /status=active/);
    assert.match(toolText(blocked), /task\(\{ action: "project_use"/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string; status?: string }>;
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.equal(details?.candidates?.[0]?.status, "active");
    const afterGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(afterGraph?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_project compares duplicates against done projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-done-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultTaskGraphStore(dir);
    await store.update(async (graph) => {
      const project = graph.projects().find((candidate) => candidate.title === "Tool persistence");
      assert.ok(project);
      graph.updateProject(project.ref, { status: "done" });
      return undefined;
    });
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await store.load())?.projects().length ?? 0;

    const blocked = await executeSparkTool(tools, "spark_use_project", ctx, {
      title: "Tool persistence",
      description: "Attempt to recreate a completed duplicate project.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /status=done/);
    const details = blocked.details as
      | { candidates?: Array<{ title?: string; status?: string }> }
      | undefined;
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.equal(details?.candidates?.[0]?.status, "done");
    assert.equal((await store.load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_project creates clearly distinct projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-distinct-create-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const created = await executeSparkTool(tools, "spark_use_project", ctx, {
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

void test("spark_use_project duplicate gate does not block explicit existing project selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-duplicate-use-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const beforeCount = (await defaultTaskGraphStore(dir).load())?.projects().length ?? 0;

    const selected = await executeSparkTool(tools, "spark_use_project", ctx, {
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

    const blocked = await executeSparkTool(tools, "task", ctx, {
      action: "project_use",
      title: "Tool persistence",
      description: "Duplicate via canonical task tool surface.",
    });

    assert.match(toolText(blocked), /Duplicate Spark project creation blocked/);
    assert.match(toolText(blocked), /Tool persistence/);
    assert.match(toolText(blocked), /status=active/);
    assert.match(toolText(blocked), /Select the existing Project/);
    const details = blocked.details as
      | {
          error?: string;
          duplicateProject?: boolean;
          candidates?: Array<{ ref?: string; title?: string; status?: string }>;
          guidance?: string[];
        }
      | undefined;
    assert.equal(details?.error, "duplicate_project");
    assert.equal(details?.duplicateProject, true);
    assert.equal(details?.candidates?.[0]?.title, "Tool persistence");
    assert.equal(details?.candidates?.[0]?.status, "active");
    assert.ok(details?.guidance?.some((line) => line.includes('task({ action: "project_use"')));
    assert.equal((await defaultTaskGraphStore(dir).load())?.projects().length ?? 0, beforeCount);
    assert.equal((await loadCurrentProjectState(dir, ctx))?.projectRef, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_use_project reports selected existing projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-use-project-existing-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const selected = await executeSparkTool(tools, "spark_use_project", ctx, {
      project: "Tool persistence",
    });

    assert.match(toolText(selected), /Selected existing Spark project/);
    assert.equal((selected.details as { created?: boolean } | undefined)?.created, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal tool infers and updates durable session goals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-goal-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await executeSparkTool(tools, "spark_use_project", ctx, { project: "Tool persistence" });

    const inferred = await executeSparkTool(tools, "goal", ctx, { action: "infer" });
    assert.match(toolText(inferred), /Advance project/);
    assert.match(toolText(inferred), /Tool persistence/);

    const started = await executeSparkTool(tools, "goal", ctx, {
      action: "set",
      objective: "Finish the durable goal slice",
    });
    assert.match(toolText(started), /Spark session goal active/);
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
    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    assert.match(toolText(status), /Session goal: active \| Finish the durable goal slice/);
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
    });
    assert.match(toolText(edited), /Finish the edited durable goal slice/);
    const editedGoal = await loadSessionGoal(dir, ctx);
    assert.equal(editedGoal?.goalId, pausedGoal.goalId);
    assert.equal(editedGoal?.objective, "Finish the edited durable goal slice");
    assert.equal(editedGoal?.lastReview, undefined);

    const completed = await executeSparkTool(tools, "goal", ctx, {
      action: "complete",
      reason: "review passed",
    });
    assert.match(toolText(completed), /Goal completion is reviewer-owned/);
    assert.equal(
      (completed.details as { error?: string } | undefined)?.error,
      "goal_completion_reviewer_only",
    );

    const cleared = await executeSparkTool(tools, "goal", ctx, { action: "clear" });
    assert.match(toolText(cleared), /Cleared Spark session goal/);
    assert.equal(await loadSessionGoal(dir, ctx), undefined);
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
    await executeSparkTool(tools, "spark_use_project", ctx, { project: "Pause review" });

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
    assert.equal((await defaultArtifactStore(dir).list({ kind: "review" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal enforces session/project active-goal conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-scope-conflict-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const selected = await executeSparkTool(tools, "spark_use_project", ctx, {
      project: "Tool persistence",
    });
    const projectRef = (selected.details as { project?: { ref?: string } } | undefined)?.project
      ?.ref;
    assert.ok(projectRef);

    const sessionStarted = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the session-scoped slice",
      scope: "session",
    });
    assert.match(toolText(sessionStarted), /Spark session goal active/);
    assert.equal(
      (sessionStarted.details as { goal?: { scope?: string } } | undefined)?.goal?.scope,
      "session",
    );

    const projectConflict = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the project-scoped slice",
      scope: "project",
    });
    assert.match(toolText(projectConflict), /Cannot start project/);
    assert.match(toolText(projectConflict), /session goal is already active/);
    assert.equal((projectConflict.details as { error?: string }).error, "active_goal_conflict");

    const pausedSession = await executeSparkTool(tools, "goal", ctx, {
      action: "pause",
      scope: "session",
      reason: "switch to project goal",
    });
    assert.match(toolText(pausedSession), /Spark session goal paused/);

    const projectStarted = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Finish the current project",
      scope: "project",
    });
    assert.match(toolText(projectStarted), /Spark project goal active/);
    assert.equal(
      (projectStarted.details as { goal?: { scope?: string; projectRef?: string } } | undefined)
        ?.goal?.scope,
      "project",
    );
    assert.equal(
      (projectStarted.details as { goal?: { scope?: string; projectRef?: string } } | undefined)
        ?.goal?.projectRef,
      projectRef,
    );

    await executeSparkTool(tools, "spark_use_project", ctx, {
      title: "Unrelated rocket telemetry",
      description:
        "Distinct project used to verify project-scoped goal binding does not silently switch.",
    });
    const switchedStatus = await executeSparkTool(tools, "goal", ctx, { action: "status" });
    assert.equal(
      (switchedStatus.details as { goal?: { scope?: string; projectRef?: string } } | undefined)
        ?.goal?.scope,
      "project",
    );
    assert.equal(
      (switchedStatus.details as { goal?: { scope?: string; projectRef?: string } } | undefined)
        ?.goal?.projectRef,
      projectRef,
    );

    const switchedProjectConflict = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Start goal for the newly selected project",
      scope: "project",
    });
    assert.match(toolText(switchedProjectConflict), /goal is already active/);
    assert.equal(
      (switchedProjectConflict.details as { error?: string }).error,
      "active_goal_conflict",
    );

    const sessionConflict = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Start another session goal",
      scope: "session",
    });
    assert.match(toolText(sessionConflict), /project .* goal is already active/);
    assert.equal((sessionConflict.details as { error?: string }).error, "active_goal_conflict");

    const status = await executeSparkTool(tools, "goal", ctx, { action: "status" });
    assert.match(toolText(status), /Spark project \(proj:/);
    assert.match(toolText(status), /goal active: Finish the current project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_goal rejects project goal start without a current project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-goal-project-no-current-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    const rejected = await executeSparkTool(tools, "goal", ctx, {
      action: "start",
      objective: "Project goal needs a selected project",
      scope: "project",
    });

    assert.match(toolText(rejected), /No current Spark project is selected/);
    assert.equal((rejected.details as { error?: string }).error, "no_current_project");
    assert.equal((rejected.details as { scope?: string }).scope, "project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active session goal disables ask-like tools before agent turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-goal-disable-asks-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const run = registerSparkToolsForTest();
    await executeSparkTool(run.tools, "spark_use_project", ctx, { project: "Tool persistence" });
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

    assert.ok(!run.getActiveToolNames().includes("ask"));
    assert.ok(!run.getActiveToolNames().includes("ask_user"));
    assert.ok(!run.getActiveToolNames().includes("ask_flow"));
    assert.ok(run.getActiveToolNames().includes("goal"));
    assert.ok(run.getActiveToolNames().includes("task"));

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

void test("spark project tools reject invalid explicit parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-project-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_rename_project", ctx, { title: "" }),
      /title must be a non-empty string/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_rename_project", ctx, { project: 42, title: "Next" }),
      /project must be a string/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_rename_project", ctx, { status: "archived" }),
      /status must be active or done/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_use_project", ctx, { project: "" }),
      /project must be a non-empty string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_use_project", ctx, { title: "New", outputLanguage: "jp" }),
      /outputLanguage must be zh or en/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark extension exposes canonical tools instead of spark_* compatibility tools", () => {
  const run = registerSparkToolsForTest();
  assert.ok(run.tools.has("task"));
  assert.ok(run.tools.has("learning"));
  assert.ok(run.tools.has("ask"));
  assert.ok(run.tools.has("goal"));
  assert.deepEqual(
    run
      .getActiveToolNames()
      .filter((name) => name.startsWith("spark_"))
      .sort(),
    [],
  );
});

void test("spark_plan_tasks describes the public spark-tasks readiness contract", () => {
  const { tools } = registerSparkToolsForTest();
  const planTool = tools.get("spark_plan_tasks");
  assert.ok(planTool);
  assert.match(planTool.description, /Readiness rules:/);
  assert.ok(planTool.description.includes(renderTaskPlanReadinessRules()));
  assert.match(planTool.description, /dependsOn resolution is active-project scoped/);
});

void test("spark_list_projects returns structured filtered project summaries", async () => {
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
      description: "Project that should only appear in done/all filters.",
      status: "done",
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
    await executeSparkTool(tools, "spark_use_project", ctx, { project: activeProject.ref });

    const active = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_projects", ctx, {})),
    ) as Array<{
      ref: string;
      status: string;
      currentForSession: boolean;
      taskCounts: { total: number; active: number; done: number; cancelled: number };
    }>;
    assert.deepEqual(
      active.map((project) => project.ref),
      [activeProject.ref],
    );
    assert.equal(active[0]?.currentForSession, true);
    assert.deepEqual(active[0]?.taskCounts, { total: 3, active: 1, done: 1, cancelled: 1 });

    const done = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_projects", ctx, { status: "done" })),
    ) as Array<{ ref: string; status: string; currentForSession: boolean }>;
    assert.deepEqual(
      done.map((project) => project.ref),
      [doneProject.ref],
    );
    assert.equal(done[0]?.currentForSession, false);

    const all = JSON.parse(
      toolText(await executeSparkTool(tools, "spark_list_projects", ctx, { status: "all" })),
    ) as Array<{ ref: string }>;
    assert.deepEqual(
      all.map((project) => project.ref),
      [activeProject.ref, doneProject.ref],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status does not activate an arbitrary project for the Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-no-auto-project-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-no-auto");
    const { tools } = registerSparkToolsForTest();

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusText = toolText(status);

    assert.doesNotMatch(statusText, /\[current\]/);
    assert.match(statusText, /Spark available: no project selected/);
    assert.doesNotMatch(statusText, /Project Tool persistence/);
    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Tool persistence/);
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, undefined);
    await assert.rejects(() =>
      readFile(join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`), "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status surfaces corrupt current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-corrupt-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-corrupt-sessions");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`),
      "{not-json",
      "utf8",
    );
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_status", ctx, {}),
      (error) =>
        error instanceof JsonStoreFormatError &&
        /not valid JSON/.test(error.message) &&
        /sessions/.test(error.filePath),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status rejects non-object current project state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-status-non-object-sessions-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "status-non-object-sessions");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`),
      "[]\n",
      "utf8",
    );
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_status", ctx, {}),
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
      (await readdir(join(dir, ".spark", "session-todos"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
      [],
    );
    assert.deepEqual(
      (await readdir(join(dir, ".spark", "todo-display-numbers"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("current project store rejects malformed mode snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-sessions-invalid-"));
  try {
    const ctx = testSparkContext(dir, "sessions-invalid");
    const stateFile = currentProjectStatePath(dir, ctx);
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });

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
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /planningMode\.enteredAt must be a non-empty string/.test(error.message),
    );

    await writeFile(
      stateFile,
      `${JSON.stringify({
        version: 1,
        projectRef: "proj:demo",
        executionMode: {
          version: 1,
          projectRef: "proj:demo",
          kind: "single_task",
          enteredAt: "2026-05-28T00:00:00.000Z",
        },
      })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /executionMode\.mode must be research, plan, or execute/.test(error.message),
    );

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
    await assert.rejects(
      () => loadCurrentProjectState(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === stateFile &&
        /runMode\.status must be a valid status/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("done projects are cleared from current selection and not auto-reactivated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-done-project-current-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const doneProject = graph.createProject({
      title: "Completed workflow",
      description: "Should not remain current.",
      status: "done",
    });
    graph.createProject({
      title: "Next workflow",
      description: "Should not become current automatically.",
    });
    await defaultTaskGraphStore(dir).save(graph);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_use_project", ctx, { project: doneProject.ref });
    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const statusDetails = status.details as { activeProjectRef?: string } | undefined;
    assert.equal(statusDetails?.activeProjectRef, undefined);
    assert.match(toolText(status), /Spark available: no project selected/);
    assert.doesNotMatch(toolText(status), /Next workflow \[current\]/);
    assert.doesNotMatch(toolText(status), /Completed workflow \[current\]/);
    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    assert.match(toolText(summary), /Next workflow/);

    await assert.rejects(() =>
      readFile(join(dir, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`), "utf8"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status includes persisted Spark orchestrator status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-status-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
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
    const status = await executeSparkTool(tools, "spark_status", ctx, {});
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
    assert.match(text, /stale: run task\(\{ action: "run_status"/);
    const dagDetails = status.details as {
      dag?: {
        stale?: number;
        timedOut?: number;
        nextSteps?: Array<{ status: string; nextActions: string[] }>;
      };
    };
    assert.equal(dagDetails.dag?.stale, 1);
    assert.equal(dagDetails.dag?.timedOut, 1);
    assert.equal(dagDetails.dag?.nextSteps?.[0]?.status, "stale");
    assert.match(dagDetails.dag?.nextSteps?.[0]?.nextActions.join("\n") ?? "", /stale:/);
    assert.deepEqual(
      dagDetails.dag?.nextSteps?.map((step) => step.status),
      ["stale", "timed_out"],
    );
    assert.match(
      dagDetails.dag?.nextSteps?.[1]?.nextActions.join("\n") ?? "",
      /timed_out: legacy foreground timeout record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_status reconciles DAG runs with current workspace active children only", async () => {
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

    const currentDagRun = await defaultSparkDagRunStore(dir).startRun({
      ownerSessionId: ctxSessionKey(ctx),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 100,
    });
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
    const text = toolText(status);
    assert.match(
      text,
      new RegExp(
        `Actionable workflow run: ${currentDagRun.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[stale\\]`,
      ),
    );
    assert.doesNotMatch(text, new RegExp(`Active workflow run: ${currentDagRun.ref}`));
    const dagStatus = await defaultSparkDagRunStore(dir).status();
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

void test("spark_dag_manager kill_active only targets current workspace role-runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-kill-active-cwd-"));
  const otherDir = await mkdtemp(join(tmpdir(), "spark-tool-dag-kill-active-other-cwd-"));
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
    const result = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "kill_active",
    });

    assert.match(toolText(result), /Killed active role-run processes: 0/);
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

void test("spark_dag_manager rejects invalid explicit control parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-manager-invalid-params-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_dag_manager", ctx, { action: "acknowledge" }),
      /spark_dag_manager action must be status, reconcile, ack, clear_inactive, prune, or kill_active/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_dag_manager", ctx, { action: "ack", runRef: "task:one" }),
      /spark_dag_manager runRef must be a run: ref/,
    );
    await assert.rejects(
      () => executeSparkTool(tools, "spark_dag_manager", ctx, { action: "prune", dryRun: "true" }),
      /spark_dag_manager dryRun must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_dag_manager", ctx, {
          action: "prune",
          keepRecent: 1.5,
        }),
      /spark_dag_manager keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_dag_manager reconciles and clears inactive records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-dag-manager-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
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
    const reconciled = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "reconcile",
    });
    assert.match(toolText(reconciled), /action=reconcile/);
    assert.match(toolText(reconciled), /failed=0/);
    assert.match(toolText(reconciled), /stale=1/);
    assert.match(toolText(reconciled), /Next steps \(stale\):/);
    assert.match(toolText(reconciled), /stale: run task\(\{ action: "run_status"/);
    assert.match(
      (
        (reconciled.details as { dag?: { nextSteps?: Array<{ nextActions: string[] }> } }).dag
          ?.nextSteps?.[0]?.nextActions ?? []
      ).join("\n"),
      /task graph state is consistent/,
    );

    const acknowledged = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "ack",
    });
    assert.match(toolText(acknowledged), /action=ack/);
    assert.match(toolText(acknowledged), /stale=1/);
    assert.match(toolText(acknowledged), /acknowledged=1/);
    assert.match(toolText(acknowledged), /Acknowledged workflow problem runs: 1 newly/);
    assert.doesNotMatch(toolText(acknowledged), /Next steps \(stale\):/);
    const acknowledgedDetails = acknowledged.details as {
      acknowledged?: { acknowledged?: string[] };
      dag?: { acknowledged?: number; recentRuns?: Array<{ acknowledgedBySession?: string }> };
    };
    assert.equal(acknowledgedDetails.dag?.acknowledged, 1);
    assert.equal(acknowledgedDetails.acknowledged?.acknowledged?.length, 1);
    assert.equal(
      acknowledgedDetails.dag?.recentRuns?.find((run) => run.acknowledgedBySession)
        ?.acknowledgedBySession,
      ctxSessionKey(ctx),
    );

    const compactStatus = await executeSparkTool(tools, "spark_status", ctx, {});
    assert.doesNotMatch(toolText(compactStatus), /Spark workflow runs:/);
    assert.doesNotMatch(toolText(compactStatus), /stale=1/);

    const fullStatus = await executeSparkTool(tools, "spark_status", ctx, { view: "full" });
    assert.match(toolText(fullStatus), /Spark workflow runs: idle runs=2 recent/);
    assert.match(toolText(fullStatus), /stale=1/);
    assert.match(toolText(fullStatus), /acknowledged=1/);
    assert.match(toolText(fullStatus), /Recent workflow runs:/);

    const cleared = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "clear_inactive",
    });
    assert.match(toolText(cleared), /action=clear_inactive/);
    assert.match(toolText(cleared), /runs=0 recent/);
    assert.equal(
      (cleared.details as { dag?: { recentRuns?: unknown[] } }).dag?.recentRuns?.length,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state prune defaults to dry-run and does not write workflow run store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-prune-dryrun-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const dagStore = defaultSparkDagRunStore(dir);
    const run = await dagStore.startRun({ dryRun: false, maxConcurrency: 1, timeoutMs: 100 });
    await dagStore.finishRun(run.ref, { scheduled: 0, completed: 0, timedOut: false });
    const before = await readFile(join(dir, ".spark", "workflow-runs.json"), "utf8");

    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "prune",
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

void test("spark_background_runs exposes active child runs and refuses broad kill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-active-"));
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
      name: "background-child",
      title: "Background child task",
      description: "Run a long-lived fake role-run for background inspection.",
      kind: "implement",
      status: "pending",
      plan: executionReadyPlan("Background child task"),
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
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, {
      dryRun: false,
      timeoutMs: 50,
    });

    await waitFor(async () => {
      const status = await executeSparkTool(tools, "spark_background_runs", ctx, {
        action: "status",
        includeDetails: true,
      });
      const background = (
        status.details as {
          background?: { childRuns?: Array<{ activeProcess?: boolean; taskName?: string }> };
        }
      ).background;
      return Boolean(
        background?.childRuns?.some(
          (child) => child.activeProcess && child.taskName === "background-child",
        ),
      );
    }, 5_000);

    const status = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "status",
      includeDetails: true,
    });
    const statusText = toolText(status);
    assert.match(statusText, /Background work: running/);
    assert.match(statusText, /Active children:/);
    assert.match(statusText, /task=@background-child/);
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
    assert.equal(statusDetails.background?.summary?.activeChildren, 1);
    const child = statusDetails.background?.childRuns?.find((entry) => entry.activeProcess);
    assert.ok(child?.runRef);
    assert.equal(child.taskName, "background-child");
    assert.equal(child.claimKind, "role-run");
    assert.equal(typeof child.pid, "number");

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "inspect",
      runRef: child.runRef,
    });
    assert.match(toolText(inspect), new RegExp(`Background child run: ${child.runRef} active`));
    assert.match(toolText(inspect), /Task: @background-child/);

    const refused = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "kill",
    });
    assert.match(toolText(refused), /kill_requires_target/);
    assert.equal(
      (refused.details as { background?: { error?: string } }).background?.error,
      "kill_requires_target",
    );

    const killed = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "kill",
      runRef: child.runRef,
      forceAfterMs: 0,
    });
    assert.match(toolText(killed), /Stopped background child runs: 1/);
    assert.equal(
      ((killed.details as { background?: { killed?: unknown[] } }).background?.killed ?? []).length,
      1,
    );
    await waitFor(async () => {
      const reloaded = await defaultTaskGraphStore(dir).load();
      return !reloaded?.tasks(project.ref).some((task) => task.status === "running");
    }, 5_000);
    await waitFor(async () => (await defaultSparkDagRunStore(dir).status()).running === 0, 5_000);
  } finally {
    await killActiveSparkRoleRunProcesses({ forceAfterMs: 0, waitMs: 1_000 });
    if (existsSync(join(dir, ".spark", "workflow-runs.json"))) {
      await waitFor(async () => {
        const reloaded = await defaultTaskGraphStore(dir).load();
        return !reloaded?.tasks().some((task) => task.status === "running");
      }, 5_000).catch(() => undefined);
      await waitFor(
        async () => (await defaultSparkDagRunStore(dir).status()).running === 0,
        5_000,
      ).catch(() => undefined);
    }
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_background_runs reports failed DAG with stuck child as attention needed", async () => {
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

    const dagRunStore = defaultSparkDagRunStore(dir);
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
    const status = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "status",
      includeDetails: true,
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

void test("spark_background_runs inspect/list use compact role-run summaries and tail refs", async () => {
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
      kind: "role-run",
      title: "Failed role-run transcript",
      format: "text",
      body: "full transcript is intentionally behind a ref",
      provenance: {
        producer: "task",
        projectRef: project.ref,
        taskRef: failedTask.ref,
        roleRef,
        runRef: failedRunRef,
      },
    });
    const failedArtifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
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
      kind: "role-run",
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
    const dagStore = defaultSparkDagRunStore(dir);
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

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
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

    const list = await executeSparkTool(tools, "spark_background_runs", ctx, {
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

void test("spark_background_runs inspect keeps legacy large role-run artifacts behind refs", async () => {
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
      description: "Represents an old background role-run with a large full-output artifact.",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("Legacy large background role-run task"),
    });
    const legacyBodyMarker = "BACKGROUND_LEGACY_ROLE_RUN_FULL_BODY_SENTINEL";
    const artifact = await defaultArtifactStore(dir).put({
      kind: "role-run",
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

    const inspect = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "inspect",
      runRef,
    });
    const text = toolText(inspect);
    assert.match(text, /Background child run: run:legacy-large-background-role-run succeeded/);
    assert.match(text, new RegExp(artifact.ref));
    assert.match(text, /unsupported_role_run_body: full artifact not loaded/);
    assert.doesNotMatch(text, new RegExp(legacyBodyMarker));
    assert.doesNotMatch(JSON.stringify(inspect.details), new RegExp(legacyBodyMarker));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_background_runs reconciles, acks scoped problems, and renders legacy timeouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-background-runs-records-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const graph = await defaultTaskGraphStore(dir).load();
    assert.ok(graph);
    const [project] = graph.projects();
    assert.ok(project);
    const dagStore = defaultSparkDagRunStore(dir);
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
    const reconciled = await executeSparkTool(tools, "spark_background_runs", ctx, {
      action: "reconcile",
      includeDetails: true,
    });
    assert.match(toolText(reconciled), /Reconciled background records changed: 1/);
    assert.match(toolText(reconciled), /Legacy timeout record/);
    assert.match(toolText(reconciled), /Workflow run .*stale/);
    const reconcileDetails = reconciled.details as {
      background?: { dagRuns?: Array<{ runRef: string; status: string; legacyTimedOut: boolean }> };
    };
    assert.equal(
      reconcileDetails.background?.dagRuns?.some(
        (run) => run.runRef === stale.ref && run.status === "stale",
      ),
      true,
    );
    assert.equal(
      reconcileDetails.background?.dagRuns?.some(
        (run) => run.runRef === legacy.ref && run.legacyTimedOut,
      ),
      true,
    );

    const acknowledged = await executeSparkTool(tools, "spark_background_runs", ctx, {
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

    const dagManager = await executeSparkTool(tools, "spark_dag_manager", ctx, {
      action: "status",
    });
    assert.match(
      toolText(dagManager),
      /Low-level compatibility tool; prefer spark_background_runs/,
    );
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

void test("spark_run_ready_tasks preflights only the current ready frontier", async () => {
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
    const result = await executeSparkTool(tools, "spark_run_ready_tasks", ctx, {
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 123,
    });

    assert.match(toolText(result), /Spark workflow-run scheduler started/);
    assert.deepEqual((result.details as { policy?: unknown }).policy, {
      maxConcurrency: 1,
      timeoutMs: 123,
    });
    const runMode = await loadSparkRunMode(dir, ctx);
    assert.equal(runMode?.policy.maxConcurrency, 1);
    assert.equal(runMode?.policy.timeoutMs, 123);
    const bindingFile = JSON.parse(
      await readFile(join(dir, ".agents", "role-model-bindings.json"), "utf8"),
    ) as { bindings: Array<{ roleRef: string }> };
    assert.deepEqual(
      bindingFile.bindings.map((binding) => binding.roleRef),
      ["role:builtin-worker"],
    );
    await waitFor(async () => {
      const dagStatus = await defaultSparkDagRunStore(dir).status();
      return dagStatus.succeeded === 1 || dagStatus.failed > 0;
    }, 10_000);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_run_ready_tasks reports workflow-run completion without queuing a follow-up user message", async () => {
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
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Spark workflow run:")),
      10_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 10_000);

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 1);
    assert.equal(dagStatus.lastRun?.projectRef, project.ref);
    const reloadedGraph = await defaultTaskGraphStore(dir).load();
    assert.equal(reloadedGraph?.getTask(otherTask.ref).status, "pending");
    assert.doesNotMatch(messages.join("\n"), /Spark workflow run:/);
    assert.equal(ctx.notifications.at(-1)?.level, "info");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Spark workflow run:/);
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

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
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

void test("spark_status renders legacy large role-run artifacts by refs without full body", async () => {
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
      kind: "role-run",
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

    const status = await executeSparkTool(tools, "spark_status", ctx, {});
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

void test("spark_run_ready_tasks marks Spark workflow-run scheduler failed when child role-run fails", async () => {
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
    await executeSparkTool(tools, "spark_run_ready_tasks", ctx, { dryRun: false });
    await waitFor(
      () => ctx.notifications.some((notice) => notice.message.includes("Spark workflow run:")),
      3_000,
    );
    await waitFor(() => !ctx.notifications.at(-1)?.message.includes("running"), 3_000);

    const dagStatus = await defaultSparkDagRunStore(dir).status();
    assert.equal(dagStatus.succeeded, 0);
    assert.equal(dagStatus.failed, 1);
    assert.equal(dagStatus.lastRun?.status, "failed");
    assert.doesNotMatch(
      messages.join("\n"),
      /Spark workflow run: .* failed: scheduled 1, completed 1/,
    );
    assert.equal(ctx.notifications.at(-1)?.level, "error");
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /Spark workflow run: .* failed: scheduled 1, completed 1/,
    );
    assert.match(
      ctx.notifications.at(-1)?.message ?? "",
      /failed: inspect task\(\{ action: "run_status"/,
    );
    const hiddenInbox = await consumeSparkModeContext(extension, ctx);
    assert.match(hiddenInbox, /Recent unread background role-run results:/);
    assert.match(hiddenInbox, /\[failed\] task=task:/);
    assert.match(hiddenInbox, /next=inspect with task\(\{ action: "run_status"/);
    assert.doesNotMatch(hiddenInbox, /full transcript/i);
    assert.equal(await tryConsumeSparkModeContext(extension, ctx), undefined);
    await waitFor(() => existsSync(join(dir, ".spark", "todos")), 3_000);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

void test("spark_status defaults to active view, supports full history, summary, and limit", async () => {
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
      description: "Hidden from active view unless full history is requested.",
      kind: "generic",
      status: "done",
    });
    graph.createTask({
      projectRef: project.ref,
      name: "cancelled",
      title: "Cancelled task history",
      description: "Hidden from active view unless full history is requested.",
      kind: "generic",
      status: "cancelled",
    });
    await store.save(graph);

    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProject(tools, ctx);
    const active = await executeSparkTool(tools, "spark_status", ctx, {});
    const activeText = toolText(active);
    assert.match(activeText, /Spark tasks \(active view, limit=20\):/);
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
    assert.equal(active.details?.limit, 20);
    assert.equal(active.details?.activeProjectRef, project.ref);
    assert.equal("tasks" in active.details!, false);
    assert.equal("dependencies" in active.details!, false);

    const json = await executeSparkTool(tools, "spark_status", ctx, { format: "json" });
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
      independentTodos: { total: number; todos: unknown[] };
      projects?: unknown[];
      dag?: { recentRuns?: unknown[] };
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
    assert.equal(jsonStatus.dag?.recentRuns, undefined);
    assert.match(jsonStatus.hints?.join("\n") ?? "", /includeDetails=true/);
    assert.equal(jsonStatus.independentTodos.total, 0);
    assert.equal(json.details?.format, "json");

    const detailedJson = await executeSparkTool(tools, "spark_status", ctx, {
      format: "json",
      includeDetails: true,
    });
    const detailedStatus = JSON.parse(toolText(detailedJson)) as {
      compact?: boolean;
      renderedProjects: Array<{ tasks: Array<{ name: string }> }>;
      projects: unknown[];
      dag: { recentRuns: unknown[] };
    };
    assert.equal(detailedStatus.compact, undefined);
    assert.deepEqual(
      detailedStatus.renderedProjects[0]?.tasks.map((task) => task.name),
      ["mine", "other"],
    );
    assert.ok(Array.isArray(detailedStatus.projects));
    assert.ok(Array.isArray(detailedStatus.dag.recentRuns));

    const limited = await executeSparkTool(tools, "spark_status", ctx, { limit: 1 });
    const limitedText = toolText(limited);
    assert.match(limitedText, /Spark tasks \(active view, limit=1\):/);
    assert.match(limitedText, /Hidden by limit: 1/);
    assert.equal((limitedText.match(/^ {2}- \[/gm) ?? []).length, 1);

    const summary = await executeSparkTool(tools, "spark_status", ctx, { view: "summary" });
    const summaryText = toolText(summary);
    assert.match(summaryText, /Spark tasks \(summary view\):/);
    assert.match(summaryText, /Tasks: 4 total/);
    assert.doesNotMatch(summaryText, /Active tasks:/);
    assert.doesNotMatch(summaryText, /^ {2}- \[/m);
    assert.equal(summary.details?.view, "summary");
    assert.equal(summary.details?.limit, undefined);

    const full = await executeSparkTool(tools, "spark_status", ctx, { view: "full" });
    const fullText = toolText(full);
    assert.match(fullText, /Spark tasks \(full view\):/);
    assert.match(fullText, /Durable active tasks:/);
    assert.doesNotMatch(fullText, /Finished task history/);
    assert.doesNotMatch(fullText, /Cancelled task history/);
    assert.match(fullText, /Completed tasks: 2 total \| done=1 \| cancelled=1/);
    assert.match(fullText, /Spark state cache:/);
    assert.match(fullText, /sessions: \d+ files/);
    assert.match(fullText, /Protected stores:/);
    assert.match(fullText, /project graph: 1 files/);
    assert.doesNotMatch(fullText, /Hidden finished tasks/);
    assert.equal(full.details?.view, "full");
    assert.equal(full.details?.limit, undefined);
    const state = (
      full.details as
        | {
            state?: {
              caches: Array<{ kind: string; files: number }>;
              protectedStores: Array<{ reason: string; files: number }>;
            };
          }
        | undefined
    )?.state;
    assert.ok(state);
    assert.ok(state.caches.some((cache) => cache.kind === "sessions" && cache.files >= 1));
    assert.ok(
      state.protectedStores.some((store) => store.reason === "task-graph" && store.files === 1),
    );

    const fullFromLegacyFlag = await executeSparkTool(tools, "spark_status", ctx, {
      showFinished: true,
    });
    assert.equal(fullFromLegacyFlag.details?.view, "full");
    assert.doesNotMatch(toolText(fullFromLegacyFlag), /Finished task history/);
    assert.match(toolText(fullFromLegacyFlag), /Completed tasks: 2 total \| done=1 \| cancelled=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state cleanup previews and deletes only safe cache files", async () => {
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
    await mkdir(currentProjectDir, { recursive: true });
    await mkdir(taskTodoDir, { recursive: true });
    await mkdir(sessionTodoDir, { recursive: true });
    await mkdir(displayNumberDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await mkdir(roleReportsDir, { recursive: true });

    const missingProjectFile = join(currentProjectDir, "old-owner.json");
    const emptyOtherTaskTodos = join(taskTodoDir, "other-session.json");
    const currentTaskTodos = join(taskTodoDir, `${currentSessionScope}.json`);
    const terminalOtherSessionTodos = join(sessionTodoDir, "other-session.json");
    const staleDisplayNumbers = join(displayNumberDir, "other-session.json");
    const protectedArtifact = join(artifactsDir, "keep.txt");
    const protectedWorkflowRuns = join(dir, ".spark", "workflow-runs.json");
    const protectedReviewGate = join(dir, ".spark", "review-gate.json");
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
    await writeFile(protectedReviewGate, JSON.stringify({ ref: "review:keep" }), "utf8");
    await writeFile(protectedNote, "keep", "utf8");
    await writeFile(protectedRoleReport, "keep", "utf8");
    await utimes(terminalOtherSessionTodos, oldDate, oldDate);
    await utimes(staleDisplayNumbers, oldDate, oldDate);

    const dryRun = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
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

    const apply = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
      dryRun: false,
      olderThanDays: 30,
    });
    assert.match(toolText(apply), /Spark state cleanup apply: deleted 4 safe cache file\(s\)/);
    assert.equal(existsSync(missingProjectFile), false);
    assert.equal(existsSync(emptyOtherTaskTodos), false);
    assert.equal(existsSync(terminalOtherSessionTodos), false);
    assert.equal(existsSync(staleDisplayNumbers), false);
    assert.equal(existsSync(currentTaskTodos), true);
    assert.equal(existsSync(join(dir, ".spark", "projects.json")), true);
    assert.equal(existsSync(protectedArtifact), true);
    assert.equal(existsSync(protectedWorkflowRuns), true);
    assert.equal(existsSync(protectedReviewGate), true);
    assert.equal(existsSync(protectedNote), true);
    assert.equal(existsSync(protectedRoleReport), true);

    const status = await executeSparkTool(tools, "spark_state", ctx, { action: "status" });
    assert.match(toolText(status), /Spark state status:/);
    assert.match(toolText(status), /Protected stores:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state reports broken cache files without counting them safe by default", async () => {
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

    const status = await executeSparkTool(tools, "spark_state", ctx, { action: "status" });
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

    const defaultCleanup = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
      dryRun: false,
    });
    assert.match(toolText(defaultCleanup), /deleted 0 safe cache file\(s\)/);
    assert.equal(existsSync(brokenCurrentProject), true);
    assert.equal(existsSync(brokenDisplayNumbers), true);

    const explicitBrokenCleanup = await executeSparkTool(tools, "spark_state", ctx, {
      action: "cleanup",
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

void test("spark_state diagnostics reports protected-store candidates without deleting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-state-diagnostics-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    const terminalProject = graph.createProject({
      title: "Completed diagnostics project",
      description: "Project with no unfinished work.",
      status: "done",
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
    await defaultSparkDagRunStore(dir).save({
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
      kind: "role-run",
      title: "Large diagnostics artifact",
      format: "text",
      body: "x".repeat(70 * 1024),
      provenance: { producer: "spark", projectRef: terminalProject.ref },
    });
    const orphanBlob = join(dir, ".spark", "artifacts", "blobs", "orphan-diagnostics.txt");
    const noteFile = join(dir, ".spark", "notes", "diagnostics-note.md");
    const roleReportFile = join(dir, ".spark", "role-reports", "diagnostics-report.md");
    const reviewGateFile = join(dir, ".spark", "review-gate.json");
    await mkdir(join(dir, ".spark", "artifacts", "blobs"), { recursive: true });
    await mkdir(join(dir, ".spark", "notes"), { recursive: true });
    await mkdir(join(dir, ".spark", "role-reports"), { recursive: true });
    await writeFile(orphanBlob, "orphan", "utf8");
    await writeFile(noteFile, "note", "utf8");
    await writeFile(roleReportFile, "role report", "utf8");
    await writeFile(reviewGateFile, JSON.stringify({ ref: "review:diagnostics" }), "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const diagnostics = await executeSparkTool(tools, "spark_state", ctx, {
      action: "diagnostics",
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

    assert.equal(existsSync(join(dir, ".spark", "projects.json")), true);
    assert.equal(existsSync(defaultArtifactStore(dir).pathFor(artifact.ref)), true);
    assert.equal(existsSync(orphanBlob), true);
    assert.equal(existsSync(noteFile), true);
    assert.equal(existsSync(roleReportFile), true);
    assert.equal(existsSync(reviewGateFile), true);
    assert.equal(existsSync(join(dir, ".spark", "workflow-runs.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state diagnostics surfaces artifact blob stat failures", async () => {
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
      () => executeSparkTool(tools, "spark_state", ctx, { action: "diagnostics" }),
      /ENAMETOOLONG|name too long/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state rejects invalid explicit action and path parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-action-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_state", ctx, { action: "repair" }),
      /action must be status, diagnostics, doctor, cleanup, prune, or compact-role-run-artifacts/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "compact-role-run-artifacts",
          exportDir: 42,
        }),
      /exportDir must be a string/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "compact-role-run-artifacts",
          exportDir: "",
        }),
      /exportDir must be a non-empty string/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state rejects invalid numeric parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-numeric-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "compact-role-run-artifacts",
          thresholdBytes: "1024",
        }),
      /thresholdBytes must be a finite number/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "compact-role-run-artifacts",
          tailBytes: 0,
        }),
      /tailBytes must be a positive integer/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "prune",
          keepRecent: 1.5,
        }),
      /keepRecent must be a non-negative integer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state rejects invalid boolean parameters instead of using defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-state-invalid-boolean-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_state", ctx, { action: "cleanup", dryRun: "false" }),
      /dryRun must be a boolean/,
    );
    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_state", ctx, {
          action: "cleanup",
          includeBroken: "true",
        }),
      /includeBroken must be a boolean/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_state compact-role-run-artifacts dry-run lists large role-run candidates and keeps non-role artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-dry-run-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "role-run",
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
      kind: "research",
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
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
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

void test("spark_state compact-role-run-artifacts skips blob paths outside artifact root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-boundary-"));
  const outsidePath = `${dir}-outside-role-run.json`;
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "role-run",
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
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
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

void test("spark_state compact-role-run-artifacts reports invalid artifact metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-invalid-json-"));
  try {
    await writeEmptySparkProject(dir);
    const metadataDir = join(dir, ".spark", "artifacts");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "broken-role-run.json"), "{not-json", "utf8");

    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    const result = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
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

void test("spark_state compact-role-run-artifacts apply writes replacement summary before deleting blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-role-run-retention-apply-"));
  try {
    await writeEmptySparkProject(dir);
    const store = defaultArtifactStore(dir);
    const roleRun = await store.put({
      kind: "role-run",
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
    const applied = await executeSparkTool(tools, "spark_state", ctx, {
      action: "compact-role-run-artifacts",
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

void test("spark_plan_tasks keeps large plan output bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-plan-bounded-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();
    await useOnlySparkProjectInExplicitPlanMode(tools, ctx);

    const planned = await executeSparkTool(tools, "spark_plan_tasks", ctx, {
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

void test("spark_update_todos persists independent session TODOs across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_update_todos", ctx, {
      ops: [
        { op: "init", items: ["Coordinate review", "Summarize result"] },
        { op: "done", item: "Coordinate review" },
        { op: "append", items: ["Archive notes"] },
        { op: "note", item: "Summarize result", text: "Visible after reload" },
      ],
    });

    const todoFile = sessionIndependentTodoPath(dir, ctx);
    const stored = JSON.parse(await readFile(todoFile, "utf8")) as IndependentTodoStoreFile;
    assert.equal(stored.version, 1);
    assert.deepEqual(
      stored.todos.map((todo) => [todo.content, todo.status, todo.notes ?? []]),
      [
        ["Coordinate review", "done", []],
        ["Summarize result", "in_progress", ["Visible after reload"]],
        ["Archive notes", "pending", []],
      ],
    );
    assert.doesNotMatch(
      await readFile(join(dir, ".spark", "projects.json"), "utf8"),
      /Coordinate review/,
    );

    const reloaded = registerSparkToolsForTest();
    const status = await executeSparkTool(reloaded.tools, "spark_status", ctx, {});
    const statusText = toolText(status);
    assert.match(statusText, /Independent session TODOs: 3/);
    assert.match(statusText, /\[done\].*Coordinate review/);
    assert.match(statusText, /\[in_progress\].*Summarize result/);
    assert.match(statusText, /\[pending\].*Archive notes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark todo tools reject invalid explicit ops without saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-todos-invalid-ops-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await assert.rejects(
      () => executeSparkTool(tools, "spark_update_todos", ctx, { ops: [{ op: "pause" }] }),
      /ops\[0\]\.op must be init/,
    );
    assert.equal(existsSync(sessionIndependentTodoPath(dir, ctx)), false);

    await useOnlySparkProject(tools, ctx);
    const claim = await executeSparkTool(tools, "spark_claim_task", ctx, {
      name: "todo-invalid",
      title: "TODO invalid",
      description: "Invalid TODO ops must not alter task TODO state.",
      plan: executionReadyPlan("Reject invalid TODO ops."),
      todos: ["Validate TODO operation rejection"],
    });
    const taskRef = (claim.details?.task as { ref?: TaskRef } | undefined)?.ref;
    assert.ok(taskRef);

    await assert.rejects(
      () =>
        executeSparkTool(tools, "spark_update_task_todos", ctx, {
          ops: [{ op: "init", items: [42] }],
        }),
      /ops\[0\]\.items must be an array of strings/,
    );

    const loaded = await defaultTaskGraphStore(dir).load();
    assert.equal(loaded?.getTask(taskRef).status, "running");
    const todoFile = sessionTaskTodoPath(dir, ctx);
    assert.equal(existsSync(todoFile), true);
    const todos = JSON.parse(await readFile(todoFile, "utf8")) as TaskTodoStoreFile;
    assert.equal(todos.todos.length, 1);
    assert.equal(todos.todos[0]?.content, "Validate TODO operation rejection");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("independent session TODO store rejects malformed persisted snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-invalid-"));
  try {
    const ctx = testSparkContext(dir, "main");
    const todoFile = sessionIndependentTodoPath(dir, ctx);
    assert.deepEqual(await loadIndependentTodos(dir, ctx), []);
    await mkdir(join(dir, ".spark", "session-todos"), { recursive: true });

    await writeFile(todoFile, "[]\n", "utf8");
    await assert.rejects(
      () => loadIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /JSON root must be an object/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 2, todos: [] })}\n`, "utf8");
    await assert.rejects(
      () => loadIndependentTodos(dir, ctx),
      (error) =>
        error instanceof JsonStoreFormatError &&
        error.filePath === todoFile &&
        /version must be 1/.test(error.message),
    );

    await writeFile(todoFile, `${JSON.stringify({ version: 1, todos: {} })}\n`, "utf8");
    await assert.rejects(
      () => loadIndependentTodos(dir, ctx),
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
      () => loadIndependentTodos(dir, ctx),
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
    await mkdir(join(dir, ".spark", "todo-display-numbers"), { recursive: true });

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
    await mkdir(join(dir, ".spark", "background-role-results-inbox"), { recursive: true });

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

void test("spark_update_todos can restore deleted independent TODOs after reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-tool-session-todos-restore-"));
  try {
    await writeEmptySparkProject(dir);
    const ctx = testSparkContext(dir, "main");
    const { tools } = registerSparkToolsForTest();

    await executeSparkTool(tools, "spark_update_todos", ctx, {
      ops: [{ op: "init", items: ["Wait for approval", "Continue implementation"] }],
    });
    const todoFile = sessionIndependentTodoPath(dir, ctx);
    const initialized = JSON.parse(await readFile(todoFile, "utf8")) as IndependentTodoStoreFile;
    const deletedTodo = initialized.todos.find((todo) => todo.content === "Wait for approval");
    assert.ok(deletedTodo?.id);

    await executeSparkTool(tools, "spark_update_todos", ctx, {
      ops: [
        { op: "block", id: deletedTodo.id, blockedBy: ["Approval gate"] },
        { op: "delete", id: deletedTodo.id },
      ],
    });
    const deleted = JSON.parse(await readFile(todoFile, "utf8")) as IndependentTodoStoreFile;
    const deletedEntry = deleted.todos.find((todo) => todo.id === deletedTodo.id);
    assert.equal(deletedEntry?.status, "deleted");
    assert.deepEqual(deletedEntry?.blockedBy, ["Approval gate"]);
    assert.equal(typeof deletedEntry?.deletedAt, "string");
    const hiddenStatus = await executeSparkTool(tools, "spark_status", ctx, {});
    assert.match(toolText(hiddenStatus), /Independent session TODOs: 1 active/);
    assert.doesNotMatch(toolText(hiddenStatus), /Wait for approval/);

    const reloaded = registerSparkToolsForTest();
    await executeSparkTool(reloaded.tools, "spark_update_todos", ctx, {
      ops: [{ op: "restore", id: deletedTodo.id }],
    });

    const restored = JSON.parse(await readFile(todoFile, "utf8")) as IndependentTodoStoreFile;
    const restoredEntry = restored.todos.find((todo) => todo.id === deletedTodo.id);
    assert.equal(restoredEntry?.status, "pending");
    assert.equal(restoredEntry?.deletedAt, undefined);
    assert.deepEqual(restoredEntry?.blockedBy, ["Approval gate"]);
    const restoredStatus = await executeSparkTool(reloaded.tools, "spark_status", ctx, {});
    assert.match(toolText(restoredStatus), /Independent session TODOs: 2 active/);
    assert.match(toolText(restoredStatus), /\[pending\].*Wait for approval/);
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
    options?: { deliverAs?: string; triggerTurn?: boolean };
  }>;
  commands: Map<string, Parameters<SparkExtensionApiForTest["registerCommand"]>[1]>;
  shortcuts: Map<string, Parameters<NonNullable<SparkExtensionApiForTest["registerShortcut"]>>[1]>;
  eventHandlers: Map<string, Array<(event: unknown, ctx: TestSparkContext) => unknown>>;
  getActiveToolNames: () => string[];
} {
  const tools = new Map<string, SparkToolConfig>();
  const activeToolNames = new Set<string>();
  const messages: string[] = [];
  const customMessages: Array<{
    customType: string;
    content: string;
    display?: boolean;
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
    getAllTools: () => [...activeToolNames].map((name) => ({ name })),
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
  };
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
  await executeSparkTool(tools, "spark_use_project", ctx, { project: "Tool persistence" });
}

async function useOnlySparkProjectInExplicitPlanMode(
  tools: Map<string, SparkToolConfig>,
  ctx: TestSparkContext,
): Promise<void> {
  await useOnlySparkProject(tools, ctx);
  const statePath = join(ctx.cwd, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { projectRef?: string };
  assert.ok(state.projectRef);
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        version: 1,
        projectRef: state.projectRef,
        planningMode: {
          version: 1,
          projectRef: state.projectRef,
          source: "direct",
          enteredAt: new Date().toISOString(),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
  assert.ok(predicate(), "timed out waiting for condition");
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

function hiddenRoleRunInboxPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "background-role-results-inbox", `${ctxSessionStoreScope(ctx)}.json`);
}

function currentProjectStatePath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "sessions", `${ctxSessionStoreScope(ctx)}.json`);
}

function todoDisplayNumberPath(cwd: string, ctx: TestSparkContext): string {
  return join(cwd, ".spark", "todo-display-numbers", `${ctxSessionStoreScope(ctx)}.json`);
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
