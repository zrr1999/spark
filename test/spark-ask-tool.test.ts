import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ArtifactRef } from "spark-core";
import { defaultArtifactStore } from "spark-artifacts";
import {
  clarifyThreadAsk,
  createElaborationResult,
  createSparkAskToolRequest,
  replayableSparkAsk,
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
