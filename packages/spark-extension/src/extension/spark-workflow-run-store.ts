import { join } from "node:path";
import { WorkflowRunStore } from "@zendev-lab/pi-workflows";

export function sparkWorkflowRunStorePath(cwd: string): string {
  return join(cwd, ".spark", "workflow-runs.json");
}

export function defaultSparkWorkflowRunStore(cwd: string): WorkflowRunStore {
  return new WorkflowRunStore(sparkWorkflowRunStorePath(cwd));
}
