import assert from "node:assert/strict";
import test from "node:test";

import {
  approveManagedAgentAsk,
  clarifyThreadAsk,
  createElaborationResult,
  replayableSparkAsk,
  runSparkAsk,
} from "spark-ask";

void test("clarify-thread flow produces rich clarification questions", () => {
  const request = clarifyThreadAsk({
    idea: "Build a local SVG animation extension",
  });
  assert.equal(request.flow, "clarify-thread");
  assert.equal(request.questions[0]?.id, "output-language");
  assert.equal(request.questions[1]?.id, "working-title");
  assert.ok(request.questions.some((question) => question.id === "delivery-mode"));
  assert.ok(request.questions.some((question) => question.id === "next-action"));
  assert.ok(request.questions.some((question) => question.id === "smallest-slice"));
});

void test("clarify-thread asks users to confirm detected output language", () => {
  const request = clarifyThreadAsk({ idea: "梳理下一步改进点" });
  const languageQuestion = request.questions.find((question) => question.id === "output-language");
  assert.equal(languageQuestion?.required, true);
  assert.equal(languageQuestion?.options?.[0]?.value, "zh");
});

void test("approve-managed-agent flow uses approval semantics", async () => {
  const request = approveManagedAgentAsk({
    proposal: {
      id: "svg-agent",
      description: "Handles SVG animation plans",
      systemPrompt: "You are a SVG planner.",
      rationale: "Need a reusable specialist",
      expectedUses: ["svg planning"],
    },
  });
  const result = await runSparkAsk(request);
  assert.equal(result.flow, "approve-managed-agent");
  assert.equal(result.mode, "submit");
  assert.equal(result.answers.approval?.values[0], "approve");
});

void test("replayable spark ask preserves prior selections in option descriptions", () => {
  const request = clarifyThreadAsk({
    idea: "Build a local SVG animation extension",
  });
  const elaborated = createElaborationResult(
    {
      cancelled: false,
      mode: "submit",
      flow: request.flow,
      base: {
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
