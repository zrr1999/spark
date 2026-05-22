import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ArtifactRef } from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import {
  buildExtendedOptions,
  createInitialState,
  PiAskFlowController,
  reduce,
  renderAskScreen,
  SENTINEL_LABELS,
  validatePiAskFlowRequest,
  normalizeAskKey,
  printableAskText,
} from "pi-ask";
import {
  approveRoleSpecAsk,
  createSparkAskToolRequest,
  clarifyThreadAsk,
  createElaborationResult,
  createSparkAskRequest,
  createSparkAskResult,
  isSparkAskGateBlocked,
  replayableSparkAsk,
  runSparkAsk,
  runSparkAskTool,
} from "spark-ask";

type AskArtifactBodyForTest = {
  summary?: string;
  result: {
    status: string;
    nextAction?: string;
    mode: string;
    answers: Record<string, { values: string[]; labels?: string[]; customText?: string }>;
  };
};

type SparkToolDetailsForTest = {
  status: string;
  blocked: boolean;
  artifactRef: string;
  summary: string;
  nextAction?: string;
  answers: Record<string, { values: string[]; labels?: string[]; customText?: string }>;
};

function assertSparkToolDetails(details: unknown): asserts details is SparkToolDetailsForTest {
  assert.ok(details && typeof details === "object");
  assert.equal(typeof (details as { status?: unknown }).status, "string");
  assert.equal(typeof (details as { blocked?: unknown }).blocked, "boolean");
  assert.equal(typeof (details as { artifactRef?: unknown }).artifactRef, "string");
  assert.equal(typeof (details as { summary?: unknown }).summary, "string");
  assert.ok(
    (details as { answers?: unknown }).answers &&
      typeof (details as { answers?: unknown }).answers === "object",
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
  const request = approveRoleSpecAsk({
    proposal: {
      id: "svg-role",
      description: "Handles SVG animation plans",
      systemPrompt: "You are a SVG planner.",
      rationale: "Need a reusable specialist",
      expectedUses: ["svg planning"],
    },
  });
  const result = await runSparkAsk(request);
  assert.equal(result.flow, "approve-role-spec");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.approval, undefined);
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("approve-role-spec flow records explicit approval selections", async () => {
  const request = approveRoleSpecAsk({
    proposal: {
      id: "svg-role",
      description: "Handles SVG animation plans",
      systemPrompt: "You are a SVG planner.",
      rationale: "Need a reusable specialist",
      expectedUses: ["svg planning"],
    },
  });
  const result = await runSparkAsk(request, { select: async () => "Approve" });
  assert.equal(result.flow, "approve-role-spec");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.equal(result.answers.approval?.values[0], "approve");
});

void test("decision/approval asks expose no-selection as a blocking result envelope", async () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Dispatch roles?",
    questions: [
      {
        id: "answer",
        prompt: "Dispatch roles?",
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
    title: "Dispatch roles?",
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
        prompt: "Dispatch roles now?",
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

void test("spark ask fullscreen option model includes only the direct custom input sentinel", () => {
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
    ["option", "option", "other"],
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
      answers: new Map(),
      multiSelectChecked: new Set(),
      notesByQuestion: new Map(),
      focusedOptionHasPreview: false,
      submitChoiceIndex: 0,
      inputDraft: "",
      customDraftsByQuestion: new Map(),
      notesDraft: "",
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
  });
});

void test("single-question ask_flow submit preserves custom answers but blocks decision gates", () => {
  const request = createSparkAskRequest({
    flow: "custom",
    mode: "decision",
    title: "Dispatch roles?",
    questions: [
      {
        id: "answer",
        prompt: "Dispatch roles?",
        type: "single",
        required: true,
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    ],
  });
  const controller = new PiAskFlowController({ request, language: "en" });
  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  controller.run(
    { terminal: { columns: 100 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );

  assert.equal(controller.handleKey("down", {}), true);
  assert.equal(controller.handleKey("down", {}), true);
  assert.equal(controller.handleKey("enter", {}), true);
  assert.equal(controller.handleText("maybe later"), true);
  assert.equal(controller.handleKey("enter", {}), true);
  assert.equal(controller.handleKey("enter", {}), true);

  assert.equal(result?.status, "answered");
  assert.equal(result?.nextAction, "block");
  assert.deepEqual(result?.answers.answer, {
    questionId: "answer",
    kind: "custom",
    values: [],
    customText: "maybe later",
  });
});

void test("ask flow fullscreen keeps one custom fallback and omits chat fallback", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      { value: "fast", label: "Fast", description: "Use the faster implementation path." },
      { value: "safe", label: "Safe", description: "Use the safer implementation path." },
    ],
  };
  const options = buildExtendedOptions(question, new Map());
  assert.deepEqual(
    options.map((option) => option.kind),
    ["option", "option", "other"],
  );

  const lines = renderAskScreen({
    state: createInitialState({ questions: [question] }),
    questions: [question],
    optionsByTab: [options],
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    width: 120,
    language: "en",
    title: "Route ask",
  }).join("\n");
  assert.match(lines, /○ Type your own/);
  assert.doesNotMatch(lines, /… Type your own/);
  assert.doesNotMatch(lines, /Chat about this/);
});

void test("ask flow Enter advances across questions and allows returning to edit", () => {
  const questions = [
    {
      id: "route",
      prompt: "Which route?",
      type: "single" as const,
      options: [
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ],
    },
    {
      id: "scope",
      prompt: "Which scope?",
      type: "single" as const,
      options: [
        { value: "docs", label: "Docs" },
        { value: "tests", label: "Tests" },
      ],
    },
  ];
  const controller = new PiAskFlowController({
    request: createSparkAskRequest({ flow: "custom", mode: "clarification", questions }),
    language: "en",
  });
  const component = controller.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    () => undefined,
  );

  assert.equal(controller.handleKey("enter", {}), true);
  assert.match(component.render().join("\n"), /\[Question 2\]/);
  assert.equal(controller.handleKey("ctrl+s", {}), true);
  assert.match(component.render().join("\n"), /\[Review\]/);
  assert.equal(controller.handleKey("left", {}), true);
  assert.match(component.render().join("\n"), /\[Question 2\]/);
  assert.equal(controller.handleKey("left", {}), true);
  assert.equal(controller.handleKey("down", {}), true);
  assert.equal(controller.handleKey("enter", {}), true);
  assert.equal(controller.handleKey("ctrl+s", {}), true);

  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  const submitting = new PiAskFlowController({
    request: createSparkAskRequest({ flow: "custom", mode: "clarification", questions }),
    language: "en",
  });
  submitting.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );
  submitting.handleKey("enter", {});
  submitting.handleKey("left", {});
  submitting.handleKey("down", {});
  submitting.handleKey("enter", {});
  submitting.handleKey("enter", {});
  submitting.handleKey("ctrl+s", {});
  submitting.handleKey("enter", {});
  assert.deepEqual(result?.answers.route.values, ["safe"]);
  assert.deepEqual(result?.answers.scope.values, ["docs"]);
});

