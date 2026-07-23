import { basename } from "node:path";
import {
  SparkSessionStore,
  type SparkSessionEntry,
  type SparkSessionInfo,
  type SparkSessionRecord,
} from "@zendev-lab/spark-host/session-store";
import { formatSessionList } from "../host/session-navigation.ts";
import type { SparkDaemonWorkspace } from "./daemon.ts";

export interface DaemonSessionListResult {
  plane: "daemon";
  resource: "session";
  sessions: DaemonSessionSummary[];
  text: string;
  observedAt: string;
  allWorkspaces?: boolean;
  history?: boolean;
  live?: boolean;
}

export interface DaemonSessionSummary {
  sessionKey: string;
  id: string;
  path: string;
  cwd: string;
  parentSessionPath?: string;
  createdAt: string;
  modifiedAt: string;
  updatedAt: string;
  activeGoal: string | null;
  activeLoop: string | null;
  messageCount: number;
  firstMessage: string;
  name?: string;
  live?: boolean;
  workspaceId?: string;
  workspaceName?: string;
  clientId?: string;
  clientKind?: string;
  clientDisplayName?: string;
  status?: string;
  joinCommand?: string;
}

export interface DaemonSessionShowResult {
  plane: "daemon";
  resource: "session";
  sessionKey: string;
  id: string;
  path: string;
  cwd: string;
  parentSessionPath?: string;
  createdAt: string;
  entryCount: number;
  messageCount: number;
  currentProjectRef: string | null;
  entries: DaemonSessionTreeNode[];
  text: string;
  observedAt: string;
}

export interface DaemonSessionTreeResult {
  plane: "daemon";
  resource: "session";
  sessionKey: string;
  id: string;
  nodes: DaemonSessionTreeNode[];
  text: string;
  observedAt: string;
}

export interface DaemonSessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  role?: string;
  depth: number;
  active: boolean;
}

export interface DaemonSessionForkResult {
  plane: "daemon";
  resource: "session";
  sessionKey: string;
  id: string;
  path: string;
  parentSessionKey: string;
  parentSessionPath: string;
  entryCount: number;
  text: string;
  observedAt: string;
}

export type DaemonSessionResult =
  | DaemonSessionListResult
  | DaemonSessionShowResult
  | DaemonSessionTreeResult
  | DaemonSessionForkResult;

export async function listDaemonSessions(
  store: SparkSessionStore,
  options: { allWorkspaces?: boolean; observedAt: string; history?: boolean },
): Promise<DaemonSessionListResult> {
  const infos = options.allWorkspaces
    ? await store.listAllPersistentSessions()
    : await store.list();
  return {
    plane: "daemon",
    resource: "session",
    sessions: infos.map(toSessionSummary),
    text: formatSessionList(infos, { showWorkspace: options.allWorkspaces }),
    observedAt: options.observedAt,
    ...(options.allWorkspaces ? { allWorkspaces: true } : {}),
    history: true,
  };
}

export function listLiveDaemonSessions(
  workspaces: SparkDaemonWorkspace[],
  options: { observedAt: string },
): DaemonSessionListResult {
  const sessions = workspaces.flatMap((workspace) =>
    (workspace.workspaceClients ?? [])
      .filter((client) => client.status === "connected")
      .map((client) => liveSessionSummary(workspace, client, options.observedAt)),
  );
  return {
    plane: "daemon",
    resource: "session",
    sessions,
    text: renderLiveSessionList(sessions),
    observedAt: options.observedAt,
    live: true,
  };
}

export async function showDaemonSession(
  store: SparkSessionStore,
  sessionRef: string,
  options: { observedAt: string },
): Promise<DaemonSessionShowResult> {
  const record = await store.loadByRef(sessionRef);
  const messageCount = record.entries.filter((entry) => entry.type === "message").length;
  return {
    plane: "daemon",
    resource: "session",
    sessionKey: sessionKey(record.header.id),
    id: record.header.id,
    path: record.path,
    cwd: record.header.cwd,
    ...(record.header.parentSession ? { parentSessionPath: record.header.parentSession } : {}),
    createdAt: record.header.timestamp,
    entryCount: record.entries.length,
    messageCount,
    currentProjectRef: null,
    entries: buildTreeNodes(record.entries),
    text: `${sessionKey(record.header.id)} ${record.entries.length} entries ${record.path}\n`,
    observedAt: options.observedAt,
  };
}

