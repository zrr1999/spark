/** Execute queued `session.run` daemon tasks through SparkAgentSession. */

import { join } from "node:path";

import {
  createSparkCliHostServices,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
} from "../bootstrap.ts";
import { SparkAgentSession } from "../agent-session.ts";
import type { SparkDaemonTask, SparkDaemonTaskExecutor } from "./types.ts";

export interface SparkDaemonSessionRunExecutorOptions {
  cwd: string;
  sparkHome?: string;
  createServices?: (options: SparkCliHostServicesOptions) => Promise<SparkCliHostServices>;
}

export interface SparkDaemonSessionRunExecutionResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
}

export function createSparkDaemonSessionRunExecutor(
  options: SparkDaemonSessionRunExecutorOptions,
): SparkDaemonTaskExecutor {
  return async (task) => {
    return await runSparkDaemonSessionRunTask(task, options);
  };
}

export async function runSparkDaemonSessionRunTask(
  task: SparkDaemonTask,
  options: SparkDaemonSessionRunExecutorOptions,
): Promise<SparkDaemonSessionRunExecutionResult> {
  const createServices = options.createServices ?? createSparkCliHostServices;
  const services = await createServices({
    cwd: options.cwd,
    sparkHome: options.sparkHome,
    configPath: options.sparkHome ? join(options.sparkHome, "config.json") : undefined,
    hasUI: false,
  });
  const session = new SparkAgentSession(services);
  const result = await session.run({
    sessionId: task.sessionId,
    prompt: task.prompt,
    reset: task.reset,
  });
  return {
    sessionId: result.sessionId,
    sessionPath: result.sessionPath,
    newMessageCount: result.newMessageCount,
    assistantText: result.assistantText,
  };
}
