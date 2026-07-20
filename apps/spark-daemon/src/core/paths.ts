/** Path helpers for Spark daemon core state. */

import { join, resolve } from "node:path";
import { resolveSparkHome, resolveSparkPaths, type SparkPaths } from "@zendev-lab/spark-system";

export interface SparkDaemonPathOptions {
  sparkHome?: string;
  daemonRoot?: string;
  runtimeDir?: string;
  paths?: Pick<SparkPaths, "dataDir" | "runtimeDir">;
}

export function defaultSparkHome(sparkHome?: string): string {
  return resolveSparkHome({ sparkHome });
}

export function legacySparkDaemonQueueRoot(options: SparkDaemonPathOptions = {}): string {
  return resolve(
    options.daemonRoot ??
      (options.paths
        ? join(options.paths.dataDir, "queue")
        : join(defaultSparkHome(options.sparkHome), "daemon")),
  );
}

export function defaultSparkDaemonRuntimeDir(sparkHome?: string): string {
  return resolveSparkPaths({ app: "daemon", sparkHome }).runtimeDir;
}

export function sparkDaemonRuntimeDir(options: SparkDaemonPathOptions = {}): string {
  return resolve(
    options.runtimeDir ??
      options.paths?.runtimeDir ??
      defaultSparkDaemonRuntimeDir(options.sparkHome),
  );
}
