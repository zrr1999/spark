import { createLogger, type Logger, type Plugin } from "vite";

const outsidePackageSourcemap =
  /Sourcemap for "[^"]*(?:node_modules\/\.vite\/(?:vitest\/[^/]+\/)?deps\/(?:@lucide_svelte|bits-ui|streamdown-svelte)[^/"]*\.js|node_modules\/\.pnpm\/entities@[^/]+\/node_modules\/entities\/)[^"]*" points to a source file outside its package:/u;

const missingParse5Sourcemap =
  /Failed to load source map for [^\n]*node_modules\/\.pnpm\/parse5@[^/]+\/node_modules\/parse5\/[^\n]*\.\n[\s\S]*ENOENT:[^\n]*\.js\.map/u;

const missingRehypeHardenSources =
  /Sourcemap for "[^"]*node_modules\/\.pnpm\/rehype-harden@[^/]+\/node_modules\/rehype-harden\/dist\/index\.js" points to missing source files/u;

/**
 * Vite+ 0.2.x reports invalid or missing maps published by these dependencies
 * as application warnings. They do not affect transformed code or browser
 * debugging for Spark-owned sources, but can flood one preview start with
 * thousands of lines and hide actionable diagnostics.
 */
export function shouldSuppressDependencySourcemapDiagnostic(message: string): boolean {
  return (
    outsidePackageSourcemap.test(message) ||
    missingParse5Sourcemap.test(message) ||
    missingRehypeHardenSources.test(message)
  );
}

export function createDependencySourcemapFilteringLogger(): Logger {
  return filterDependencySourcemapDiagnostics(createLogger());
}

export function dependencySourcemapDiagnosticFilter(): Plugin {
  return {
    name: "spark-dependency-sourcemap-diagnostic-filter",
    configResolved(config) {
      filterDependencySourcemapDiagnostics(config.logger);
    },
  };
}

function filterDependencySourcemapDiagnostics(logger: Logger): Logger {
  const warn = logger.warn.bind(logger);
  const warnOnce = logger.warnOnce.bind(logger);

  logger.warn = (message, options) => {
    if (!shouldSuppressDependencySourcemapDiagnostic(message)) {
      warn(message, options);
    }
  };
  logger.warnOnce = (message, options) => {
    if (!shouldSuppressDependencySourcemapDiagnostic(message)) {
      warnOnce(message, options);
    }
  };
  return logger;
}
