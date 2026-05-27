import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCueTerminalOutput } from "../packages/pi-cue/src/index.ts";

void test("normalizeCueTerminalOutput keeps final carriage-return frame", () => {
  assert.equal(normalizeCueTerminalOutput("Working 1\rWorking 2\rDone\n"), "Done\n");
});

void test("normalizeCueTerminalOutput collapses repeated spinner progress lines", () => {
  const output = [
    "⠋ Running hooks... vp check --fix...",
    "⠙ Running hooks... vp check --fix...",
    "⠹ Running hooks... vp check --fix...",
    "Passed",
  ].join("\n");

  assert.equal(
    normalizeCueTerminalOutput(output),
    ["⠹ Running hooks... vp check --fix...", "Passed"].join("\n"),
  );
});
