import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { loadWorkspaceServerControl } from "$lib/server/projection-services";

export const agentsCockpitSource = "agents-cockpit";

export type AgentsProductCommand = {
  id: string;
  kind: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectedAt: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentsProductInvocation = {
  id: string;
  runtimeInvocationId: string;
  commandId: string | null;
  taskRuntimeId: string | null;
  agentName: string | null;
  status: string;
  updatedAt: string;
};

export type AgentsProductLogChunk = {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  stream: string;
  sequence: number;
  content: string;
  createdAt: string;
};

type ArtifactFallbackRow = {
  id: string;
  runtimeInvocationId: string;
  runtimeWorkspaceBindingId: string | null;
  contentRefJson: string;
  createdAt: string;
};

export function loadAgentsProductProjection(db: DatabaseSync, workspaceId: string) {
  const ownerBinding =
    (db
      .prepare(
        `SELECT wob.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
                rb.display_name AS displayName,
                rb.status AS bindingStatus,
                rc.name AS runtimeName,
                rc.status AS runtimeStatus
         FROM workspace_owner_bindings wob
         JOIN runtime_workspace_bindings rb ON rb.id = wob.runtime_workspace_binding_id
         JOIN runtime_connections rc ON rc.id = rb.runtime_id
         WHERE wob.workspace_id = ? AND wob.ended_at IS NULL
         LIMIT 1`,
      )
      .get(workspaceId) as
      | {
          runtimeWorkspaceBindingId: string;
          displayName: string;
          bindingStatus: string;
          runtimeName: string;
          runtimeStatus: string;
        }
      | undefined) ?? null;

  const commands = (
    db
      .prepare(
        `SELECT c.id,
                c.kind,
                c.title,
                c.payload_json AS payloadJson,
                c.status,
                c.created_at AS createdAt,
                c.updated_at AS updatedAt,
                cd.status AS deliveryStatus,
                cd.attempt_count AS attemptCount,
                cd.last_attempt_at AS lastAttemptAt,
                cd.acked_at AS ackedAt,
                cd.rejected_at AS rejectedAt,
                cd.reject_code AS rejectCode,
                cd.reject_message AS rejectMessage,
                rb.display_name AS runtimeWorkspaceName,
                rc.name AS runtimeName,
                rc.status AS runtimeStatus
         FROM commands c
         LEFT JOIN command_deliveries cd ON cd.command_id = c.id
         LEFT JOIN runtime_workspace_bindings rb ON rb.id = cd.runtime_workspace_binding_id
         LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
         WHERE c.workspace_id = ? AND c.project_id IS NULL
         ORDER BY c.created_at DESC
         LIMIT 24`,
      )
      .all(workspaceId) as AgentsProductCommand[]
  )
    .filter(isAgentsCockpitCommand)
    .slice(0, 8);
  const agentCommandIds = new Set(commands.map((command) => command.id));

  const invocations = (
    db
      .prepare(
        `SELECT id,
                runtime_invocation_id AS runtimeInvocationId,
                command_id AS commandId,
                task_runtime_id AS taskRuntimeId,
                agent_name AS agentName,
                status,
                updated_at AS updatedAt
         FROM mirrored_invocations
         WHERE workspace_id = ? AND project_id IS NULL
         ORDER BY updated_at DESC
         LIMIT 32`,
      )
      .all(workspaceId) as AgentsProductInvocation[]
  )
    .filter(
      (invocation) =>
        typeof invocation.commandId === "string" && agentCommandIds.has(invocation.commandId),
    )
    .slice(0, 16);
  const agentInvocationIds = new Set(
    invocations.map((invocation) => invocation.runtimeInvocationId),
  );

  const logChunks = (
    db
      .prepare(
        `SELECT l.id,
                mi.runtime_invocation_id AS runtimeInvocationId,
                mi.agent_name AS agentName,
                l.stream,
                l.sequence,
                l.content,
                l.created_at AS createdAt
         FROM invocation_log_chunks l
         JOIN mirrored_invocations mi ON mi.id = l.invocation_id
         WHERE mi.workspace_id = ? AND mi.project_id IS NULL
         ORDER BY l.created_at DESC, l.sequence DESC
         LIMIT 96`,
      )
      .all(workspaceId) as AgentsProductLogChunk[]
  )
    .filter((log) => agentInvocationIds.has(log.runtimeInvocationId))
    .slice(0, 48)
    .reverse();
  const artifactFallbackLogs = loadArtifactFallbackLogChunks(db, {
    workspaceId,
    invocationIds: agentInvocationIds,
    existingLogs: logChunks,
  });

  return {
    ownerBinding,
    workspaceControl: loadWorkspaceServerControl(db, workspaceId),
    commands,
    invocations,
    logChunks: [...logChunks, ...artifactFallbackLogs].sort(compareAgentLogChunks),
  };
}

export function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Agents task";
  }
  return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
}

