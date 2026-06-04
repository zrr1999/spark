/**
 * Plugin loader for spark-cli — loads extensions[] and providers[] plugin
 * lists from `~/.spark/config.json` via the same import-default mechanism
 * but with two distinct surfaces:
 *
 *   - extension plugins → call default(api: ExtensionAPI)  (pi-extension-api)
 *   - provider plugins  → call default(api: ProviderRegistrationAPI)
 *
 * Errors loading individual plugins are *isolated*: a failed import or a
 * thrown registration must not prevent the rest of the configured plugins
 * from loading. The loader returns a `LoadResult` describing successes and
 * failures so the spark-cli TUI can surface a startup banner.
 *
 * The loader does no network I/O. Module resolution is delegated to Node's
 * dynamic `import()` so users can list both bare package specifiers
 * (`pi-cue`, `spark/extension`) and absolute file URLs.
 */

import type { ExtensionAPI } from "pi-extension-api";

import { createSparkExtensionImporter } from "./extension-loader.ts";
import type { ProviderRegistrationAPI } from "./provider-registry.ts";

export type PluginKind = "extension" | "provider";

export interface PluginLoadOutcome {
  specifier: string;
  kind: PluginKind;
  ok: boolean;
  error?: string;
}

export interface LoadResult {
  outcomes: PluginLoadOutcome[];
}

export interface LoadPluginsOptions {
  extensionApi: ExtensionAPI;
  providerApi: ProviderRegistrationAPI;
  extensions: string[];
  providers: string[];
  /**
   * Optional dynamic import override for tests. Defaults to global `import()`.
   */
  importer?: (specifier: string) => Promise<unknown>;
}

export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadResult> {
  const importer = options.importer ?? createSparkExtensionImporter(defaultImporter);
  const outcomes: PluginLoadOutcome[] = [];

  for (const specifier of options.extensions) {
    outcomes.push(
      await invokePlugin(specifier, "extension", importer, (mod) => {
        const factory = pickDefault(mod);
        if (typeof factory !== "function") {
          throw new Error(
            `Extension plugin "${specifier}" must default-export a function(api: ExtensionAPI)`,
          );
        }
        const result = factory(options.extensionApi);
        return result instanceof Promise ? result : Promise.resolve();
      }),
    );
  }

  for (const specifier of options.providers) {
    outcomes.push(
      await invokePlugin(specifier, "provider", importer, (mod) => {
        const factory = pickDefault(mod);
        if (typeof factory !== "function") {
          throw new Error(
            `Provider plugin "${specifier}" must default-export a function(api: ProviderRegistrationAPI)`,
          );
        }
        const result = factory(options.providerApi);
        return result instanceof Promise ? result : Promise.resolve();
      }),
    );
  }

  return { outcomes };
}

async function invokePlugin(
  specifier: string,
  kind: PluginKind,
  importer: (specifier: string) => Promise<unknown>,
  invoke: (mod: unknown) => Promise<void>,
): Promise<PluginLoadOutcome> {
  try {
    const mod = await importer(specifier);
    await invoke(mod);
    return { specifier, kind, ok: true };
  } catch (error) {
    return {
      specifier,
      kind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pickDefault(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: unknown }).default;
  }
  return mod;
}

async function defaultImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}
