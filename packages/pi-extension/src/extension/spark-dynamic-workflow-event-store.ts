/** Compatibility shim: dynamic workflow event state is owned by @zendev-lab/spark-workflows. */
export {
  SparkDynamicWorkflowEventStore,
  defaultSparkDynamicWorkflowEventStore,
  dynamicWorkflowRecordFromEventRun,
} from "@zendev-lab/spark-workflows";
export type {
  SparkDynamicWorkflowEventInput,
  SparkDynamicWorkflowEventRunMetadata,
  SparkDynamicWorkflowEventRunStartInput,
  SparkDynamicWorkflowEventRunView,
  SparkDynamicWorkflowEventSnapshotFile,
} from "@zendev-lab/spark-workflows";
