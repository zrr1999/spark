import type { ExtensionRoleRunner } from "@zendev-lab/spark-extension-api";
import {
  loadSparkHeadlessSessionModule,
  type SparkHeadlessSessionModule,
} from "@zendev-lab/spark-host/headless-loader";

export interface RoleNativeExecutorResolverDeps {
  loadHeadlessModule?: typeof loadSparkHeadlessSessionModule;
}

export type RoleNativeExecutorResolver = (input: {
  runRole?: ExtensionRoleRunner;
}) => Promise<ExtensionRoleRunner>;

export function createRoleNativeExecutorResolver(
  deps: RoleNativeExecutorResolverDeps = {},
): RoleNativeExecutorResolver {
  let fallbackPromise: Promise<ExtensionRoleRunner> | undefined;
  return async (input) => {
    if (input.runRole) return input.runRole;
    fallbackPromise ??= loadFallbackHeadlessRoleExecutor(deps);
    return await fallbackPromise;
  };
}

export const resolveRoleNativeExecutor = createRoleNativeExecutorResolver();

async function loadFallbackHeadlessRoleExecutor(
  deps: RoleNativeExecutorResolverDeps,
): Promise<ExtensionRoleRunner> {
  const loadHeadlessModule = deps.loadHeadlessModule ?? loadSparkHeadlessSessionModule;
  let module: SparkHeadlessSessionModule;
  try {
    module = await loadHeadlessModule();
  } catch (error) {
    return failedRoleExecutor(
      `daemon-native role executor load failed: ${unknownErrorMessage(error)}`,
    );
  }

  const createExecutor = module.createSparkHeadlessRoleExecutor;
  if (typeof createExecutor !== "function") {
    return failedRoleExecutor(
      "daemon-native role executor load failed: headless module does not export createSparkHeadlessRoleExecutor",
    );
  }

  let executor: unknown;
  try {
    executor = (createExecutor as (options?: { sparkHome?: string }) => unknown)();
  } catch (error) {
    return failedRoleExecutor(
      `daemon-native role executor initialization failed: ${unknownErrorMessage(error)}`,
    );
  }

  if (typeof executor !== "function") {
    return failedRoleExecutor(
      "daemon-native role executor initialization failed: createSparkHeadlessRoleExecutor did not return a function",
    );
  }

  return async (request) => await (executor as ExtensionRoleRunner)(request);
}

function failedRoleExecutor(reason: string): ExtensionRoleRunner {
  return async () => {
    throw new Error(reason);
  };
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
