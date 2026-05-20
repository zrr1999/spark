import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ArtifactRef } from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import { buildExtendedOptions, renderAskScreen, SENTINEL_LABELS } from "pi-ask";
import {
  createSparkAskToolRequest,
  runSparkAskTool,
} from "../packages/spark/src/extension/spark-ask-tool.ts";
import {
  approveAgentSpecAsk,
  clarifyThreadAsk,
  createElaborationResult,
  createSparkAskRequest,
  createSparkAskResult,
  isSparkAskGateBlocked,
  replayableSparkAsk,
  runSparkAsk,
} from "spark-ask";

type AskArtifactBodyForTest = {
  result: {
    status: string;
    nextAction?: string;
    mode: string;
    answers: Record<string, { values: string[]; customText?: string }>;
  };
};

type SparkToolDetailsForTest = {
  status: string;
  blocked: boolean;
  artifactRef: string;
  result: {
    nextAction?: string;
    answers: Record<string, { values: string[]; customText?: string }>;
  };
};

function assertSparkToolDetails(details: unknown): asserts details is SparkToolDetailsForTest {
  assert.ok(details && typeof details === "object");
  assert.equal(typeof (details as { status?: unknown }).status, "string");
  assert.equal(typeof (details as { blocked?: unknown }).blocked, "boolean");
  assert.equal(typeof (details as { artifactRef?: unknown }).artifactRef, "string");
  assert.ok(
    (details as { result?: unknown }).result &&
      typeof (details as { result?: unknown }).result === "object",
  );
}

void test("clarify-thread flow produces rich clarification questions", () => {
  const request = clarifyThreadAsk({
    idea: "Build a local SVG animation extension",
  });
  assert.equal(request.flow, "clarify-thread");
  assert.equal(request.questions[0]?.id, "output-language");
  assert.equal(request.questions[1]?.id, "working-title");
  assert.ok(request.questions.some((question) => question.id === "spark-focus"));
  assert.ok(request.questions.some((question) => question.id === "delivery-mode"));
  assert.ok(request.questions.some((question) => question.id === "next-action"));
  assert.ok(request.questions.some((question) => question.id === "boundary"));
  assert.ok(request.questions.length <= 6);
});

void test("clarify-thread asks users to confirm detected output language", () => {
  const request = clarifyThreadAsk({ idea: "梳理下一步改进点" });
  const languageQuestion = request.questions.find((question) => question.id === "output-language");
  assert.equal(languageQuestion?.required, true);
  assert.equal(languageQuestion?.options?.[0]?.value, "zh");
});

