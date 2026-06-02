import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  builtinSparkWorkflowDescriptors,
  listSparkWorkflowRegistry,
  sparkWorkflowRef,
  userWorkflowDir,
  workspaceWorkflowDir,
} from "../packages/spark/src/extension/spark-workflow-registry.ts";

void test("Spark workflow registry lists builtin, workspace, and user workflows", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-workflow-registry-"));
  const userDir = await mkdtemp(join(tmpdir(), "spark-user-workflows-"));
  await mkdir(workspaceWorkflowDir(cwd), { recursive: true });
  await writeFile(
    join(workspaceWorkflowDir(cwd), "release-check.js"),
    `export const meta = {
      name: "Release Check",
      description: "Check release readiness.",
      phases: [{ title: "Inspect" }, { title: "Verify" }],
    };
    throw new Error("discovery must not execute workflow bodies");`,
  );
  await writeFile(
    join(workspaceWorkflowDir(cwd), "broken.js"),
    `export const meta = { name: "Broken" };`,
  );
  await writeFile(
    join(userDir, "oss-review.js"),
    `export const meta = {
      name: "OSS Review",
      description: "Review open-source readiness.",
    };`,
  );

  const listing = await listSparkWorkflowRegistry(cwd, { userWorkflowDir: userDir });
  const refs = listing.workflows.map((workflow) => workflow.ref);

  assert.ok(refs.includes("workflow:builtin-goal"));
  assert.ok(refs.includes("workflow:builtin-ready"));
  assert.ok(refs.includes("workflow:workspace-release-check"));
  assert.ok(refs.includes("workflow:user-oss-review"));
  assert.equal(listing.errors.length, 1);
  assert.equal(listing.errors[0]?.source, "workspace");
  assert.match(listing.errors[0]?.error ?? "", /description/);

  const workspace = listing.workflows.find(
    (workflow) => workflow.ref === "workflow:workspace-release-check",
  );
  assert.equal(workspace?.backend, "scripted");
  assert.deepEqual(workspace?.phases, ["Inspect", "Verify"]);
});

void test("Spark workflow registry exposes stable source/ref helpers", () => {
  assert.equal(sparkWorkflowRef("workspace", "deep_research"), "workflow:workspace-deep-research");
  assert.match(userWorkflowDir(), /\.agents\/workflows$/);
  assert.deepEqual(
    builtinSparkWorkflowDescriptors().map((workflow) => [
      workflow.id,
      workflow.source,
      workflow.backend,
    ]),
    [
      ["goal", "builtin", "goal"],
      ["ready", "builtin", "ready-frontier"],
    ],
  );
  assert.throws(() => sparkWorkflowRef("workspace", "Bad Name"), /workflow id/);
});