void test("ask flow focused custom fallback ignores terminal escape sequences", () => {
  assert.equal(printableAskText("\x1b[1;1:1A"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1B"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1C"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1D"), undefined);
  assert.equal(normalizeAskKey("\x1b[1;1:1A"), "up");
  assert.equal(normalizeAskKey("\x1b[1;1:1B"), "down");
  assert.equal(normalizeAskKey("\x1b[1;1:1C"), "right");
  assert.equal(normalizeAskKey("\x1b[1;1:1D"), "left");
});

void test("ask flow focused custom fallback accepts direct typing", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      { value: "fast", label: "Fast" },
      { value: "safe", label: "Safe" },
    ],
  };
  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  const controller = new PiAskFlowController({
    request: createSparkAskRequest({
      flow: "custom",
      mode: "clarification",
      questions: [question],
    }),
    language: "en",
  });
  const component = controller.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );

  assert.equal(controller.handleKey("down", {}), true);
  assert.equal(controller.handleKey("down", {}), true);
  component.handleInput("later");
  assert.match(component.render().join("\n"), /Type your own: later/);
  assert.equal(controller.handleKey("enter", {}), true);
  assert.equal(controller.handleKey("enter", {}), true);

  assert.deepEqual(result?.answers.route, {
    questionId: "route",
    kind: "custom",
    values: [],
    customText: "later",
  });
});

