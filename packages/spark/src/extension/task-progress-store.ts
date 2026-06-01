import type { TaskRef } from "spark-core";
import type { TaskGraph, TaskGraphStore } from "spark-tasks";

export async function mergeTaskProgressIntoStore(
  store: TaskGraphStore,
  source: TaskGraph,
  taskRefs: TaskRef[],
): Promise<void> {
  await store.update(
    (current) => {
      current.mergeTaskProgressFrom(source, taskRefs);
    },
    { createIfMissing: false },
  );
}
