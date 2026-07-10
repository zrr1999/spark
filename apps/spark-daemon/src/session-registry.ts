import type {
  SparkSessionArchiveRequest,
  SparkSessionBindRequest,
  SparkSessionCreateRequest,
  SparkSessionListRequest,
  SparkModelRef,
  SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import {
  defaultSparkSessionRegistryRoot,
  SparkSessionRegistry,
  type ResolveBindingInput,
} from "@zendev-lab/spark-session";

/**
 * The daemon-owned session registry surface. Every daemon subsystem that can
 * mutate session state must share one instance so registry.json has one
 * read-modify-write owner inside the process.
 */
export interface DaemonSessionRegistry {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  list(options?: SparkSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord | undefined>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: SparkSessionArchiveRequest["sessionId"]): Promise<SparkSessionRegistryRecord>;
  setModel(sessionId: string, model: SparkModelRef): Promise<SparkSessionRegistryRecord>;
  resolveBinding(input: ResolveBindingInput): Promise<SparkSessionRegistryRecord>;
}

/**
 * Serialize complete registry transitions, including resolveBinding's
 * create-and-bind sequence. Reads wait for earlier mutations so callers never
 * observe an acknowledged transition half-applied.
 */
export function createSerializedDaemonSessionRegistry(
  registry: DaemonSessionRegistry,
): DaemonSessionRegistry {
  let mutationTail: Promise<void> = Promise.resolve();
  const readAfterMutations = async <T>(read: () => Promise<T>): Promise<T> => {
    await mutationTail;
    return await read();
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    create: (input) => mutate(() => registry.create(input)),
    list: (options) => readAfterMutations(() => registry.list(options)),
    get: (sessionId) => readAfterMutations(() => registry.get(sessionId)),
    bind: (input) => mutate(() => registry.bind(input)),
    unbind: (sessionId, externalKey) => mutate(() => registry.unbind(sessionId, externalKey)),
    archive: (sessionId) => mutate(() => registry.archive(sessionId)),
    setModel: (sessionId, model) => mutate(() => registry.setModel(sessionId, model)),
    resolveBinding: (input) => mutate(() => registry.resolveBinding(input)),
  };
}

export function createDaemonSessionRegistry(sparkHome: string): DaemonSessionRegistry {
  return createSerializedDaemonSessionRegistry(
    new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(sparkHome),
    }),
  );
}