void test("ask flow focused custom fallback can navigate after direct typing", () => {
  const questions = [
    {
      id: "route",
      prompt: "Which route?",
      type: "single" as const,
      options: [
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ],
    },
    {
      id: "scope",
      prompt: "Which scope?",
      type: "single" as const,
      options: [
        { value: "docs", label: "Docs" },
        { value: "tests", label: "Tests" },
      ],
    },
  ];
  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  const controller = new PiAskFlowController({
    request: createSparkAskRequest({ flow: "custom", mode: "clarification", questions }),
    language: "en",
  });
  const component = controller.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );

  component.handleInput("down");
  component.handleInput("down");
  component.handleInput("x");
  assert.match(component.render().join("\n"), /Type your own: x/);
  component.handleInput("\x1b[1;1:1B");
  assert.doesNotMatch(component.render().join("\n"), /\\x1b/);
  component.handleInput("\x1b[1;1:1C");
  assert.match(component.render().join("\n"), /\[Question 2\]/);
  component.handleInput("\x1b[1;1:1D");
  assert.match(component.render().join("\n"), /Type your own: x/);
  component.handleInput("\x1b[1;1:1A");
  assert.doesNotMatch(component.render().join("\n"), /"x"/);
  component.handleInput("\r");
  component.handleInput("\r");
  component.handleInput("\r");
  assert.deepEqual(result?.answers.route, {
    questionId: "route",
    kind: "option",
    values: ["fast"],
    labels: ["Fast"],
    preview: undefined,
  });
});

void test("ask flow custom draft commits with one Enter after returning to the row", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      { value: "fast", label: "Fast" },
      { value: "safe", label: "Safe" },
    ],
  };
  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  const controller = new PiAskFlowController({
    request: createSparkAskRequest({
      flow: "custom",
      mode: "clarification",
      questions: [question],
    }),
    language: "en",
  });
  const component = controller.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );

  component.handleInput("down");
  component.handleInput("down");
  component.handleInput("later");
  component.handleInput("\x1b[1;1:1A");
  component.handleInput("\x1b[1;1:1B");
  assert.match(component.render().join("\n"), /Type your own: later/);
  component.handleInput("\r");
  assert.match(component.render().join("\n"), /\[Review\]/);
  component.handleInput("\x1b[1;1:1D");
  assert.match(component.render().join("\n"), /● Type your own: later/);
  component.handleInput("\x1b[1;1:1C");
  component.handleInput("\r");

  assert.deepEqual(result?.answers.route, {
    questionId: "route",
    kind: "custom",
    values: [],
    customText: "later",
  });
});

