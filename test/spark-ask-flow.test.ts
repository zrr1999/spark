import assert from "node:assert/strict";
import { visibleWidth } from "@zendev-lab/spark-tui/text";
import { test } from "vitest";

import {
  buildExtendedOptions,
  createInitialState,
  createSparkAskFlowRequest,
  isSparkAskFlowGateBlocked,
  SparkAskFlowController,
  reduce,
  renderAskScreen,
  runSparkAskFlow,
  SENTINEL_LABELS,
  validateSparkAskFlowRequest,
  normalizeAskKey,
  printableAskText,
} from "@zendev-lab/spark-ask";

test("spark ask automatically adds one custom fallback to every question type", () => {
  const businessOptions = [
    { value: "self", label: "Myself" },
    { value: "team", label: "My team" },
  ];
  const questions = [
    { id: "single", prompt: "Single?", type: "single" as const, options: businessOptions },
    { id: "multi", prompt: "Multi?", type: "multi" as const, options: businessOptions },
    { id: "preview", prompt: "Preview?", type: "preview" as const, options: businessOptions },
    { id: "freeform", prompt: "Freeform?", type: "freeform" as const },
  ];

  for (const question of questions) {
    const options = buildExtendedOptions(question, new Map());
    assert.equal(options.filter((option) => option.kind === "other").length, 1, question.type);
    assert.equal(options.at(-1)?.label, SENTINEL_LABELS.other, question.type);
    assert.equal(
      options.filter((option) => option.kind === "option").length,
      question.type === "freeform" ? 0 : businessOptions.length,
      question.type,
    );
  }
});

