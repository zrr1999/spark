import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeSparkIdea,
  renderSparkActiveSystemPrompt,
  shouldMaterializeSparkMd,
} from "../packages/spark/src/extension/index.ts";

void test("workspace-like cwd keeps Spark state under .spark without root SPARK.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-workspace-"));
  try {
    assert.equal(await shouldMaterializeSparkMd(dir), false);
    const result = await initializeSparkIdea(dir, "Build a new idea from workspace root");
    assert.equal(result.sparkMdPath, undefined);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.match(threadJson, /Maintain current interaction context/);
    assert.match(threadJson, /Capture project intent/);
    await assert.rejects(() => readFile(join(dir, "SPARK.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("repo-like cwd materializes root SPARK.md as well", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-repo-"));
  try {
    await mkdir(join(dir, ".git"));
    assert.equal(await shouldMaterializeSparkMd(dir), true);
    const result = await initializeSparkIdea(dir, "Build a repo-local spark thread");
    assert.ok(result.sparkMdPath);
    const rootSpark = await readFile(result.sparkMdPath!, "utf8");
    assert.match(rootSpark, /Build a repo-local spark thread/);
    assert.match(rootSpark, /## Working title/);
    assert.doesNotMatch(rootSpark, /## Delivery expectation/);
    assert.doesNotMatch(rootSpark, /待确认/);
    assert.doesNotMatch(rootSpark, /To be confirmed/);
    assert.doesNotMatch(rootSpark, /## 生态关系/);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.match(threadJson, /Review initial direction/);
    assert.match(threadJson, /Maintain current interaction context/);
    assert.match(threadJson, /"currentTaskRef"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("active Spark prompt treats concrete tool feedback as repo implementation work", () => {
  const prompt = renderSparkActiveSystemPrompt("Base prompt", "SPARK.md");
  assert.match(prompt, /Do not guess missing intent/);
  assert.match(prompt, /continue with the selected action in the same turn/);
  assert.match(prompt, /concrete Spark\/pi-tool behavior change or defect/);
  assert.match(prompt, /Do not satisfy such feedback by only storing memory or preferences/);
});

void test("initializeSparkIdea preserves clarified title and trace ask refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-clarified-"));
  try {
    await mkdir(join(dir, ".git"));
    const result = await initializeSparkIdea(dir, "Build a language service", {
      threadTitle: "Hypha v0: VS Code-first IDE experience for Spore",
      clarification: {
        workingTitle: "Hypha v0: VS Code-first IDE experience for Spore",
        outputLanguage: "en",
        objective: "Clarify the next IDE slice and continue into implementation planning.",
        targetUser: "Spore language contributors",
        smallestSlice: "A documented next-step plan for diagnostics and editor UX.",
        successSignal: "The next tasks are explicit and implementation-ready.",
        nonGoals: "Do not broaden into full plugin architecture yet.",
        deliveryMode: "document_and_execute",
        nextAction: "continue_tasking",
      },
      askArtifactRefs: ["artifact:ask-test"],
      askRefs: ["ask:ask-test"],
    });
    assert.equal(result.threadTitle, "Hypha v0: VS Code-first IDE experience for Spore");
    assert.deepEqual(result.askArtifactRefs, ["artifact:ask-test"]);
    const threadJson = await readFile(join(dir, ".spark", "thread.json"), "utf8");
    assert.match(threadJson, /Hypha v0: VS Code-first IDE experience for Spore/);
    assert.match(threadJson, /Maintain current interaction context/);
    const artifactFiles = await readdir(join(dir, ".spark", "artifacts"));
    let traceBody: unknown;
    for (const file of artifactFiles.filter((entry) => entry.endsWith(".json"))) {
      const content = JSON.parse(
        await readFile(join(dir, ".spark", "artifacts", file), "utf8"),
      ) as { kind?: string; body?: unknown };
      if (content.kind === "run-trace") {
        traceBody = content.body;
        break;
      }
    }
    assert.deepEqual((traceBody as { askRefs?: string[] }).askRefs, ["ask:ask-test"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
