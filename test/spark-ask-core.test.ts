import assert from "node:assert/strict";
import { test } from "vitest";

import {
  askUser,
  createSparkAskFlowRequest,
  createSparkAskFlowResult,
  isSparkAskFlowGateBlocked,
  runSparkAskFlow,
} from "@zendev-lab/spark-ask";
import { detectCopyLanguage } from "@zendev-lab/spark-core";

test("Spark asks are built from caller-provided context-specific questions", () => {
  const request = createSparkAskFlowRequest({
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

test("copy helpers only detect language; they do not create canned ask forms", () => {
  assert.equal(detectCopyLanguage("梳理下一步改进点"), "zh");
  assert.equal(detectCopyLanguage("Plan next work"), "en");
});

test("approval flow without UI blocks instead of implicitly approving", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request);
  assert.equal(result.flow, "svg-role-approval");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "no_selection");
  assert.equal(result.nextAction, "block");
  assert.equal(result.answers.approval, undefined);
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("context-specific approval asks record explicit selections", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, { select: async () => "Approve" });
  assert.equal(result.flow, "svg-role-approval");
  assert.equal(result.mode, "submit");
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.equal(result.answers.approval?.values[0], "approve");
});

test("ask_user prefers protocol interaction answers before legacy selectors", async () => {
  let fallbackSelectCalls = 0;
  const result = await askUser(
    {
      mode: "decision",
      title: "Choose protocol route",
      questions: [
        {
          id: "route",
          prompt: "Which route?",
          type: "single",
          required: true,
          options: [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ],
        },
      ],
    },
    {
      interaction: async (request) => {
        assert.equal(request.kind, "askFlow");
        assert.equal(request.metadata?.tool, "ask_user");
        assert.equal((request.questions as Array<{ id: string }>)[0]?.id, "route");
        return {
          kind: "askFlow",
          requestId: request.requestId,
          status: "answered",
          answers: { route: "safe" },
        };
      },
      select: async () => {
        fallbackSelectCalls += 1;
        return "Fast";
      },
    },
  );

  assert.equal(fallbackSelectCalls, 0);
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers.route?.values, ["safe"]);
  assert.deepEqual(result.answers.route?.labels, ["Safe"]);
});

test("async ask_user returns a durable pending handle without invoking legacy UI", async () => {
  let fallbackSelectCalls = 0;
  const result = await askUser(
    {
      delivery: "async",
      mode: "decision",
      title: "Choose later",
      questions: [
        {
          id: "route",
          prompt: "Which route?",
          type: "single",
          required: true,
          options: [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ],
        },
      ],
    },
    {
      interaction: async (request) => {
        assert.equal(request.delivery, "async");
        return {
          kind: "askFlow",
          requestId: request.requestId,
          humanRequestId: "hreq_async",
          status: "pending",
        };
      },
      select: async () => {
        fallbackSelectCalls += 1;
        return "Fast";
      },
    },
  );

  assert.equal(fallbackSelectCalls, 0);
  assert.equal(result.status, "pending");
  assert.equal(result.humanRequestId, "hreq_async");
  assert.equal(result.nextAction, "resume");
});

test("blocking ask_user keeps the interaction pending until the daemon answers", async () => {
  let resolveInteraction!: (value: {
    kind: "askFlow";
    requestId: string;
    status: "answered";
    answers: { route: string };
  }) => void;
  let requestId = "";
  const interaction = new Promise<{
    kind: "askFlow";
    requestId: string;
    status: "answered";
    answers: { route: string };
  }>((resolve) => {
    resolveInteraction = resolve;
  });
  const resultPromise = askUser(
    {
      delivery: "blocking",
      title: "Choose now",
      questions: [
        {
          id: "route",
          prompt: "Which route?",
          type: "single",
          options: [{ value: "safe", label: "Safe" }],
        },
      ],
    },
    {
      interaction: async (request) => {
        assert.equal(request.delivery, "blocking");
        requestId = request.requestId;
        return await interaction;
      },
    },
  );

  let settled = false;
  void resultPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  resolveInteraction({
    kind: "askFlow",
    requestId,
    status: "answered",
    answers: { route: "safe" },
  });
  const result = await resultPromise;
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers.route?.values, ["safe"]);
});

test("ask_user falls back to legacy selectors when protocol interaction is blocked", async () => {
  let fallbackSelectCalls = 0;
  const result = await askUser(
    {
      mode: "decision",
      title: "Choose fallback route",
      questions: [
        {
          id: "route",
          prompt: "Which route?",
          type: "single",
          required: true,
          options: [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ],
        },
      ],
    },
    {
      interaction: async (request) => ({
        kind: "askFlow",
        requestId: request.requestId,
        status: "blocked",
        message: "no protocol renderer installed",
      }),
      select: async () => {
        fallbackSelectCalls += 1;
        return "Safe";
      },
    },
  );

  assert.equal(fallbackSelectCalls, 1);
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers.route?.values, ["safe"]);
});