test("ask flow render keeps all lines within terminal width", () => {
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

test("ask flow render wraps long prompt and option copy", () => {
  const question = {
    id: "decision",
    prompt: "PROMPT_TOKEN ".repeat(12),
    type: "single" as const,
    options: [
      {
        value: "wrap",
        label: "OPTION_LABEL_TOKEN ".repeat(4),
        description: "OPTION_DESCRIPTION_TOKEN ".repeat(6),
      },
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
    width: 48,
    language: "en",
    title: "TITLE_TOKEN ".repeat(8),
    context: "CONTEXT_TOKEN ".repeat(8),
  });

  assert.ok(
    lines.every((line) => visibleWidth(line) <= 48),
    lines.join("\n"),
  );
  const rendered = lines.join("\n");
  for (const token of [
    "TITLE_TOKEN",
    "CONTEXT_TOKEN",
    "PROMPT_TOKEN",
    "OPTION_LABEL_TOKEN",
    "OPTION_DESCRIPTION_TOKEN",
  ]) {
    assert.match(rendered, new RegExp(token));
  }
  assert.ok(lines.filter((line) => line.includes("PROMPT_TOKEN")).length > 1, rendered);
  assert.ok(
    lines.filter(
      (line) => line.includes("OPTION_LABEL_TOKEN") || line.includes("OPTION_DESCRIPTION_TOKEN"),
    ).length > 1,
    rendered,
  );
});

test("ask flow defaultValues initialize recommendations without answers", () => {
  const multiQuestion = {
    id: "coverage",
    prompt: "Which outputs must be covered?",
    type: "multi" as const,
    required: true,
    defaultValues: ["ssh"],
    options: [
      { value: "ssh", label: "SSH config" },
      { value: "dns", label: "DNS output" },
    ],
  };
  const multiState = createInitialState({ questions: [multiQuestion] });
  assert.deepEqual([...multiState.multiSelectChecked], ["ssh"]);
  assert.equal(multiState.answers.size, 0);

  const multiLines = renderAskScreen({
    state: multiState,
    questions: [multiQuestion],
    optionsByTab: [buildExtendedOptions(multiQuestion, new Map())],
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      strikethrough: (text) => text,
      dim: (text) => text,
    },
    width: 80,
    language: "en",
    mode: "decision",
  });
  assert.match(multiLines.join("\n"), /☑ SSH config/);

  const submitResult = reduce(
    { ...multiState, currentTab: 1 },
    { kind: "submit" },
    {
      questions: [multiQuestion],
      optionsByTab: [buildExtendedOptions(multiQuestion, new Map())],
      mode: "decision",
    },
  );
  const done = submitResult.effects.find((effect) => effect.kind === "done");
  assert.equal(done?.kind, "done");
  if (done?.kind === "done") {
    assert.equal(done.result.status, "no_selection");
    assert.equal(done.result.nextAction, "block");
    assert.deepEqual(done.result.answers, {});
  }

  const singleQuestion = {
    ...multiQuestion,
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    defaultValues: ["dns"],
  };
  const singleState = createInitialState({ questions: [singleQuestion] });
  assert.equal(singleState.optionIndex, 1);
  assert.equal(singleState.answers.size, 0);

  const previewQuestion = {
    ...singleQuestion,
    options: [
      { value: "ssh", label: "SSH config" },
      { value: "dns", label: "DNS output", preview: "DNS preview" },
    ],
  };
  assert.equal(createInitialState({ questions: [previewQuestion] }).focusedOptionHasPreview, true);
  assert.equal(
    reduce(
      multiState,
      { kind: "jump_tab", index: 1 },
      {
        questions: [multiQuestion, previewQuestion],
        optionsByTab: [
          buildExtendedOptions(multiQuestion, new Map()),
          buildExtendedOptions(previewQuestion, new Map()),
        ],
        mode: "decision",
      },
    ).state.focusedOptionHasPreview,
    true,
  );

  const customReplayState = createInitialState({
    questions: [singleQuestion],
    priorAnswers: {
      route: {
        questionId: "route",
        kind: "custom",
        values: [],
        customText: "Use a handwritten route instead",
      },
    },
  });
  assert.equal(customReplayState.optionIndex, 2);
  assert.deepEqual(customReplayState.answers.get("route")?.values, []);

  const emptyMultiReplayState = createInitialState({
    questions: [multiQuestion],
    priorAnswers: {
      coverage: {
        questionId: "coverage",
        kind: "custom",
        values: [],
        customText: "Use a custom coverage set",
      },
    },
  });
  assert.deepEqual([...emptyMultiReplayState.multiSelectChecked], []);

  const replayState = createInitialState({
    questions: [multiQuestion],
    priorAnswers: {
      coverage: {
        questionId: "coverage",
        kind: "multi",
        values: ["dns"],
        labels: ["DNS output"],
      },
    },
  });
  assert.deepEqual([...replayState.multiSelectChecked], ["dns"]);
});

test("ask flow rejects invalid defaultValues with actionable hints", () => {
  const missingDefault = validateSparkAskFlowRequest({
    flow: "custom",
    mode: "decision",
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        type: "single",
        defaultValues: ["missing"],
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  });
  assert.equal(missingDefault.error, "invalid_default_value");
  assert.match(missingDefault.details ?? "", /defaultValues must match options\[\]\.value exactly/);
  assert.match(missingDefault.details ?? "", /valid values: fast, safe/);

  const freeformDefault = validateSparkAskFlowRequest({
    flow: "custom",
    mode: "clarification",
    questions: [
      {
        id: "notes",
        prompt: "Any notes?",
        type: "freeform",
        defaultValues: ["suggested text"],
      },
    ],
  });
  assert.equal(freeformDefault.error, "invalid_default_value");
  assert.match(freeformDefault.details ?? "", /freeform questions do not accept defaultValues/);
  assert.match(freeformDefault.details ?? "", /put suggested text in prompt\/context/);

  const singleMultiDefault = validateSparkAskFlowRequest({
    flow: "custom",
    mode: "decision",
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        type: "single",
        defaultValues: ["fast", "safe"],
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  });
  assert.equal(singleMultiDefault.error, "invalid_default_value");
  assert.match(singleMultiDefault.details ?? "", /accept at most one default value/);

  const reservedLabel = validateSparkAskFlowRequest({
    flow: "custom",
    mode: "decision",
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        type: "single",
        options: [
          { value: "other", label: "Other" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  });
  assert.equal(reservedLabel.error, "reserved_label");
  assert.match(reservedLabel.details ?? "", /reserved option labels are UI affordances/);
});

test("spark ask plain select path receives only business options", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, {
    select: async (_title: string, options: string[]) => {
      seenOptions.push(options);
      return "My team";
    },
  });
  assert.deepEqual(seenOptions[0], ["Myself", "My team"]);
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers["target-user"], {
    questionId: "target-user",
    kind: "option",
    values: ["team"],
    labels: ["My team"],
  });
});

