import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ArtifactRef } from "@zendev-lab/pi-extension-api";
import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import {
  createElaborationResult,
  createPiAskFlowRequest,
  replayablePiAskFlow,
} from "@zendev-lab/pi-ask";
import {
  createSparkAskToolRequest,
  runSparkAskTool,
} from "../packages/spark/src/extension/spark-ask-tool.ts";

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

void test("impl_ask tool builds flow-native multi-question forms", () => {
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
        defaultValues: ["docs"],
        options: [
          {
            id: "tool",
            label: "Tool schema",
            description: "Implement the unified impl_ask tool schema.",
          },
          {
            id: "docs",
            label: "Docs",
            description: "Document the unified impl_ask form contract.",
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
  assert.deepEqual(request.questions[0]!.defaultValues, ["docs"]);
  assert.equal(request.questions[1]!.type, "freeform");
});

void test("impl_ask tool requires explicit questions", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [],
      }),
    /requires a non-empty questions\[\] array/,
  );
});

void test("impl_ask tool requires a context-specific title", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        questions: [
          {
            id: "route",
            prompt: "Which route?",
            options: [
              {
                id: "fast",
                label: "Fast",
                description: "Choose the faster route with less validation.",
              },
              {
                id: "safe",
                label: "Safe",
                description: "Choose the safer route with more validation.",
              },
            ],
          },
        ],
      }),
    /requires a context-specific title/,
  );
});

void test("impl_ask tool rejects invalid explicit parameter shapes", () => {
  const validOption = {
    id: "safe",
    label: "Safe",
    description: "Choose the safer route with more validation.",
  };
  const otherOption = {
    id: "fast",
    label: "Fast",
    description: "Choose the faster route with less validation.",
  };

  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "survey",
        title: "Choose route",
        questions: [{ id: "route", prompt: "Which route?", options: [validOption, otherOption] }],
      }),
    /mode must be clarification, decision, approval, or unblock/,
  );
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [
          {
            id: "route",
            prompt: "Which route?",
            type: "dropdown" as never,
            options: [validOption, otherOption],
          },
        ],
      }),
    /question route type must be single, multi, preview, or freeform/,
  );
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [
          {
            id: "route",
            prompt: "Which route?",
            required: "true" as never,
            options: [validOption, otherOption],
          },
        ],
      }),
    /question route required must be a boolean/,
  );
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [
          {
            id: "route",
            prompt: "Which route?",
            defaultValues: ["safe", 1 as never],
            options: [validOption, otherOption],
          },
        ],
      }),
    /question route defaultValues must be a string array/,
  );
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [
          {
            id: "notes",
            prompt: "Any notes?",
            type: "freeform",
            options: [validOption, otherOption],
          },
        ],
      }),
    /freeform questions must not include options/,
  );
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Choose route",
        questions: [{ id: "route", prompt: "Which route?", options: [validOption, otherOption] }],
        behaviour: { preservePriorAnswers: "true" as never },
      }),
    /behaviour\.preservePriorAnswers must be a boolean/,
  );
});

void test("impl_ask question defaultValues are preserved", () => {
  const request = createSparkAskToolRequest({
    mode: "decision",
    title: "Choose route",
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        defaultValues: ["safe"],
        options: [
          {
            id: "fast",
            label: "Fast",
            description: "Choose the faster route with less validation.",
          },
          {
            id: "safe",
            label: "Safe",
            description: "Choose the safer route with more validation.",
          },
        ],
      },
    ],
  });

  assert.deepEqual(request.questions[0]!.defaultValues, ["safe"]);
});

