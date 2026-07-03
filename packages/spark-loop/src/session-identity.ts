import { stableId } from "@zendev-lab/spark-extension-api";

export interface SparkSessionContext {
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
}

export function sparkSessionKey(ctx?: SparkSessionContext): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session:${stableId(sessionFile)}`;
  const leaf = ctx?.sessionManager?.getLeafId?.();
  if (leaf) return `leaf:${leaf}`;
  return "session:ephemeral";
}

export function sparkSessionOwnerKey(ctx?: SparkSessionContext): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session:${stableId(sessionFile)}`;
  return sparkSessionKey(ctx);
}

export function sanitizeStoreScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}
