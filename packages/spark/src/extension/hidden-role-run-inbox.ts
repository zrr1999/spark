import { join } from "node:path";

import type { RunRef } from "pi-extension-api";
import { JsonStoreFormatError, readJsonFileOptional, writeJsonFileAtomic } from "./json-store.ts";
import {
  sanitizeStoreScope,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export interface HiddenRoleRunInboxState {
  version: 1;
  delivered: Array<{ runRef: RunRef; deliveredAt: string }>;
}

export async function loadHiddenRoleRunInboxState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<HiddenRoleRunInboxState> {
  const filePath = hiddenRoleRunInboxStorePath(cwd, ctx);
  const raw = await readJsonFileOptional<Record<string, unknown>>(filePath);
  if (!raw) return { version: 1, delivered: [] };
  return normalizeHiddenRoleRunInboxState(raw, filePath);
}

export async function saveHiddenRoleRunInboxState(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  state: HiddenRoleRunInboxState,
): Promise<void> {
  await writeJsonFileAtomic(hiddenRoleRunInboxStorePath(cwd, ctx), state);
}

function hiddenRoleRunInboxStorePath(cwd: string, ctx: SparkSessionContext | undefined): string {
  return join(
    cwd,
    ".spark",
    "background-role-results-inbox",
    `${sanitizeStoreScope(sparkSessionOwnerKey(ctx))}.json`,
  );
}

function normalizeHiddenRoleRunInboxState(
  raw: Record<string, unknown>,
  filePath: string,
): HiddenRoleRunInboxState {
  if ("deliveredRunRefs" in raw) {
    throw new JsonStoreFormatError(
      filePath,
      "deliveredRunRefs is no longer supported; repair this store to version 1 delivered entries",
    );
  }
  if (raw.version !== 1) {
    throw new JsonStoreFormatError(filePath, "version must be 1");
  }
  if (!Array.isArray(raw.delivered)) {
    throw new JsonStoreFormatError(filePath, "delivered must be an array");
  }
  const delivered = raw.delivered.map((entry, index) =>
    normalizeHiddenRoleRunInboxEntry(entry, filePath, index),
  );
  return { version: 1, delivered };
}

function normalizeHiddenRoleRunInboxEntry(
  value: unknown,
  filePath: string,
  index: number,
): { runRef: RunRef; deliveredAt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonStoreFormatError(filePath, `delivered[${index}] must be an object`);
  }
  const entry = value as { runRef?: unknown; deliveredAt?: unknown };
  if (typeof entry.runRef !== "string" || !entry.runRef.trim()) {
    throw new JsonStoreFormatError(
      filePath,
      `delivered[${index}].runRef must be a non-empty string`,
    );
  }
  if (typeof entry.deliveredAt !== "string" || !entry.deliveredAt.trim()) {
    throw new JsonStoreFormatError(
      filePath,
      `delivered[${index}].deliveredAt must be a non-empty string`,
    );
  }
  return { runRef: entry.runRef as RunRef, deliveredAt: entry.deliveredAt };
}
