import assert from "node:assert/strict";
import test from "node:test";

import { defaultWorkflowRunStore, sparkWorkflowRunStorePath } from "@zendev-lab/spark-workflows";
import {
  defaultSparkWorkflowRunStore,
  sparkWorkflowRunStorePath as shimWorkflowRunStorePath,
} from "../packages/pi-extension/src/extension/spark-workflow-run-store.ts";

void test("workflow-run store shim delegates to spark-workflows single owner", () => {
  const cwd = "/tmp/spark-workflow-ownership";
  assert.equal(shimWorkflowRunStorePath(cwd), sparkWorkflowRunStorePath(cwd));
  assert.equal(
    defaultSparkWorkflowRunStore(cwd).constructor.name,
    defaultWorkflowRunStore(cwd).constructor.name,
  );
});
