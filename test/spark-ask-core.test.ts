import assert from "node:assert/strict";
import test from "node:test";

import {
  createSparkAskRequest,
  createSparkAskResult,
  detectCopyLanguage,
  isSparkAskGateBlocked,
  runSparkAsk,
} from "spark-ask";

void test("Spark asks are built from caller-provided context-specific questions", () => {
  const request = createSparkAskRequest({
    flow: "svg-role-approval",
    mode: "approval",
    title: "Approve SVG role for animation planning",
    context:
      "Proposal svg-role: handles SVG animation plans; rationale: reuse a specialist for vector motion work.",
    questions: [
      {
        id: "approval",
        prompt: "Create the svg-role spec for this SVG animation planning need?",
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve", description: "Create this SVG planning role." },
          { value: "reject", label: "Reject", description: "Do not create this role." },
        ],
      },
    ],
  });
  assert.equal(request.flow, "svg-role-approval");
  assert.equal(request.questions[0]?.id, "approval");
  assert.match(request.context ?? "", /svg-role/);
});

void test("copy helpers only detect language; they do not create canned ask forms", () => {
  assert.equal(detectCopyLanguage("梳理下一步改进点"), "zh");
  assert.equal(detectCopyLanguage("Plan next work"), "en");
});

void test("approval flow without UI blocks instead of implicitly approving", async () => {
  const request = createSparkAskRequest({
    flow: "svg-role-approval",
    mode: "approval",
    title: "Approve SVG role for animation planning",
    questions: [
      {
        id: "approval",
        prompt: "Create the svg-role spec for this SVG animation planning need?",
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve", description: "Create this SVG planning role." },
          { value: "reject", label: "Reject", description: "Do not create this role." },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request);
  assert.equal(result.flow, "svg-role-approval");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.approval, undefined);
  assert.equal(isSparkAskGateBlocked(result, request), true);
});

void test("context-specific approval asks record explicit selections", async () => {
  const request = createSparkAskRequest({
    flow: "svg-role-approval",
    mode: "approval",
    title: "Approve SVG role for animation planning",
    questions: [
      {
        id: "approval",
        prompt: "Create the svg-role spec for this SVG animation planning need?",
        type: "single",
        required: true,
        options: [
          { value: "approve", label: "Approve", description: "Create this SVG planning role." },
          { value: "reject", label: "Reject", description: "Do not create this role." },
        ],
      },
    ],
  });
  const result = await runSparkAsk(request, { select: async () => "Approve" });
  assert.equal(result.flow, "svg-role-approval");
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
