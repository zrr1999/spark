import { basename, dirname, join } from "node:path";

import { stableId } from "@zendev-lab/spark-extension-api";

export interface SparkSessionContext {
  cwd?: string;
  /** Optional absolute path to the Spark state root directory (`.../.spark`). */
  sparkStateRoot?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
}

export function sparkSessionKey(ctx?: SparkSessionContext): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session:${stableId(sessionFile)}`;
  const leaf = ctx?.sessionManager?.getLeafId?.();
  if (leaf) {
    if (leaf.startsWith("session:") || leaf.startsWith("leaf:")) return leaf;
    return `leaf:${leaf}`;
  }
  return "session:ephemeral";
}

export function sparkSessionOwnerKey(ctx?: SparkSessionContext): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session:${stableId(sessionFile)}`;
  return sparkSessionKey(ctx);
}

export function sparkStateRootPath(cwd: string, ctx?: SparkSessionContext): string {
  return ctx?.sparkStateRoot?.trim() || join(cwd, ".spark");
}

export function sparkStateCwd(cwd: string, ctx?: SparkSessionContext): string {
  const root = sparkStateRootPath(cwd, ctx);
  return basename(root) === ".spark" ? dirname(root) : cwd;
}

export function sanitizeStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}