void test("impl_ask tool uses fullscreen ask flow when custom UI is available", async () => {
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

void test("impl_ask tool persists multi-question answers in one artifact", async () => {
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
                description: "Implement the unified impl_ask tool schema.",
              },
              {
                id: "docs",
                label: "Docs",
                description: "Document the unified impl_ask form contract.",
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

void test("impl_ask tool validates option descriptions for every question", () => {
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

void test("impl_ask tool requires clear option descriptions", () => {
  assert.throws(
    () =>
      createSparkAskToolRequest({
        mode: "decision",
        title: "Dispatch roles?",
        questions: [
          {
            id: "dispatch",
            prompt: "Dispatch roles?",
            options: [
              { id: "yes", label: "Yes", description: "Yes" },
              { id: "no", label: "No", description: "No" },
            ],
          },
        ],
      }),
    /needs a clearer description|description must explain more/,
  );
});

void test("impl_ask tool persists decision no-selection as a blocked artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-"));
  try {
    const response = await runSparkAskTool(
      {
        mode: "decision",
        title: "Dispatch roles?",
        questions: [
          {
            id: "dispatch",
            prompt: "Dispatch roles?",
            required: true,
            options: [
              { id: "yes", label: "Yes", description: "Dispatch now" },
              { id: "no", label: "No", description: "Do not dispatch" },
            ],
          },
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

void test("impl_ask tool preserves custom decision text instead of reporting no-selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-custom-"));
  try {
    const response = await runSparkAskTool(
      {
        mode: "decision",
        title: "Dispatch roles?",
        questions: [
          {
            id: "dispatch",
            prompt: "Dispatch roles?",
            required: true,
            options: [
              { id: "yes", label: "Yes", description: "Dispatch now" },
              { id: "no", label: "No", description: "Do not dispatch" },
            ],
          },
        ],
      },
      { cwd: dir, ui: { selectWithCustom: async () => ({ customText: "先修 widget" }) } },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.equal(response.details.blocked, true);
    assert.equal(response.details.nextAction, "block");
    assert.equal(response.details.answers.dispatch!.values.length, 0);
    assert.equal(response.details.answers.dispatch!.customText, "先修 widget");
    assert.match(
      response.content[0]!.text,
      /Dispatch roles\? blocked: answered; dispatch=先修 widget; next=block/,
    );

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.match(
      artifact.body.summary ?? "",
      /Dispatch roles\? blocked: answered; dispatch=先修 widget; next=block/,
    );
    assert.equal(artifact.body.result.status, "answered");
    assert.equal(artifact.body.result.nextAction, "block");
    assert.deepEqual(artifact.body.result.answers.dispatch!.values, []);
    assert.equal(artifact.body.result.answers.dispatch!.customText, "先修 widget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("impl_ask tool multi-select decision persists explicit selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-ask-tool-"));
  try {
    const response = await runSparkAskTool(
      {
        mode: "decision",
        title: "Which workstreams should run?",
        questions: [
          {
            id: "workstreams",
            prompt: "Which workstreams should run?",
            type: "multi",
            options: [
              { id: "docs", label: "Docs", description: "Documentation" },
              { id: "runtime", label: "Runtime", description: "Runtime fixes" },
              { id: "tests", label: "Tests", description: "Regression tests" },
            ],
          },
        ],
      },
      { cwd: dir, ui: { select: async () => "Docs, Tests" } },
    );
    assertSparkToolDetails(response.details);
    assert.equal(response.details.status, "answered");
    assert.equal(response.details.blocked, false);
    assert.deepEqual(response.details.answers.workstreams!.values, ["docs", "tests"]);
    assert.deepEqual(response.details.answers.workstreams!.labels, ["Docs", "Tests"]);
    assert.match(
      response.content[0]!.text,
      /Which workstreams should run\?: answered; workstreams=Docs, Tests/,
    );
    assert.doesNotMatch(response.content[0]!.text, /docs, tests/);

    const artifact = await defaultArtifactStore(dir).get<AskArtifactBodyForTest>(
      response.details.artifactRef as ArtifactRef,
    );
    assert.deepEqual(artifact.body.result.answers.workstreams!.values, ["docs", "tests"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("replayable spark ask preserves prior selections in option descriptions", () => {
  const request = createPiAskFlowRequest({
    flow: "svg-animation-delivery",
    mode: "decision",
    title: "Choose SVG animation delivery mode",
    context: "Build a local SVG animation extension.",
    questions: [
      {
        id: "delivery-mode",
        prompt: "Which delivery mode should this SVG animation extension use?",
        type: "single",
        required: true,
        options: [
          {
            value: "document_and_execute",
            label: "Clarification, documentation, and continued execution",
            description: "Confirm scope, record decisions, and continue with implementation.",
          },
          {
            value: "clarify_only",
            label: "Clarification only",
            description: "Confirm the SVG animation extension scope and stop there.",
          },
        ],
      },
    ],
    behaviour: { preservePriorAnswers: true },
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
  const replay = replayablePiAskFlow(request, elaborated);
  const chosen = replay.questions
    .find((question) => question.id === "delivery-mode")
    ?.options?.find((option) => option.value === "document_and_execute");
  assert.match(chosen?.description ?? "", /Previously selected/);
});
