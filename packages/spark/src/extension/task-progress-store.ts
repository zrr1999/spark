import type { TaskRef } from "pi-extension-api";
import type { TaskGraph, TaskGraphStore } from "pi-tasks";

export async function mergeTaskProgressIntoStore(
  store: TaskGraphStore,
  source: TaskGraph,
  taskRefs: TaskRef[],
  afterSave?: (current: TaskGraph) => void | Promise<void>,
): Promise<void> {
  await store.withLock(async () => {
    const current = await store.load();
    if (!current) return;
    current.mergeTaskProgressFrom(source, taskRefs);
    await store.save(current);
    await afterSave?.(current);
  });
}
