import { WorkflowRunStore, sparkWorkflowRunStorePath } from "@zendev-lab/spark-workflows";

/** Compatibility shim: workflow-run state is owned by @zendev-lab/spark-workflows. */
export { sparkWorkflowRunStorePath };

export function defaultSparkWorkflowRunStore(cwd: string): WorkflowRunStore {
  return new WorkflowRunStore(sparkWorkflowRunStorePath(cwd));
}
