import type { ExtensionRoleRunner } from "@zendev-lab/spark-core";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadSparkHeadlessSessionModule,
  type SparkHeadlessSessionModule,
} from "@zendev-lab/spark-host/headless-loader";

export interface RoleNativeExecutorResolverDeps {
  loadHeadlessModule?: typeof loadSparkHeadlessSessionModule;
  moduleSpecifier?: string;
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
    module = await loadHeadlessModule({
      moduleSpecifier: deps.moduleSpecifier ?? resolveSparkSourceHeadlessExecutorSpecifier(),
    });
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

/**
 * Resolve the monorepo source executor from the Spark roles package itself.
 *
 * Pi's extension loader aliases the `@earendil-works/pi-ai` package root to
 * its compatibility entrypoint for legacy extensions. Loading Spark's native
 * host through that jiti graph makes nested modern `pi-ai` imports inherit the
 * broad alias and corrupts subpaths. A real source file URL keeps the native
 * executor on Node's ESM resolver, where package export maps remain authoritative.
 */
export function resolveSparkSourceHeadlessExecutorSpecifier(): string {
  const rolesDirectory = dirname(realpathSync(new URL(import.meta.url)));
  return pathToFileURL(
    join(rolesDirectory, "../../../apps/spark-tui/src/headless-role-executor.ts"),
  ).href;
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
