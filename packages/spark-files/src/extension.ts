/**
 * spark-files extension — registers working-tree file tools on a Pi host.
 *
 * Registers read / write / edit / ls / grep / find via `pi.registerTool`.
 * Intentionally omits a `bash` tool: Spark uses `cue_exec` for shell
 * execution and spark-cue disables bash by policy.
 */

import {
  createEditToolConfig,
  createLsToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
} from "./file-tools.ts";
import { createFindToolConfig, createGrepToolConfig } from "./search-tools.ts";

export interface SparkFilesHostApi {
  registerTool(config: import("@zendev-lab/spark-core").ToolConfig): void;
}

export interface SparkFilesOptions {
  /** Tool names to register. Defaults to all six. */
  tools?: ReadonlyArray<"read" | "write" | "edit" | "ls" | "grep" | "find">;
}

export function registerSparkFilesTools(
  pi: SparkFilesHostApi,
  options: SparkFilesOptions = {},
): void {
  const enabled = new Set(options.tools ?? ["read", "write", "edit", "ls", "grep", "find"]);
  if (enabled.has("read")) pi.registerTool(createReadToolConfig());
  if (enabled.has("write")) pi.registerTool(createWriteToolConfig());
  if (enabled.has("edit")) pi.registerTool(createEditToolConfig());
  if (enabled.has("ls")) pi.registerTool(createLsToolConfig());
  if (enabled.has("grep")) pi.registerTool(createGrepToolConfig());
  if (enabled.has("find")) pi.registerTool(createFindToolConfig());
}

export default function piFilesExtension(pi: SparkFilesHostApi): void {
  registerSparkFilesTools(pi);
}