test("single-question ask_flow custom answer blocks a required decision gate", () => {
  const request = createSparkAskFlowRequest({
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
  const controller = new SparkAskFlowController({ request, language: "en" });
  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
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

test("ask flow fullscreen keeps one custom fallback and omits chat fallback", () => {
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

test("ask flow Enter advances across questions and allows returning to edit", () => {
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
  const controller = new SparkAskFlowController({
    request: createSparkAskFlowRequest({ flow: "custom", mode: "clarification", questions }),
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

  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
  const submitting = new SparkAskFlowController({
    request: createSparkAskFlowRequest({ flow: "custom", mode: "clarification", questions }),
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

test("ask flow focused custom fallback ignores terminal escape sequences", () => {
  assert.equal(printableAskText("\x1b[1;1:1A"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1B"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1C"), undefined);
  assert.equal(printableAskText("\x1b[1;1:1D"), undefined);
  assert.equal(normalizeAskKey("\x1b[1;1:1A"), "up");
  assert.equal(normalizeAskKey("\x1b[1;1:1B"), "down");
  assert.equal(normalizeAskKey("\x1b[1;1:1C"), "right");
  assert.equal(normalizeAskKey("\x1b[1;1:1D"), "left");
});

test("ask flow focused custom fallback accepts direct typing", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      { value: "fast", label: "Fast" },
      { value: "safe", label: "Safe" },
    ],
  };
  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
  const controller = new SparkAskFlowController({
    request: createSparkAskFlowRequest({
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

test("ask flow focused custom fallback can navigate after direct typing", () => {
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
  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
  const controller = new SparkAskFlowController({
    request: createSparkAskFlowRequest({ flow: "custom", mode: "clarification", questions }),
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

test("ask flow custom draft commits with one Enter after returning to the row", () => {
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      { value: "fast", label: "Fast" },
      { value: "safe", label: "Safe" },
    ],
  };
  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
  const controller = new SparkAskFlowController({
    request: createSparkAskFlowRequest({
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

test("ask flow optional freeform can be left blank and advances", () => {
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
  let result: Awaited<ReturnType<typeof runSparkAskFlow>> | undefined;
  const controller = new SparkAskFlowController({
    request: createSparkAskFlowRequest({ flow: "custom", mode: "clarification", questions }),
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

test("ask flow accepts larger multi-question forms", () => {
  const questions = Array.from({ length: 12 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index}?`,
    type: "freeform" as const,
  }));
  assert.equal(
    validateSparkAskFlowRequest({ flow: "custom", mode: "clarification", questions }).valid,
    true,
  );
});

test("ask flow focused preview renders in a right-side pane without excessive gap", () => {
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

test("ask flow focused preview uses available side-by-side height before truncating", () => {
  const longDescription =
    "This option description is intentionally long enough to wrap in the left column and create vertical space for the preview pane.";
  const question = {
    id: "route",
    prompt: "Which route?",
    type: "single" as const,
    options: [
      {
        value: "exact",
        label: "Exact",
        description: longDescription,
        preview: Array.from({ length: 12 }, (_, index) => `preview line ${index + 1}`).join("\n"),
      },
      { value: "glob", label: "Glob patterns", description: longDescription },
      { value: "regex", label: "Regex patterns", description: longDescription },
      { value: "substring", label: "Substring matching", description: longDescription },
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

  assert.ok(
    lines.some((line) => line.includes("preview line 12")),
    lines.join("\n"),
  );
  assert.ok(!lines.some((line) => line.includes("more lines")), lines.join("\n"));
});

test("ask flow UI answer summaries use labels while structured answers keep ids", () => {
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

test("spark ask selectWithCustom keeps custom affordance out of business options", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, {
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

test("decision gates preserve unmatched custom text as a blocking answer", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, { select: async () => "maybe later" });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "block");
  assert.deepEqual(result.answers.answer, {
    questionId: "answer",
    kind: "custom",
    values: [],
    customText: "maybe later",
  });
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("a required freeform gate resumes with the operator's answer", async () => {
  const request = createSparkAskFlowRequest({
    mode: "approval",
    questions: [
      {
        id: "reason",
        prompt: "Why should execution continue?",
        type: "freeform",
        required: true,
      },
    ],
  });

  const result = await runSparkAskFlow(request, {
    input: async () => "The focused checks passed.",
  });

  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers.reason, {
    questionId: "reason",
    kind: "custom",
    values: [],
    customText: "The focused checks passed.",
  });
  assert.equal(isSparkAskFlowGateBlocked(result, request), false);
});

test("interaction custom answer preserves a blocked gate nextAction", async () => {
  const request = createSparkAskFlowRequest({
    mode: "approval",
    questions: [
      {
        id: "approval",
        prompt: "Approve the custom route?",
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve" },
          { value: "reject", label: "Reject" },
        ],
      },
    ],
  });
  const result = await runSparkAskFlow(request, {
    interaction: async (interactionRequest) => ({
      kind: "askFlow",
      requestId: interactionRequest.requestId,
      status: "answered",
      answers: {
        approval: { values: [], customText: "Approve after the migration check" },
      },
      nextAction: "block",
    }),
  });

  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "block");
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("ask flow preserves the host timeout marker on a cancelled human wait", async () => {
  const request = createSparkAskFlowRequest({
    mode: "decision",
    timeoutMs: 25,
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        type: "single",
        required: true,
        options: [
          { value: "reuse", label: "Reuse" },
          { value: "new", label: "New implementation" },
        ],
      },
    ],
  });
  let observedTimeoutMs: unknown;
  const result = await runSparkAskFlow(request, {
    interaction: async (interactionRequest) => {
      observedTimeoutMs = interactionRequest.timeoutMs;
      return {
        kind: "askFlow",
        requestId: interactionRequest.requestId,
        status: "cancelled",
        metadata: { timedOut: true },
      };
    },
  });

  assert.equal(observedTimeoutMs, 25);
  assert.equal(result.status, "cancelled");
  assert.equal(result.timedOut, true);
});

test("multi-select decision select path blocks empty selections", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, { select: async () => "" });
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.streams, undefined);
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});
