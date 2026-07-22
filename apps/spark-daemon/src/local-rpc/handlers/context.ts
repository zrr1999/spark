import type { DatabaseSync } from "node:sqlite";
import type { SparkPaths } from "@zendev-lab/spark-system";
import type {
  ensureSparkDaemonRegistrationForWorkspace,
  unbindSparkDaemonWorkspaceFromCockpit,
  verifySparkDaemonWorkspaceConnection,
} from "../../registration.js";
import type { LocalRpcHandlerOptions } from "../types.ts";

export interface LocalRpcDispatchContext {
  paths: SparkPaths;
  db: DatabaseSync;
  onStop: (() => void | Promise<void>) | undefined;
  options: LocalRpcHandlerOptions;
  ensureRegistration: typeof ensureSparkDaemonRegistrationForWorkspace;
  verifyWorkspaceConnection: typeof verifySparkDaemonWorkspaceConnection;
  unbindWorkspaceFromCockpit: typeof unbindSparkDaemonWorkspaceFromCockpit;
}
