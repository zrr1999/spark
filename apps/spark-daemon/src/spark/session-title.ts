import type { SparkModelRef, SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import type { DaemonSessionRegistry } from "../session-registry.ts";

const SESSION_ROLE_MAX_LENGTH = 32;

// eslint-disable-next-line no-control-regex
const ANSI_OSC_SEQUENCE_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu;
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_SEQUENCE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
// C0/C1 controls and bidi embedding/override/isolate controls must never reach
// a terminal label. Newlines/tabs are normalized before this sanitizer.
const UNSAFE_TITLE_CONTROL_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;

export interface AssignCompletedSessionRoleInput {
  sessionId: string;
  prompt: string;
  model: SparkModelRef;
  signal?: AbortSignal;
}

export interface CompletedSessionRoleDependencies {
  modelControl: {
    generateSessionRole(input: {
      prompt: string;
      model: SparkModelRef;
      signal?: AbortSignal;
    }): Promise<string | undefined>;
  };
  sessionRegistry: Pick<DaemonSessionRegistry, "get"> & {
    setRoleIfMissing(sessionId: string, role: string): Promise<SparkSessionRegistryRecord>;
  };
  logError?: (message: string) => void;
}

/**
 * Best-effort post-turn role assignment for user-created local sessions.
 *
 * Eligibility is checked before the advisory model call to avoid needless
 * work. The registry performs the authoritative compare-and-set afterwards,
 * protecting a title/channel/archive transition that races the leaf call.
 */
export async function assignCompletedSessionRole(
  input: AssignCompletedSessionRoleInput,
  dependencies: CompletedSessionRoleDependencies,
): Promise<SparkSessionRegistryRecord | undefined> {
  if (isOwnershipCancellation(input.signal)) return undefined;
  const session = await safelyGetSession(input.sessionId, dependencies);
  if (isOwnershipCancellation(input.signal) || !session || !isUnassignedLocalSession(session)) {
    return undefined;
  }

  let role: string | undefined;
  try {
    const generated = await dependencies.modelControl.generateSessionRole({
      prompt: input.prompt,
      model: input.model,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    role = normalizeGeneratedSessionRole(generated);
  } catch {
    // Explicit cancellation is an ownership transition. A local classification
    // deadline is only model degradation, so persist the deterministic fallback.
    if (isOwnershipCancellation(input.signal)) return undefined;
    logError(
      dependencies,
      `[spark-daemon] session role generation failed for ${input.sessionId}; using fallback`,
    );
  }
  if (isOwnershipCancellation(input.signal)) return undefined;
  role ??= fallbackSessionRole(input.prompt);

  try {
    return await dependencies.sessionRegistry.setRoleIfMissing(input.sessionId, role);
  } catch {
    // Naming is advisory. The completed transcript remains authoritative and a
    // title persistence failure must never turn a successful user turn into a
    // failed/replayed invocation.
    logError(
      dependencies,
      `[spark-daemon] failed to persist generated role for ${input.sessionId}`,
    );
    return undefined;
  }
}

function isOwnershipCancellation(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  return !(reason instanceof DOMException && reason.name === "TimeoutError");
}

function isUnassignedLocalSession(session: SparkSessionRegistryRecord): boolean {
  return (
    session.status !== "archived" &&
    !session.role?.trim() &&
    !session.title?.trim() &&
    !session.bindings.some((binding) => binding.kind === "channel")
  );
}

async function safelyGetSession(
  sessionId: string,
  dependencies: CompletedSessionRoleDependencies,
): Promise<SparkSessionRegistryRecord | undefined> {
  try {
    return await dependencies.sessionRegistry.get(sessionId);
  } catch {
    logError(dependencies, `[spark-daemon] failed to inspect session ${sessionId} for role naming`);
    return undefined;
  }
}

function normalizeGeneratedSessionRole(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const normalized = sanitizeTitleFragment(
    sanitizeTitleFragment(firstLine)
      .replace(/^#{1,6}\s*/u, "")
      .replace(/^(?:role|responsibility|division|职责|分工|角色|标题)\s*[:：-]\s*/iu, "")
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, ""),
  );
  return normalized ? truncateRole(normalized) : undefined;
}

function fallbackSessionRole(prompt: string): string {
  const normalized = prompt.toLowerCase();
  const chinese = /[\p{Script=Han}]/u.test(prompt);
  if (/运维|后台|守护进程|daemon|runtime|operations|deployment/u.test(normalized)) {
    return chinese ? "运行维护" : "Runtime Operations";
  }
  if (/网页|前端|界面|交互|cockpit|frontend|\bui\b|web/u.test(normalized)) {
    return chinese ? "前端体验" : "Frontend Engineering";
  }
  if (/消息平台|如流|飞书|qq|infoflow|channel|bot/u.test(normalized)) {
    return chinese ? "消息平台" : "Messaging Platforms";
  }
  if (/架构|设计|边界|architecture|design/u.test(normalized)) {
    return chinese ? "架构设计" : "Architecture";
  }
  if (/测试|验收|验证|审查|review|test|verify|quality/u.test(normalized)) {
    return chinese ? "质量验证" : "Quality Verification";
  }
  return chinese ? "通用执行" : "Generalist";
}

function sanitizeTitleFragment(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "")
    .replaceAll(UNSAFE_TITLE_CONTROL_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateRole(role: string): string {
  const characters = Array.from(role);
  if (characters.length <= SESSION_ROLE_MAX_LENGTH) return role;
  return `${characters.slice(0, SESSION_ROLE_MAX_LENGTH - 1).join("")}…`;
}

function logError(dependencies: CompletedSessionRoleDependencies, message: string): void {
  (dependencies.logError ?? console.error)(message);
}
