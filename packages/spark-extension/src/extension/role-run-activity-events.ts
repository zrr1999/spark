import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RunRef } from "@zendev-lab/spark-core";
import type { SparkRoleRunActivityEventInput } from "./spark-role-run-observability.ts";

interface RoleRunActivityEventStoreSnapshot {
  version: 1;
  events: SparkRoleRunActivityEventInput[];
}

export async function loadRoleRunActivityEvents(
  cwd: string,
): Promise<SparkRoleRunActivityEventInput[]> {
  const path = roleRunActivityEventsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return normalizeRoleRunActivityEventStoreSnapshot(parsed, path).events;
}

export async function appendRoleRunActivityEvent(
  cwd: string,
  event: SparkRoleRunActivityEventInput,
): Promise<void> {
  const path = roleRunActivityEventsPath(cwd);
  const current = await loadRoleRunActivityEvents(cwd);
  await mkdir(dirname(path), { recursive: true });
  const snapshot: RoleRunActivityEventStoreSnapshot = {
    version: 1,
    events: [...current, cloneEvent(event)],
  };
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function roleRunActivityEventsForRun(
  events: SparkRoleRunActivityEventInput[],
  runRef: RunRef,
): SparkRoleRunActivityEventInput[] {
  return events.filter((event) => event.runRef === runRef);
}

function roleRunActivityEventsPath(cwd: string): string {
  return join(cwd, ".spark", "role-run-activity-events.json");
}

function normalizeRoleRunActivityEventStoreSnapshot(
  value: unknown,
  path: string,
): RoleRunActivityEventStoreSnapshot {
  if (!value || typeof value !== "object")
    throw new Error(`${path}: role-run activity store must be an object`);
  const version = (value as { version?: unknown }).version;
  if (version !== 1) throw new Error(`${path}: role-run activity store version must be 1`);
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events))
    throw new Error(`${path}: role-run activity store events must be an array`);
  return {
    version: 1,
    events: events.map((event, index) => normalizeEvent(event, `${path}: events[${index}]`)),
  };
}

function normalizeEvent(value: unknown, label: string): SparkRoleRunActivityEventInput {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  const runRef = requiredString((value as { runRef?: unknown }).runRef, `${label}.runRef`);
  if (!runRef.startsWith("run:")) throw new Error(`${label}.runRef must be a run ref`);
  const type = requiredString((value as { type?: unknown }).type, `${label}.type`);
  if (
    !["tool_activity", "message_activity", "waiting_for_user", "replied", "interrupted"].includes(
      type,
    )
  )
    throw new Error(`${label}.type is not a supported role-run activity event`);
  const at = requiredString((value as { at?: unknown }).at, `${label}.at`);
  const output: SparkRoleRunActivityEventInput = {
    runRef: runRef as RunRef,
    type: type as SparkRoleRunActivityEventInput["type"],
    at,
  };
  const message = optionalString((value as { message?: unknown }).message, `${label}.message`);
  if (message) output.message = message;
  const toolName = optionalString((value as { toolName?: unknown }).toolName, `${label}.toolName`);
  if (toolName) output.toolName = toolName;
  const messageRole = optionalString(
    (value as { messageRole?: unknown }).messageRole,
    `${label}.messageRole`,
  );
  if (messageRole)
    output.messageRole = messageRole as SparkRoleRunActivityEventInput["messageRole"];
  const artifactRefs = optionalStringArray(
    (value as { artifactRefs?: unknown }).artifactRefs,
    `${label}.artifactRefs`,
  );
  if (artifactRefs)
    output.artifactRefs = artifactRefs as SparkRoleRunActivityEventInput["artifactRefs"];
  const usage = (value as { usage?: unknown }).usage;
  if (usage !== undefined)
    output.usage = JSON.parse(JSON.stringify(usage)) as SparkRoleRunActivityEventInput["usage"];
  return output;
}

function cloneEvent(event: SparkRoleRunActivityEventInput): SparkRoleRunActivityEventInput {
  return JSON.parse(JSON.stringify(event)) as SparkRoleRunActivityEventInput;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim() || undefined;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}
