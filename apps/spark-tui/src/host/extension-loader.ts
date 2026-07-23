/** Builtin extension loader for the native Spark TUI host. */

import type { SparkHostAPI } from "@zendev-lab/spark-core";

import sparkAskExtension from "@zendev-lab/spark-ask/extension";
import sparkCueExtension from "@zendev-lab/spark-cue/extension";
import sparkFilesExtension from "@zendev-lab/spark-files/extension";
import sparkFusionExtension from "@zendev-lab/spark-fusion/extension";
import sparkMemoryExtension from "@zendev-lab/spark-memory/extension";
import sparkRolesExtension from "@zendev-lab/spark-roles/extension";
import sparkSessionExtension from "@zendev-lab/spark-session/extension";
import sparkWebExtension from "@zendev-lab/spark-web/extension";

import { DEFAULT_SPARK_EXTENSION_SPECS } from "./extension-specs.ts";

export { DEFAULT_SPARK_EXTENSION_SPECS } from "./extension-specs.ts";
import sparkModelsExtension from "@zendev-lab/spark-ai/models-extension";
import sparkExtension from "@zendev-lab/spark-extension/extension";

export type SparkBuiltinExtensionName =
  | "@zendev-lab/spark-ask"
  | "@zendev-lab/spark-cue"
  | "@zendev-lab/spark-files"
  | "@zendev-lab/spark-fusion"
  | "@zendev-lab/spark-graft"
  | "@zendev-lab/spark-memory"
  | "@zendev-lab/spark-roles"
  | "@zendev-lab/spark-session"
  | "@zendev-lab/spark-web"
  | "@zendev-lab/spark-ai"
  | "spark";

export type SparkCapabilityFactory = (api: SparkHostAPI) => void | Promise<void>;

export interface SparkBuiltinCapabilityFactory {
  name: SparkBuiltinExtensionName;
  specifier: string;
  factory: SparkCapabilityFactory;
}

export interface SparkExtensionLoadOutcome {
  specifier: string;
  kind: "extension";
  ok: boolean;
  builtin?: boolean;
  error?: string;
}

export interface SparkExtensionLoadResult {
  outcomes: SparkExtensionLoadOutcome[];
}

export interface SparkExtensionLoaderOptions {
  api: SparkHostAPI;
  extensions?: string[];
  importer?: (specifier: string) => Promise<unknown>;
}

const BUILTIN_EXTENSION_FACTORIES: readonly SparkBuiltinCapabilityFactory[] = [
  {
    name: "@zendev-lab/spark-ask",
    specifier: "@zendev-lab/spark-ask/extension",
    factory: sparkAskExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-cue",
    specifier: "@zendev-lab/spark-cue/extension",
    factory: sparkCueExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-files",
    specifier: "@zendev-lab/spark-files/extension",
    factory: sparkFilesExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-fusion",
    specifier: "@zendev-lab/spark-fusion/extension",
    factory: sparkFusionExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-ai",
    specifier: "@zendev-lab/spark-ai/models-extension",
    factory: sparkModelsExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-memory",
    specifier: "@zendev-lab/spark-memory/extension",
    factory: sparkMemoryExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-roles",
    specifier: "@zendev-lab/spark-roles/extension",
    factory: sparkRolesExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-session",
    specifier: "@zendev-lab/spark-session/extension",
    factory: sparkSessionExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-web",
    specifier: "@zendev-lab/spark-web/extension",
    factory: sparkWebExtension as SparkCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-graft",
    specifier: "@zendev-lab/spark-graft/extension",
    factory: loadSparkGraftExtension,
  },
  {
    name: "spark",
    specifier: "@zendev-lab/spark-extension/extension",
    factory: sparkExtension as SparkCapabilityFactory,
  },
];

async function loadSparkGraftExtension(api: SparkHostAPI): Promise<void> {
  // Graft is an optional compatibility package. Keep module evaluation off the
  // default startup path and import it only after explicit config/CLI opt-in.
  const module = await import("@zendev-lab/spark-graft/extension");
  await (module.default as SparkCapabilityFactory)(api);
}

export class SparkExtensionLoader {
  private readonly api: SparkHostAPI;
  private readonly extensions: string[];
  private readonly importer: (specifier: string) => Promise<unknown>;

  constructor(options: SparkExtensionLoaderOptions) {
    this.api = options.api;
    this.extensions = options.extensions ?? [...DEFAULT_SPARK_EXTENSION_SPECS];
    this.importer = options.importer ?? createSparkExtensionImporter();
  }

  async load(): Promise<SparkExtensionLoadResult> {
    const outcomes: SparkExtensionLoadOutcome[] = [];
    for (const specifier of this.extensions) {
      outcomes.push(await this.loadOne(specifier));
    }
    return { outcomes };
  }

  private async loadOne(specifier: string): Promise<SparkExtensionLoadOutcome> {
    try {
      const builtin = getBuiltinExtensionFactory(specifier);
      const mod = builtin ? { default: builtin.factory } : await this.importer(specifier);
      const factory = pickDefault(mod);
      if (typeof factory !== "function") {
        throw new Error(
          `Extension plugin "${specifier}" must default-export a function(api: SparkHostAPI)`,
        );
      }
      const result = (factory as SparkCapabilityFactory)(this.api);
      if (result instanceof Promise) await result;
      return { specifier, kind: "extension", ok: true, builtin: Boolean(builtin) };
    } catch (error) {
      return {
        specifier,
        kind: "extension",
        ok: false,
        builtin: Boolean(getBuiltinExtensionFactory(specifier)),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function loadBuiltinExtensionFactories(): SparkBuiltinCapabilityFactory[] {
  return BUILTIN_EXTENSION_FACTORIES.map((entry) => ({ ...entry }));
}

export function getBuiltinExtensionFactory(
  specifier: string,
): SparkBuiltinCapabilityFactory | undefined {
  return BUILTIN_EXTENSION_FACTORIES.find((entry) => entry.specifier === specifier);
}

export function createSparkExtensionImporter(
  fallbackImporter: (specifier: string) => Promise<unknown> = defaultImporter,
): (specifier: string) => Promise<unknown> {
  return async (specifier) => {
    const builtin = getBuiltinExtensionFactory(specifier);
    if (builtin) return { default: builtin.factory };
    return fallbackImporter(specifier);
  };
}

export async function loadSparkExtensions(
  options: SparkExtensionLoaderOptions,
): Promise<SparkExtensionLoadResult> {
  return new SparkExtensionLoader(options).load();
}

function pickDefault(mod: unknown): unknown {
  if (mod && typeof mod === "object" && "default" in mod)
    return (mod as { default: unknown }).default;
  return mod;
}

async function defaultImporter(specifier: string): Promise<unknown> {
  return import(specifier);
}