void test("ask flow optional freeform can be left blank and advances", () => {
  const questions = [
    {
      id: "notes",
      prompt: "Any notes?",
      type: "freeform" as const,
      required: false,
    },
    {
      id: "route",
      prompt: "Which route?",
      type: "single" as const,
      options: [
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ],
    },
  ];
  let result: Awaited<ReturnType<typeof runSparkAsk>> | undefined;
  const controller = new PiAskFlowController({
    request: createSparkAskRequest({ flow: "custom", mode: "clarification", questions }),
    language: "en",
  });
  const component = controller.run(
    { terminal: { columns: 120 }, requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    (flowResult) => {
      result = flowResult;
    },
  );

  component.handleInput("down");
  component.handleInput("\r");
  assert.match(component.render().join("\n"), /\[Question 2\]/);
  component.handleInput("\r");
  component.handleInput("\r");

  assert.deepEqual(result?.answers.notes, {
    questionId: "notes",
    kind: "skipped",
    values: [],
  });
  assert.deepEqual(result?.answers.route.values, ["fast"]);
});

void test("ask flow accepts larger multi-question forms", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index}?`,
    type: "freeform" as const,
  }));
  assert.equal(
    validatePiAskFlowRequest({ flow: "custom", mode: "clarification", questions }).valid,
    true,
  );
});

void test("ask flow focused preview renders in a right-side pane without excessive gap", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      {
        value: "fast",
        label: "Fast",
        description: "Use the faster path.",
        preview:
          "Preview detail on the right side that should wrap across multiple lines instead of being truncated after one long row.",
      },
      { value: "safe", label: "Safe", description: "Use the safer path." },
    ],
  };
  const lines = renderAskScreen({
    state: createInitialState({ questions: [question] }),
    questions: [question],
    optionsByTab: [buildExtendedOptions(question, new Map())],
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    width: 120,
    language: "en",
    title: "Route ask",
  });
  const previewLineIndex = lines.findIndex((line) => line.includes("Preview"));
  const optionLineIndex = lines.findIndex((line) => line.includes("▶ ○ Fast"));
  assert.equal(previewLineIndex, optionLineIndex);
  assert.match(lines[optionLineIndex]!, /▶ ○ Fast.*┌─ Preview/);
  assert.ok(
    lines.some((line) => line.includes("that should wrap across multiple")) &&
      lines.some((line) => line.includes("lines instead of being truncated")),
    lines.join("\n"),
  );
  const gap =
    lines[optionLineIndex]!.indexOf("┌─ Preview") -
    lines[optionLineIndex]!.indexOf("Use the faster path.");
  assert.ok(gap > 0 && gap < 48, lines[optionLineIndex]);
});

void test("ask flow UI answer summaries use labels while structured answers keep ids", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      {
        value: "fast_route_id",
        label: "Fast route",
        description: "Take the shortest validation route with fewer checks.",
      },
      {
        value: "safe_route_id",
        label: "Safe route",
        description: "Take the safer validation route with additional checks.",
      },
    ],
  };
  const options = buildExtendedOptions(question, new Map());
  let state = createInitialState({ questions: [question] });
  state = {
    ...reduce(
      { ...state, optionIndex: 1 },
      { kind: "select_option" },
      {
        questions: [question],
        optionsByTab: [options],
      },
    ).state,
    currentTab: 0,
    optionIndex: 1,
  };
  assert.deepEqual(state.answers.get("route")?.values, ["safe_route_id"]);
  assert.deepEqual(state.answers.get("route")?.labels, ["Safe route"]);

  const lines = renderAskScreen({
    state,
    questions: [question],
    optionsByTab: [options],
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    width: 120,
    language: "en",
    title: "Route ask",
  }).join("\n");
  assert.match(lines, /Safe route/);
  assert.match(lines, /Take the safer validation route with additional checks/);
  assert.doesNotMatch(lines, /safe_route_id/);
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
    title: "Dispatch roles?",
    questions: [
      {
        id: "answer",
        prompt: "Dispatch roles?",
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

void test("spark_ask tool builds flow-native multi-question forms", () => {
  const request = createSparkAskToolRequest({
    mode: "decision",
    title: "Plan next ask work",
    context: "Choose scope and capture notes in one form.",
    flow: "ask-work-plan",
    questions: [
      {
        id: "scope",
        prompt: "Which scope should run next?",
        type: "single",
        required: true,
        options: [
          {
            id: "tool",
            label: "Tool schema",
            description: "Implement the unified spark_ask tool schema.",
          },
          {
            id: "docs",
            label: "Docs",
            description: "Document the unified spark_ask form contract.",
          },
        ],
      },
      {
        id: "notes",
        prompt: "Any implementation notes?",
        type: "freeform",
      },
    ],
  });

  assert.equal(request.flow, "ask-work-plan");
  assert.equal(request.mode, "decision");
  assert.equal(request.title, "Plan next ask work");
  assert.equal(request.questions.length, 2);
  assert.deepEqual(
    request.questions[0]!.options?.map((option) => option.value),
    ["tool", "docs"],
  );
  assert.equal(request.questions[1]!.type, "freeform");
});

void test("spark_ask tool uses fullscreen ask flow when custom UI is available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-fullscreen-"));
  try {
    let rendered = "";
    const response = await runSparkAskTool(
      {
        mode: "clarification",
        title: "Choose workstreams",
        questions: [
          {
            id: "features",
            prompt: "Which features should be covered?",
            type: "multi",
            required: true,
            options: [
              { id: "single", label: "Single", description: "Cover single select questions." },
              { id: "multi", label: "Multi", description: "Cover multi select questions." },
              { id: "freeform", label: "Freeform", description: "Cover custom text answers." },
            ],
          },
        ],
      },
      {
        cwd: dir,
        ui: {
          custom: async (...args: unknown[]) => {
            const factory = args[0] as Function;
            let component: { render(width: number): string[]; handleInput(data: string): void };
            component = factory(
              { terminal: { columns: 120 }, requestRender() {} },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
                strikethrough: (text: string) => text,
                dim: (text: string) => text,
              },
              {},
              () => undefined,
            );
            rendered = component.render(120).join("\n");
            component.handleInput(" ");
            component.handleInput("down");
            component.handleInput(" ");
            component.handleInput("enter");
            component.handleInput("ctrl+s");
            component.handleInput("enter");
          },
        },
      },
    );

    assert.match(rendered, /multi-select/);
    assert.match(rendered, /☐ Single/);
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.deepEqual(response.details.answers.features!.values, ["single", "multi"]);
    assert.deepEqual(response.details.answers.features!.labels, ["Single", "Multi"]);
    assert.match(response.content[0]!.text, /features=Single, Multi/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_ask tool persists multi-question answers in one artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-flow-"));
  try {
    const response = await runSparkAskTool(
      {
        mode: "decision",
        title: "Plan next ask work",
        questions: [
          {
            id: "scope",
            prompt: "Which scope should run next?",
            type: "single",
            required: true,
            options: [
              {
                id: "tool",
                label: "Tool schema",
                description: "Implement the unified spark_ask tool schema.",
              },
              {
                id: "docs",
                label: "Docs",
                description: "Document the unified spark_ask form contract.",
              },
            ],
          },
          {
            id: "notes",
            prompt: "Any implementation notes?",
            type: "freeform",
          },
        ],
      },
      {
        cwd: dir,
        ui: {
          select: async () => "Tool schema",
          input: async () => "Keep specialized wrappers as compat only.",
        },
      },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.equal(response.details.blocked, false);
    assert.equal("request" in response.details, false);
    assert.equal("result" in response.details, false);
    assert.deepEqual(response.details.answers.scope!.values, ["tool"]);
    assert.equal(
      response.details.answers.notes!.customText,
      "Keep specialized wrappers as compat only.",
    );
    assert.match(
      response.content[0]!.text,
      /Plan next ask work: answered; scope=Tool schema; notes=Keep specialized wrappers as compat only\./,
    );

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.equal(
      artifact.body.summary,
      "Plan next ask work: answered; scope=Tool schema; notes=Keep specialized wrappers as compat only.",
    );
    assert.equal(artifact.body.result.status, "answered");
    assert.deepEqual(artifact.body.result.answers.scope!.values, ["tool"]);
    assert.equal(
      artifact.body.result.answers.notes!.customText,
      "Keep specialized wrappers as compat only.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark_ask tool validates option descriptions for every question", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Plan next ask work",
        questions: [
          {
            id: "scope",
            prompt: "Which scope should run next?",
            type: "single",
            options: [
              { id: "tool", label: "Tool schema", description: "Tool schema" },
              { id: "docs", label: "Docs", description: "Docs" },
            ],
          },
        ],
      }),
    /needs a clearer description|description must explain more/,
  );
});

void test("spark_ask tool requires clear option descriptions", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        kind: "decision",
        question: "Dispatch roles?",
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
        question: "Dispatch roles?",
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
    assert.equal(response.details.nextAction, "block");
    assert.match(response.content[0]!.text, /Dispatch roles\? blocked: no_selection; no selection/);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.match(
      artifact.body.summary ?? "",
      /Dispatch roles\? blocked: no_selection; no selection/,
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
        question: "Dispatch roles?",
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
    assert.equal(response.details.nextAction, "block");
    assert.equal(response.details.answers.answer!.values.length, 0);
    assert.equal(response.details.answers.answer!.customText, "先修 widget");
    assert.match(response.content[0]!.text, /Dispatch roles\? blocked: answered; 先修 widget/);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.match(artifact.body.summary ?? "", /Dispatch roles\? blocked: answered; 先修 widget/);
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
    assert.deepEqual(response.details.answers.answer!.values, ["docs", "tests"]);
    assert.deepEqual(response.details.answers.answer!.labels, ["Docs", "Tests"]);
    assert.match(
      response.content[0]!.text,
      /Which workstreams should run\?: answered; Docs, Tests/,
    );
    assert.doesNotMatch(response.content[0]!.text, /docs, tests/);

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
