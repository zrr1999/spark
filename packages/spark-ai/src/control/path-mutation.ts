import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

/**
 * Serialize read/merge/write mutations for one local file inside this process.
 *
 * The queue is shared by every store/control instance importing this module, so
 * two local UI adapters cannot overwrite one another with stale snapshots.
 */
export function withPathMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}