test("ask_user converts protocol interaction failures into cancelled gate results", async () => {
  let fallbackSelectCalls = 0;
  const warnings: string[] = [];
  const result = await askUser(
    {
      mode: "approval",
      title: "Approve failing route?",
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
    },
    {
      interaction: async () => {
        throw new Error("renderer crashed");
      },
      select: async () => {
        fallbackSelectCalls += 1;
        return "Approve";
      },
      notify: (message, level) => {
        if (level === "warning") warnings.push(message);
      },
    },
  );

  assert.equal(fallbackSelectCalls, 0);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.nextAction, "block");
  assert.match(warnings[0] ?? "", /renderer crashed/);
});

test("ask_flow uses protocol interaction answers and blocked fallback selectors", async () => {
  const request = createSparkAskFlowRequest({
    flow: "protocol-route",
    mode: "decision",
    title: "Choose protocol route",
    questions: [
      {
        id: "route",
        prompt: "Which route?",
        type: "single",
        required: true,
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      },
    ],
  });

  const protocolResult = await runSparkAskFlow(request, {
    interaction: async (protocolRequest) => {
      assert.equal(protocolRequest.kind, "askFlow");
      assert.equal(protocolRequest.metadata?.tool, "ask_flow");
      assert.equal(protocolRequest.flow, "protocol-route");
      return {
        kind: "askFlow",
        requestId: protocolRequest.requestId,
        status: "answered",
        answers: { route: { values: ["safe"] } },
      };
    },
    select: async () => "Fast",
  });
  assert.equal(protocolResult.status, "answered");
  assert.equal(protocolResult.nextAction, "resume");
  assert.deepEqual(protocolResult.answers.route?.values, ["safe"]);

  let fallbackSelectCalls = 0;
  const fallbackResult = await runSparkAskFlow(request, {
    interaction: async (protocolRequest) => ({
      kind: "askFlow",
      requestId: protocolRequest.requestId,
      status: "blocked",
      message: "no renderer",
    }),
    select: async () => {
      fallbackSelectCalls += 1;
      return "Fast";
    },
  });
  assert.equal(fallbackSelectCalls, 1);
  assert.equal(fallbackResult.status, "answered");
  assert.deepEqual(fallbackResult.answers.route?.values, ["fast"]);
});

test("async ask_flow returns pending and does not block approval gates", async () => {
  const request = createSparkAskFlowRequest({
    delivery: "async",
    flow: "async-approval",
    mode: "approval",
    title: "Approve later",
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
  const result = await runSparkAskFlow(request, {
    interaction: async (protocolRequest) => {
      assert.equal(protocolRequest.delivery, "async");
      return {
        kind: "askFlow",
        requestId: protocolRequest.requestId,
        humanRequestId: "hreq_flow_async",
        status: "pending",
      };
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.humanRequestId, "hreq_flow_async");
  assert.equal(result.nextAction, "resume");
  assert.equal(isSparkAskFlowGateBlocked(result, request), false);
});

test("decision/approval asks expose no-selection as a blocking result envelope", async () => {
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
  const result = await runSparkAskFlow(request, { select: async () => undefined });
  assert.equal(result.status, "no_selection");
  assert.equal(result.cancelled, false);
  assert.equal(result.nextAction, "block");
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("partial decision asks block when a later required selection is missing", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, {
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
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("slow decision asks wait for user answer instead of timing out", async () => {
  const request = createSparkAskFlowRequest({
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
  const result = await runSparkAskFlow(request, {
    select: () => new Promise((resolve) => setTimeout(() => resolve("Approve"), 20)),
  });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.equal(isSparkAskFlowGateBlocked(result, request), false);
});

test("cancelled decision asks are blocking gate results", () => {
  const request = createSparkAskFlowRequest({
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
  const result = createSparkAskFlowResult({
    status: "cancelled",
    flow: request.flow,
    mode: "cancel",
    cancelled: true,
    answers: {},
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.nextAction, "block");
  assert.equal(isSparkAskFlowGateBlocked(result, request), true);
});

test("multi-select decision select path parses explicit comma-separated selections", async () => {
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
          { value: "runtime", label: "Runtime" },
        ],
      },
    ],
  });
  const result = await runSparkAskFlow(request, { select: async () => "Docs, Runtime" });
  assert.equal(result.status, "answered");
  assert.equal(result.nextAction, "resume");
  assert.deepEqual(result.answers.streams?.values, ["docs", "runtime"]);
  assert.deepEqual(result.answers.streams?.labels, ["Docs", "Runtime"]);
  assert.equal(isSparkAskFlowGateBlocked(result, request), false);
});
