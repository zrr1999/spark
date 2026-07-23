/** Compatibility shim: dynamic workflow execution state is owned by @zendev-lab/spark-workflows. */
export {
  SparkDynamicWorkflowManager,
  defaultSparkDynamicWorkflowManager,
} from "@zendev-lab/spark-workflows";
export type {
  SparkDynamicWorkflowLiveUpdate,
  SparkDynamicWorkflowLiveUpdateListener,
  SparkDynamicWorkflowManagerCompletion,
  SparkDynamicWorkflowManagerHandle,
  SparkDynamicWorkflowManagerRunInput,
  SparkDynamicWorkflowRunWorkflow,
} from "@zendev-lab/spark-workflows";