void test("approval flow without UI blocks instead of implicitly approving", async () => {
  const request = approveAgentSpecAsk({
    proposal: {
      id: "svg-agent",
      description: "Handles SVG animation plans",
      systemPrompt: "You are a SVG planner.",
      rationale: "Need a reusable specialist",
      expectedUses: ["svg planning"],
    },
  });
  const result = await runSparkAsk(request);
  assert.equal(result.flow, "approve-agent-spec");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.approval, undefined);
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("approve-agent-spec flow records explicit approval selections", async () => {
  const request = approveAgentSpecAsk({
    proposal: {
      id: "svg-agent",
      description: "Handles SVG animation plans",
      systemPrompt: "You are a SVG planner.",
      rationale: "Need a reusable specialist",
      expectedUses: ["svg planning"],
    },
  });
  const result = await runSparkAsk(request, { select: async () => "Approve" });
  assert.equal(result.flow, "approve-agent-spec");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.equal(result.answers.approval?.values[0], "approve");
});

void test("decision/approval asks expose no-selection as a blocking result envelope", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Dispatch agents?",
    questions: [
      {
        id: "answer",
        prompt: "Dispatch agents?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, { select: async () => undefined });
  assert.equal(result.status, "no_selection");
  assert.equal(result.cancelled, false);
  assert.equal(result.nextAction, "block");
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("partial decision asks block when a later required selection is missing", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Dispatch agents?",
    questions: [
      {
        id: "plan",
        prompt: "Which plan?",
        type: "single",
        required: true,
        options: [
          { value: "a", label: "Plan A" },
          { value: "b", label: "Plan B" },
        ],
      },
      {
        id: "approval",
        prompt: "Dispatch agents now?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  });
  let calls = 0;
  const result = await runSparkAsk(request, {
    select: async () => {
      calls += 1;
      if (calls === 1) return "Plan A";
      return undefined;
    },
  });
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.deepEqual(result.answers.plan?.values, ["a"]);
  assert.equal(result.answers.approval, undefined);
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("slow decision asks wait for user answer instead of timing out", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "approval",
    title: "Approve?",
    questions: [
      {
        id: "approval",
        prompt: "Approve?",
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, {
    select: () => new Promise((resolve) => setTimeout(() => resolve("Approve"), 20)),
  });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.equal(isSparkAskGateBlocked(result, request), false);
});

void test("cancelled decision asks are blocking gate results", () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Continue?",
    questions: [
      {
        id: "answer",
        prompt: "Continue?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  });
  const result = createSparkAskResult({
    status: "cancelled",
    flow: request.flow,
    mode: "cancel",
    cancelled: true,
    answers: {},
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.nextAction, "block");
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("multi-select decision select path parses explicit comma-separated selections", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Choose workstreams",
    questions: [
      {
        id: "streams",
        prompt: "Which workstreams should run?",
        type: "multi",
        required: true,
        options: [
          { value: "docs", label: "Docs" },
          { value: "tests", label: "Tests" },
          { value: "runtime", label: "Runtime" },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, { select: async () => "Docs, Runtime" });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers.streams?.values, ["docs", "runtime"]);
  assert.deepEqual(result.answers.streams?.labels, ["Docs", "Runtime"]);
  assert.equal(isSparkAskGateBlocked(result, request), false);
});

void test("spark ask fullscreen option model includes direct custom input sentinel", () => {
  const options = buildExtendedOptions(
    {
      id: "target-user",
      prompt: "Who is this for?",
      type: "single",
      options: [
        { value: "self", label: "Myself" },
        { value: "team", label: "My team" },
      ],
    },
    new Map(),
  );
  assert.deepEqual(
    options.map((option) => option.kind),
    ["option", "option", "other", "chat"],
  );
  assert.equal(options[2]?.label, SENTINEL_LABELS.other);
});

void test("ask flow render keeps all lines within terminal width", () => {
  const lines = renderAskScreen({
    state: {
      currentTab: 0,
      optionIndex: 0,
      inputMode: false,
      notesVisible: false,
      chatFocused: false,
      answers: new Map(),
      multiSelectChecked: new Set(),
      notesByQuestion: new Map(),
      focusedOptionHasPreview: false,
      submitChoiceIndex: 0,
      inputDraft: "",
      notesDraft: "",
      settingsOpen: false,
    },
    questions: [
      {
        id: "decision",
        prompt: "请确认 standalone Spark 下一阶段 RFC/实现准备采用的决策 bundle。".repeat(3),
        type: "single",
        options: [
          {
            value: "accept",
            label:
              "Project-first with intake artifact；local files are source of truth；manager owns DAG".repeat(
                2,
              ),
            preview: "预览内容".repeat(100),
          },
          { value: "revise", label: "Revise" },
        ],
      },
    ],
    optionsByTab: [
      buildExtendedOptions(
        {
          id: "decision",
          prompt: "请确认 standalone Spark 下一阶段 RFC/实现准备采用的决策 bundle。".repeat(3),
          type: "single",
          options: [
            {
              value: "accept",
              label:
                "Project-first with intake artifact；local files are source of truth；manager owns DAG".repeat(
                  2,
                ),
              preview: "预览内容".repeat(100),
            },
            { value: "revise", label: "Revise" },
          ],
        },
        new Map(),
      ),
    ],
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    width: 40,
    language: "en",
    title: "Ask title".repeat(10),
  });
  assert.ok(
    lines.every((line) => visibleWidth(line) <= 40),
    lines.join("\n"),
  );
});

void test("spark ask select path exposes default custom affordance", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "clarification",
    title: "Audience",
    questions: [
      {
        id: "target-user",
        prompt: "Who is this for?",
        type: "single",
        required: true,
        options: [
          { value: "self", label: "Myself" },
          { value: "team", label: "My team" },
        ],
      },
    ],
  });
  const seenOptions: string[][] = [];
  const result = await runSparkAsk(request, {
    select: async (_title: string, options: string[]) => {
      seenOptions.push(options);
      return "My team";
    },
  });
  assert.deepEqual(seenOptions[0], ["Myself", "My team", "Type your own"]);
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers["target-user"], {
    questionId: "target-user",
    kind: "option",
    values: ["team"],
    labels: ["My team"],
    preview: undefined,
  });
});

void test("spark ask selectWithCustom keeps custom affordance out of business options", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "clarification",
    title: "Audience",
    questions: [
      {
        id: "target-user",
        prompt: "Who is this for?",
        type: "single",
        required: true,
        options: [
          { value: "self", label: "Myself" },
          { value: "team", label: "My team" },
        ],
      },
    ],
  });
  const seen: Array<{ options: string[]; customLabel: string }> = [];
  const result = await runSparkAsk(request, {
    selectWithCustom: async (_title: string, input: { options: string[]; customLabel: string }) => {
      seen.push(input);
      return { customText: "Language tooling engineers" };
    },
  });
  assert.deepEqual(seen[0], { options: ["Myself", "My team"], customLabel: "Type your own" });
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers["target-user"], {
    questionId: "target-user",
    kind: "custom",
    values: [],
    customText: "Language tooling engineers",
  });
});

void test("decision gates preserve unmatched custom text as answered but blocked", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Dispatch agents?",
    questions: [
      {
        id: "answer",
        prompt: "Dispatch agents?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, { select: async () => "maybe later" });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "block");
  assert.deepEqual(result.answers.answer, {
    questionId: "answer",
    kind: "custom",
    values: [],
    customText: "maybe later",
  });
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("multi-select decision select path blocks empty selections", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Choose workstreams",
    questions: [
      {
        id: "streams",
        prompt: "Which workstreams should run?",
        type: "multi",
        required: true,
        options: [
          { value: "docs", label: "Docs" },
          { value: "tests", label: "Tests" },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, { select: async () => "" });
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.streams, undefined);
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("spark_ask tool requires clear option descriptions", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        kind: "decision",
        question: "Dispatch agents?",
        options: [
          { id: "yes", label: "Yes", description: "Yes" },
          { id: "no", label: "No", description: "No" },
        ],
      }),
    /needs a clearer description|description must explain more/,
  );
});

void test("spark_ask tool persists decision no-selection as a blocked artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-"));
  try {
    const response = await runSparkAskTool(
      {
        kind: "decision",
        question: "Dispatch agents?",
        options: [
          { id: "yes", label: "Yes", description: "Dispatch now" },
          { id: "no", label: "No", description: "Do not dispatch" },
        ],
      },
      { cwd: dir, ui: { select: async () => undefined } },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "no_selection");
    assert.equal(response.details.blocked, true);
    assert.equal(response.details.result.nextAction, "block");
    assert.match(response.content[0]!.text, /Ask blocked \(no_selection\)/);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.equal(artifact.body.result.status, "no_selection");
    assert.equal(artifact.body.result.nextAction, "block");
    assert.equal(artifact.body.result.mode, "submit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_ask tool preserves custom decision text instead of reporting no-selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-custom-"));
  try {
    const response = await runSparkAskTool(
      {
        kind: "decision",
        question: "Dispatch agents?",
        options: [
          { id: "yes", label: "Yes", description: "Dispatch now" },
          { id: "no", label: "No", description: "Do not dispatch" },
        ],
      },
      { cwd: dir, ui: { selectWithCustom: async () => ({ customText: "先修 widget" }) } },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.equal(response.details.blocked, true);
    assert.equal(response.details.result.nextAction, "block");
    assert.equal(response.details.result.answers.answer!.values.length, 0);
    assert.equal(response.details.result.answers.answer!.customText, "先修 widget");
    assert.match(response.content[0]!.text, /Ask blocked \(answered\)/);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.equal(artifact.body.result.status, "answered");
    assert.equal(artifact.body.result.nextAction, "block");
    assert.deepEqual(artifact.body.result.answers.answer!.values, []);
    assert.equal(artifact.body.result.answers.answer!.customText, "先修 widget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_ask tool multi-select decision persists explicit selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-"));
  try {
    const response = await runSparkAskTool(
      {
        kind: "decision",
        question: "Which workstreams should run?",
        multiSelect: true,
        options: [
          { id: "docs", label: "Docs", description: "Documentation" },
          { id: "runtime", label: "Runtime", description: "Runtime fixes" },
          { id: "tests", label: "Tests", description: "Regression tests" },
        ],
      },
      { cwd: dir, ui: { select: async () => "Docs, Tests" } },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.equal(response.details.blocked, false);
    assert.deepEqual(response.details.result.answers.answer!.values, ["docs", "tests"]);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.deepEqual(artifact.body.result.answers.answer!.values, ["docs", "tests"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("replayable spark ask preserves prior selections in option descriptions", () => {
  const request = clarifyThreadAsk({
    idea: "Build a local SVG animation extension",
  });
  const elaborated = createElaborationResult(
    {
      status: "answered",
      cancelled: false,
      mode: "submit",
      flow: request.flow,
      base: {
        status: "answered",
        cancelled: false,
        answers: {
          "delivery-mode": {
            questionId: "delivery-mode",
            kind: "option" as const,
            values: ["document_and_execute"],
            labels: ["Clarification, documentation, and continued execution"],
          },
        },
      },
      answers: {
        "delivery-mode": {
          questionId: "delivery-mode",
          kind: "option" as const,
          values: ["document_and_execute"],
          labels: ["Clarification, documentation, and continued execution"],
        },
      },
      nextAction: "resume",
    },
    [
      {
        questionId: "delivery-mode",
        note: "Explain why continued execution is needed.",
      },
    ],
  );
  const replay = replayableSparkAsk(request, elaborated);
  const chosen = replay.questions
    .find((question) => question.id === "delivery-mode")
    ?.options?.find((option) => option.value === "document_and_execute");
  assert.match(chosen?.description ?? "", /Previously selected/);
});
