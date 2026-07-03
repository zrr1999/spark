/** Compatibility shim: workflow-run state is owned by @zendev-lab/spark-workflows. */
export {
  defaultWorkflowRunStore as defaultSparkWorkflowRunStore,
  sparkWorkflowRunStorePath,
} from "@zendev-lab/spark-workflows";