function isAgentsCockpitCommand(command: { payloadJson: string }) {
  try {
    const parsed = JSON.parse(command.payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const payload = (parsed as { payload?: unknown }).payload;
    return Boolean(
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload as { source?: unknown }).source === agentsCockpitSource,
    );
  } catch {
    return false;
  }
}

function loadArtifactFallbackLogChunks(
  db: DatabaseSync,
  input: { workspaceId: string; invocationIds: Set<string>; existingLogs: AgentsProductLogChunk[] },
): AgentsProductLogChunk[] {
  const hasAssistantOutput = new Set(
    input.existingLogs
      .filter((log) => log.stream.toLowerCase() === "assistant" && log.content.trim())
      .map((log) => log.runtimeInvocationId),
  );
  const maxSequence = new Map<string, number>();
  for (const log of input.existingLogs) {
    maxSequence.set(
      log.runtimeInvocationId,
      Math.max(maxSequence.get(log.runtimeInvocationId) ?? 0, log.sequence),
    );
  }
  if ([...input.invocationIds].every((id) => hasAssistantOutput.has(id))) return [];

  const localPathCache = new Map<string, string | null>();
  const rows = db
    .prepare(
      `SELECT a.id,
              mi.runtime_invocation_id AS runtimeInvocationId,
              a.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              a.content_ref_json AS contentRefJson,
              a.created_at AS createdAt
       FROM artifacts a
       JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       WHERE mi.workspace_id = ? AND mi.project_id IS NULL
       ORDER BY a.created_at ASC`,
    )
    .all(input.workspaceId) as ArtifactFallbackRow[];

  const fallbackLogs: AgentsProductLogChunk[] = [];
  for (const row of rows) {
    if (!input.invocationIds.has(row.runtimeInvocationId)) continue;
    if (hasAssistantOutput.has(row.runtimeInvocationId)) continue;
    const text = assistantTextFromProjectedArtifact(row, localPathCache);
    if (!text) continue;
    fallbackLogs.push({
      id: `artifact-fallback-${row.id}`,
      runtimeInvocationId: row.runtimeInvocationId,
      agentName: "spark-runtime",
      stream: "assistant",
      sequence: (maxSequence.get(row.runtimeInvocationId) ?? 0) + 1,
      content: text,
      createdAt: row.createdAt,
    });
    hasAssistantOutput.add(row.runtimeInvocationId);
  }
  return fallbackLogs;
}

function assistantTextFromProjectedArtifact(
  row: ArtifactFallbackRow,
  localPathCache: Map<string, string | null>,
): string | null {
  const contentRef = parseJsonObject(row.contentRefJson);
  const inline = firstNonEmpty([
    stringValue(contentRef.assistantTextPreview),
    stringValue(contentRef.inlineMarkdown),
    stringValue(contentRef.inlineText),
  ]);
  if (inline) return inline;

  const sparkArtifactRef = stringValue(contentRef.sparkArtifactRef);
  if (!sparkArtifactRef || !row.runtimeWorkspaceBindingId) return null;
  const localPath = localWorkspacePathForRuntimeBinding(
    row.runtimeWorkspaceBindingId,
    localPathCache,
  );
  if (!localPath) return null;
  return assistantTextFromLocalSparkArtifact(localPath, sparkArtifactRef);
}

