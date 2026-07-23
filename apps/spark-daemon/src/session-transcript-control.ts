import { resolve } from "node:path";
import { SparkSessionStore } from "@zendev-lab/spark-host/session-store";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export interface EnsureDaemonSessionTranscriptInput {
  session: SparkSessionRegistryRecord;
  sparkHome: string;
  registry: Pick<DaemonSessionRegistry, "bindTranscriptPath">;
}

/**
 * Resolve the one transcript owned by a daemon registry record.
 *
 * Ordinary conversations are preallocated at a stable path before execution.
 * Side-thread generations retain their explicitly registered generation path.
 */
export async function ensureDaemonSessionTranscript(
  input: EnsureDaemonSessionTranscriptInput,
): Promise<string> {
  const session = input.session;
  if (session.relation?.kind === "side_thread") {
    if (!session.sessionPath) {
      throw new Error(`side-thread session ${session.sessionId} has no registered transcript`);
    }
    return session.sessionPath;
  }
  if (!session.cwd?.trim()) {
    throw new Error(`session ${session.sessionId} has no daemon-owned cwd`);
  }

  const store = new SparkSessionStore({ cwd: session.cwd, sparkHome: input.sparkHome });
  if (session.sessionPath) {
    const record = await store.load(session.sessionPath);
    assertTranscriptIdentity(record.header.id, record.header.cwd, session);
    return resolve(session.sessionPath);
  }

  const recovered = await store.findAllById(session.sessionId);
  if (recovered.length > 1) {
    throw new Error(
      `session ${session.sessionId} has ${recovered.length} transcript fragments; run transcript unification before continuing`,
    );
  }
  if (recovered.length === 1) {
    const record = recovered[0]!;
    assertTranscriptIdentity(record.header.id, record.header.cwd, session);
    const bound = await input.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: record.path,
    });
    return bound.sessionPath!;
  }

  const record = store.createCanonicalSession({
    id: session.sessionId,
    timestamp: session.createdAt,
  });
  await store.save(record);
  const bound = await input.registry.bindTranscriptPath({
    sessionId: session.sessionId,
    sessionPath: record.path,
  });
  return bound.sessionPath!;
}

function assertTranscriptIdentity(
  transcriptId: string,
  transcriptCwd: string,
  session: SparkSessionRegistryRecord,
): void {
  if (transcriptId !== session.sessionId) {
    throw new Error(`registered transcript belongs to ${transcriptId}, not ${session.sessionId}`);
  }
  if (resolve(transcriptCwd) !== resolve(session.cwd!)) {
    throw new Error(`registered transcript for ${session.sessionId} belongs to another workspace`);
  }
}
