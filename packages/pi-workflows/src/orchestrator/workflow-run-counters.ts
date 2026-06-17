import type { WorkflowRunRecord } from "./index.ts";

export function reconcileWorkflowRunCounters(
  record: WorkflowRunRecord,
  fallbacks: { scheduledFallback?: number; completedFallback?: number } = {},
): void {
  record.scheduledTaskRefs = uniqueRefs(record.scheduledTaskRefs);
  record.completedTaskRefs = uniqueRefs(record.completedTaskRefs);
  record.taskRunRefs = uniqueRefs(record.taskRunRefs);
  const scheduledSet = new Set(record.scheduledTaskRefs);
  if (scheduledSet.size > 0) {
    record.completedTaskRefs = record.completedTaskRefs.filter((taskRef) =>
      scheduledSet.has(taskRef),
    );
    record.scheduled = scheduledSet.size;
    record.completed = record.completedTaskRefs.length;
    return;
  }
  record.scheduled = Math.max(0, record.scheduled, fallbacks.scheduledFallback ?? 0);
  record.completed = Math.min(
    record.scheduled,
    Math.max(0, record.completed, fallbacks.completedFallback ?? 0),
  );
}

export function uniqueRefs<T extends string>(refs: T[]): T[] {
  return [...new Set(refs)];
}
