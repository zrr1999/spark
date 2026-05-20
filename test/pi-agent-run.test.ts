import assert from "node:assert/strict";
import test from "node:test";

import { buildPiAgentArgs, normalizeAgentRunMode, parsePiJsonlEvents } from "pi-agent-run";

void test("pi-agent-run builds fresh JSON Pi agent args without accidental fork session reuse", () => {
  const args = buildPiAgentArgs({
    specRef: "agent:project-svg-assembler",
    mode: "fresh",
    systemPrompt: "You are a worker.",
    instruction: "Implement the task.",
    sessionDir: "/tmp/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 6), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/tmp/sessions",
    "--append-system-prompt",
  ]);
  assert.equal(args.includes("--fork"), false);
  assert.equal(args.includes("session-parent.json"), false);
  assert.equal(args.at(-2), "You are a worker.");
  assert.equal(args.at(-1)?.includes("Spark subagent ask policy:"), true);
  assert.equal(args.at(-1)?.includes("Spark naming quality policy:"), true);
  assert.equal(args.at(-1)?.includes("Instruction:\nImplement the task."), true);
});

void test("pi-agent-run builds forked JSON Pi agent args only when forked mode is explicit", () => {
  const args = buildPiAgentArgs({
    specRef: "agent:builtin-reviewer",
    mode: "forked",
    systemPrompt: "You are a reviewer.",
    instruction: "Review the task.",
    sessionDir: "/tmp/sessions",
    forkFromSession: "session-parent.json",
  });

  assert.deepEqual(args.slice(0, 8), [
    "--print",
    "--mode",
    "json",
    "--session-dir",
    "/tmp/sessions",
    "--fork",
    "session-parent.json",
    "--append-system-prompt",
  ]);
});

void test("pi-agent-run requires fork source for forked mode", () => {
  assert.throws(
    () =>
      buildPiAgentArgs({
        specRef: "agent:builtin-worker",
        mode: "forked",
        systemPrompt: "You are a worker.",
        instruction: "Implement.",
      }),
    /forked agent run requires forkFromSession/,
  );
});

void test("pi-agent-run normalizes unknown modes to fresh and parses JSONL tolerantly", () => {
  assert.equal(normalizeAgentRunMode("forked"), "forked");
  assert.equal(normalizeAgentRunMode("managed"), "fresh");
  assert.deepEqual(parsePiJsonlEvents('{"type":"start"}\nnot-json\n{"type":"stop"}\n'), [
    { type: "start" },
    { type: "stop" },
  ]);
});
