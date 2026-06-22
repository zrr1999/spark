import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { nowIso, type ProjectRef, type TaskRef } from "@zendev-lab/pi-extension-api";
import { readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionOwnerKey,
  sparkSessionKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export interface SparkSessionIndexEntry {
  sessionKey: string;
  path: string;
  statePath: string;
  goalPath: string;
  loopPath: string;
  todoDisplayNumbersPath: string;
  hiddenRoleRunInboxPath: string;
  todoOwnerRef: string;
  currentProjectRef?: ProjectRef;
  currentTaskRef?: TaskRef;
  activeGoal: boolean;
  activeLoop: boolean;
  updatedAt: string;
}

export interface SparkSessionIndexSnapshot {
  version: 1;
  rebuildable: true;
  generatedAt: string;
  source: "per-session-directories";
  legacyImportOnly: string[];
  sessions: SparkSessionIndexEntry[];
}

export function sessionDirectoryNameForKey(sessionKey: string): string {
  return sanitizeStoreScope(sessionKey);
}

export function currentSessionDirectoryName(ctx?: SparkSessionContext): string {
  return sessionDirectoryNameForKey(sparkSessionOwnerKey(ctx));
}

export function sessionDirectoryPath(cwd: string, ctx?: SparkSessionContext): string {
  return join(cwd, ".spark", "sessions", currentSessionDirectoryName(ctx));
}

export function sessionRelativeDirectory(ctx?: SparkSessionContext): string {
  return join("sessions", currentSessionDirectoryName(ctx));
}

export function sessionStateStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "state.json");
}

export function sessionGoalStorePathV2(cwd: string, ctx?: SparkSessionContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "goal.json");
}

export function sessionLoopStorePathV2(cwd: string, ctx?: SparkSessionContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "loop.json");
}

export function sessionTodoDisplayNumberStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "todo-display-numbers.json");
}

export function sessionHiddenRoleRunInboxStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(sessionDirectoryPath(cwd, ctx), "hidden-role-run-inbox.json");
}

export function legacyCurrentProjectStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(cwd, ".spark", "sessions", `${currentSessionDirectoryName(ctx)}.json`);
}

export function legacySessionGoalStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(cwd, ".spark", "session-goals", `${currentSessionDirectoryName(ctx)}.json`);
}

export function legacySessionLoopStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(cwd, ".spark", "session-loops", `${currentSessionDirectoryName(ctx)}.json`);
}

export function legacyTodoDisplayNumberStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(
    cwd,
    ".spark",
    "todo-display-numbers",
    `${sanitizeStoreScope(sparkSessionKey(ctx))}.json`,
  );
}

export function legacyHiddenRoleRunInboxStorePath(cwd: string, ctx?: SparkSessionContext): string {
  return join(
    cwd,
    ".spark",
    "background-role-results-inbox",
    `${currentSessionDirectoryName(ctx)}.json`,
  );
}

export async function rebuildSessionIndex(cwd: string): Promise<SparkSessionIndexSnapshot> {
  const sessionsRoot = join(cwd, ".spark", "sessions");
  const sessionDirs = await listSessionDirectories(sessionsRoot);
  const sessions: SparkSessionIndexEntry[] = [];
  for (const name of sessionDirs) {
    const entry = await buildSessionIndexEntry(cwd, name);
    if (entry) sessions.push(entry);
  }
  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const snapshot: SparkSessionIndexSnapshot = {
    version: 1,
    rebuildable: true,
    generatedAt: nowIso(),
    source: "per-session-directories",
    legacyImportOnly: [
      ".spark/sessions/<owner>.json",
      ".spark/session-goals/<session>.json",
      ".spark/session-loops/<session>.json",
      ".spark/session-todos/<session>.json",
      ".spark/todo-display-numbers/<session>.json",
      ".spark/background-role-results-inbox/<session>.json",
    ],
    sessions,
  };
  await writeJsonFileAtomic(sessionIndexStorePath(cwd), snapshot);
  return snapshot;
}

export function sessionIndexStorePath(cwd: string): string {
  return join(cwd, ".spark", "sessions", "index.json");
}

async function listSessionDirectories(sessionsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "index.json");
}

async function buildSessionIndexEntry(
  cwd: string,
  directoryName: string,
): Promise<SparkSessionIndexEntry | undefined> {
  const sessionKey = sessionKeyFromDirectoryName(directoryName);
  const base = join(cwd, ".spark", "sessions", directoryName);
  const relativeBase = join("sessions", directoryName);
  const statePath = join(base, "state.json");
  const goalPath = join(base, "goal.json");
  const loopPath = join(base, "loop.json");
  const displayPath = join(base, "todo-display-numbers.json");
  const inboxPath = join(base, "hidden-role-run-inbox.json");
  const state = await readJsonObject(statePath);
  const goal = await readJsonObject(goalPath);
  const loop = await readJsonObject(loopPath);
  const updatedAt = await newestMtimeIso([statePath, goalPath, loopPath, displayPath, inboxPath]);
  if (!updatedAt) return undefined;
  const goalObject = isRecord(goal?.goal) ? goal.goal : undefined;
  const loopObject = isRecord(loop?.loop) ? loop.loop : undefined;
  return {
    sessionKey,
    path: relativeBase,
    statePath: join(relativeBase, "state.json"),
    goalPath: join(relativeBase, "goal.json"),
    loopPath: join(relativeBase, "loop.json"),
    todoDisplayNumbersPath: join(relativeBase, "todo-display-numbers.json"),
    hiddenRoleRunInboxPath: join(relativeBase, "hidden-role-run-inbox.json"),
    todoOwnerRef: sessionKey,
    currentProjectRef:
      typeof state?.projectRef === "string" ? (state.projectRef as ProjectRef) : undefined,
    currentTaskRef:
      typeof state?.currentTaskRef === "string" ? (state.currentTaskRef as TaskRef) : undefined,
    activeGoal: goalObject?.status === "active",
    activeLoop: loopObject?.status === "active",
    updatedAt,
  };
}

function sessionKeyFromDirectoryName(directoryName: string): string {
  const normalized = directoryName.replaceAll(/-+/gu, "-");
  if (normalized.startsWith("session-")) return `session:${normalized.slice("session-".length)}`;
  if (normalized.startsWith("leaf-")) return `leaf:${normalized.slice("leaf-".length)}`;
  return normalized;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  return readJsonFileOptional<Record<string, unknown>>(filePath);
}

async function newestMtimeIso(paths: string[]): Promise<string | undefined> {
  let newest = 0;
  for (const filePath of paths) {
    try {
      const info = await stat(filePath);
      if (info.isFile()) newest = Math.max(newest, info.mtimeMs);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
