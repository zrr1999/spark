/** Path helpers for Spark CLI daemon state. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SparkDaemonPathOptions {
  sparkHome?: string;
  daemonRoot?: string;
}

export function defaultSparkHome(sparkHome?: string): string {
  return resolve(sparkHome ?? process.env.SPARK_HOME ?? join(homedir(), ".spark"));
}

export function defaultSparkDaemonRoot(options: SparkDaemonPathOptions = {}): string {
  return resolve(options.daemonRoot ?? join(defaultSparkHome(options.sparkHome), "daemon"));
}

export function defaultSparkDaemonRuntimeDir(sparkHome?: string): string {
  return join(defaultSparkHome(sparkHome), "runtime");
}
