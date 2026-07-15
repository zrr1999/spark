import type { SparkModelRef, SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import type { DaemonSessionRegistry } from "../session-registry.ts";

const SESSION_TITLE_MAX_LENGTH = 48;

// eslint-disable-next-line no-control-regex
const ANSI_OSC_SEQUENCE_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_SEQUENCE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
// C0/C1 controls and bidi embedding/override/isolate controls must never reach
// a terminal label. Newlines/tabs are normalized before this sanitizer.
const UNSAFE_TITLE_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

export interface AssignCompletedSessionTitleInput {
  sessionId: string;
  prompt: string;
  model: SparkModelRef;
  signal?: AbortSignal;
}

export interface CompletedSessionTitleDependencies {
  modelControl: {
    generateSessionTitle(input: {
      prompt: string;
      model: SparkModelRef;
      signal?: AbortSignal;
    }): Promise<string | undefined>;
  };
  sessionRegistry: Pick<DaemonSessionRegistry, "get"> & {
    setTitleIfMissing(sessionId: string, title: string): Promise<SparkSessionRegistryRecord>;
  };
  logError?: (message: string) => void;
}

/**
 * Best-effort post-turn naming for daemon-owned local sessions.
 *
 * Eligibility is checked before the advisory model call to avoid needless
 * work. The registry performs the authoritative compare-and-set afterwards,
 * protecting a title/channel/archive transition that races the leaf call.
 */
export async function assignCompletedSessionTitle(
  input: AssignCompletedSessionTitleInput,
  dependencies: CompletedSessionTitleDependencies,
): Promise<SparkSessionRegistryRecord | undefined> {
  const session = await safelyGetSession(input.sessionId, dependencies);
  if (!session || !isUntitledLocalSession(session)) return undefined;

  let title: string | undefined;
  try {
    const generated = await dependencies.modelControl.generateSessionTitle({
      prompt: input.prompt,
      model: input.model,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    title = normalizeGeneratedSessionTitle(generated);
  } catch {
    logError(
      dependencies,
      `[spark-daemon] session title generation failed for ${input.sessionId}; using fallback`,
    );
  }
  title ??= fallbackSessionTitle(input.prompt);
  if (!title) return undefined;

  try {
    return await dependencies.sessionRegistry.setTitleIfMissing(input.sessionId, title);
  } catch {
    // Naming is advisory. The completed transcript remains authoritative and a
    // title persistence failure must never turn a successful user turn into a
    // failed/replayed invocation.
    logError(
      dependencies,
      `[spark-daemon] failed to persist generated title for ${input.sessionId}`,
    );
    return undefined;
  }
}

function isUntitledLocalSession(session: SparkSessionRegistryRecord): boolean {
  return (
    session.status !== "archived" &&
    !session.title?.trim() &&
    !session.bindings.some((binding) => binding.kind === "channel")
  );
}

async function safelyGetSession(
  sessionId: string,
  dependencies: CompletedSessionTitleDependencies,
): Promise<SparkSessionRegistryRecord | undefined> {
  try {
    return await dependencies.sessionRegistry.get(sessionId);
  } catch {
    logError(dependencies, `[spark-daemon] failed to inspect session ${sessionId} for naming`);
    return undefined;
  }
}

function normalizeGeneratedSessionTitle(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const normalized = sanitizeTitleFragment(
    sanitizeTitleFragment(firstLine)
      .replace(/^#{1,6}\s*/u, "")
      .replace(/^(?:title|conversation title|标题)\s*[:：-]\s*/iu, "")
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, ""),
  );
  return normalized ? truncateTitle(normalized) : undefined;
}

function fallbackSessionTitle(prompt: string): string | undefined {
  const firstSentence = prompt
    .trim()
    .split(/\r?\n|[.!?。！？]+/u)
    .map((part) => part.trim())
    .find(Boolean);
  if (!firstSentence) return undefined;
  const normalized = sanitizeTitleFragment(
    sanitizeTitleFragment(firstSentence).replace(/^(?:#{1,6}|[-*+>]|\d+[.)])\s+/u, ""),
  );
  return normalized ? truncateTitle(normalized) : undefined;
}

function sanitizeTitleFragment(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "")
    .replaceAll(UNSAFE_TITLE_CONTROL_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= SESSION_TITLE_MAX_LENGTH) return title;
  return `${characters.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join("")}…`;
}

function logError(dependencies: CompletedSessionTitleDependencies, message: string): void {
  (dependencies.logError ?? console.error)(message);
}