function localWorkspacePathForRuntimeBinding(
  runtimeWorkspaceBindingId: string,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(runtimeWorkspaceBindingId)) return cache.get(runtimeWorkspaceBindingId) ?? null;
  const daemonDatabasePath = resolveSparkPaths({ app: "daemon" }).databasePath;
  if (!existsSync(daemonDatabasePath)) {
    cache.set(runtimeWorkspaceBindingId, null);
    return null;
  }
  let daemonDb: DatabaseSync | undefined;
  try {
    daemonDb = new DatabaseSync(daemonDatabasePath, { readOnly: true });
    const row = daemonDb
      .prepare("SELECT local_path AS localPath FROM workspaces WHERE id = ? LIMIT 1")
      .get(runtimeWorkspaceBindingId) as { localPath: string } | undefined;
    const localPath = row?.localPath ?? null;
    cache.set(runtimeWorkspaceBindingId, localPath);
    return localPath;
  } catch {
    cache.set(runtimeWorkspaceBindingId, null);
    return null;
  } finally {
    daemonDb?.close();
  }
}

function assistantTextFromLocalSparkArtifact(
  localPath: string,
  sparkArtifactRef: string,
): string | null {
  try {
    const artifactId = sparkArtifactRef.startsWith("artifact:")
      ? sparkArtifactRef.slice("artifact:".length)
      : "";
    if (!/^[A-Za-z0-9._-]+$/u.test(artifactId)) return null;

    const artifactRoot = resolve(localPath, ".spark", "artifacts");
    const metadataPath = resolve(artifactRoot, `${artifactId}.json`);
    if (!metadataPath.startsWith(`${artifactRoot}/`) || !existsSync(metadataPath)) return null;

    const metadata = parseJsonObject(readFileSync(metadataPath, "utf8"));
    let body: unknown = metadata.body;
    if (typeof metadata.blobPath === "string") {
      const blobPath = resolve(artifactRoot, metadata.blobPath);
      if (!blobPath.startsWith(`${artifactRoot}/`) || !existsSync(blobPath)) return null;
      const serializedBody = readFileSync(blobPath, "utf8");
      body = metadata.format === "json" ? parseJson(serializedBody) : serializedBody;
    }
    return assistantTextFromRoleRunBody(body);
  } catch {
    return null;
  }
}

function assistantTextFromRoleRunBody(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const body = isRecord(value.body) ? value.body : value;
  return firstNonEmpty([
    assistantTextFromRoleRunJsonEvents(body.jsonEvents),
    textTail(body.stdout),
    stringValue(body.summary),
  ]);
}

function assistantTextFromRoleRunJsonEvents(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const tail = Array.isArray(value.tail) ? value.tail : [];
  for (const raw of [...tail].reverse()) {
    const parsed = typeof raw === "string" ? parseJson(raw) : raw;
    const text = assistantTextFromEvent(parsed);
    if (text) return text;
  }
  return null;
}

function assistantTextFromEvent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type === "stream_event" && isRecord(value.event)) {
    if (value.event.type === "done") return assistantTextFromMessage(value.event.message);
    if (value.event.type === "text_end" && typeof value.event.content === "string") {
      return value.event.content.trim() || null;
    }
  }
  if (value.type === "turn_complete") return assistantTextFromMessage(value.message);
  if (
    value.type === "view_event" &&
    isRecord(value.event) &&
    value.event.type === "session.message"
  ) {
    return assistantTextFromMessage(value.event.message);
  }
  return assistantTextFromMessage(value.message);
}

function assistantTextFromMessage(value: unknown): string | null {
  if (!isRecord(value) || value.role !== "assistant") return null;
  return messageContentText(value.content);
}

function messageContentText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
  return text || null;
}

function textTail(value: unknown): string | null {
  return isRecord(value) ? (stringValue(value.tail) ?? null) : null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function compareAgentLogChunks(left: AgentsProductLogChunk, right: AgentsProductLogChunk) {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.runtimeInvocationId.localeCompare(right.runtimeInvocationId) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