export async function treeDaemonSession(
  store: SparkSessionStore,
  sessionRef: string,
  options: { observedAt: string },
): Promise<DaemonSessionTreeResult> {
  const record = await store.loadByRef(sessionRef);
  const nodes = buildTreeNodes(record.entries);
  return {
    plane: "daemon",
    resource: "session",
    sessionKey: sessionKey(record.header.id),
    id: record.header.id,
    nodes,
    text: renderSessionTree(record, nodes),
    observedAt: options.observedAt,
  };
}

export async function forkDaemonSession(
  store: SparkSessionStore,
  sessionRef: string,
  options: { id?: string; observedAt: string },
): Promise<DaemonSessionForkResult> {
  const parent = await store.loadByRef(sessionRef);
  const fork = store.forkSession(parent, { id: options.id, timestamp: options.observedAt });
  await store.save(fork);
  return {
    plane: "daemon",
    resource: "session",
    sessionKey: sessionKey(fork.header.id),
    id: fork.header.id,
    path: fork.path,
    parentSessionKey: sessionKey(parent.header.id),
    parentSessionPath: parent.path,
    entryCount: fork.entries.length,
    text: `${sessionKey(fork.header.id)} forked from ${sessionKey(parent.header.id)}\n`,
    observedAt: options.observedAt,
  };
}

export function sessionKey(id: string): string {
  return id.startsWith("session:") ? id : `session:${id}`;
}

function toSessionSummary(info: SparkSessionInfo): DaemonSessionSummary {
  return {
    sessionKey: sessionKey(info.id),
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
    createdAt: info.created.toISOString(),
    modifiedAt: info.modified.toISOString(),
    updatedAt: info.modified.toISOString(),
    activeGoal: null,
    activeLoop: null,
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
    ...(info.name ? { name: info.name } : {}),
  };
}

function liveSessionSummary(
  workspace: SparkDaemonWorkspace,
  client: NonNullable<SparkDaemonWorkspace["workspaceClients"]>[number],
  observedAt: string,
): DaemonSessionSummary {
  const timestamp = client.lastSeenAt ?? client.attachedAt ?? workspace.updatedAt ?? observedAt;
  const display = client.displayName ?? client.kind;
  const joinCommand = joinCommandForWorkspace(workspace.localPath);
  return {
    sessionKey: sessionKey(client.clientId),
    id: client.clientId,
    path: "",
    cwd: workspace.localPath,
    createdAt: client.attachedAt ?? timestamp,
    modifiedAt: timestamp,
    updatedAt: timestamp,
    activeGoal: null,
    activeLoop: null,
    messageCount: 0,
    firstMessage: display,
    live: true,
    workspaceId: workspace.id,
    workspaceName: workspace.displayName,
    clientId: client.clientId,
    clientKind: client.kind,
    clientDisplayName: client.displayName,
    status: client.status,
    joinCommand,
  };
}

function renderLiveSessionList(sessions: DaemonSessionSummary[]): string {
  if (sessions.length === 0) {
    return "No live Spark daemon sessions. Use `spark daemon session list --history` to show persisted session history.\n";
  }
  return (
    sessions
      .map((session) => {
        const name = session.clientDisplayName ? ` ${session.clientDisplayName}` : "";
        return `${session.sessionKey} ${session.clientKind}${name} workspace=${session.workspaceName ?? session.cwd} lastSeen=${session.updatedAt} join: ${session.joinCommand}`;
      })
      .join("\n") + "\n"
  );
}

function joinCommandForWorkspace(cwd: string): string {
  return `cd ${shellQuote(cwd)} && spark tui`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function buildTreeNodes(entries: SparkSessionEntry[]): DaemonSessionTreeNode[] {
  const depths = new Map<string, number>();
  const activeId = entries.at(-1)?.id;
  return entries.map((entry) => {
    const parentDepth = entry.parentId ? depths.get(entry.parentId) : undefined;
    const depth = parentDepth === undefined ? 0 : parentDepth + 1;
    depths.set(entry.id, depth);
    return toTreeNode(entry, depth, entry.id === activeId);
  });
}

function toTreeNode(
  entry: SparkSessionEntry,
  depth: number,
  active: boolean,
): DaemonSessionTreeNode {
  const role = entry.type === "message" ? entry.message.role : undefined;
  return {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    ...(role ? { role } : {}),
    depth,
    active,
  };
}

function renderSessionTree(record: SparkSessionRecord, nodes: DaemonSessionTreeNode[]): string {
  const lines = [`${sessionKey(record.header.id)} ${basename(record.path)}`];
  for (const node of nodes) {
    const parent = node.parentId ?? "root";
    const role = node.role ? ` ${node.role}` : "";
    lines.push(`${node.id} <- ${parent} ${node.type}${role}`);
  }
  return `${lines.join("\n")}\n`;
}
