/** Builtin extension loader for the native Spark CLI host. */

import type { ExtensionAPI } from "@zendev-lab/pi-extension-api";

import piAskExtension from "../../../pi-ask/src/extension.ts";
import piCueExtension from "../../../pi-cue/src/index.ts";
import piGraftExtension from "../../../pi-graft/src/extension.ts";
import piRolesExtension from "../../../pi-roles/src/extension.ts";
import sparkExtension from "../../../spark/src/extension/index.ts";

export type SparkBuiltinExtensionName =
  | "@zendev-lab/pi-ask"
  | "@zendev-lab/pi-cue"
  | "@zendev-lab/pi-graft"
  | "@zendev-lab/pi-roles"
  | "spark";

export type SparkExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface SparkBuiltinExtensionFactory {
  name: SparkBuiltinExtensionName;
  specifier: string;
  factory: SparkExtensionFactory;
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
  api: ExtensionAPI;
  extensions?: string[];
  importer?: (specifier: string) => Promise<unknown>;
}

export const DEFAULT_SPARK_EXTENSION_SPECS = [
  "@zendev-lab/pi-ask/extension",
  "@zendev-lab/pi-cue/extension",
  "@zendev-lab/pi-roles/extension",
  "@zendev-lab/pi-graft/extension",
  "@zendev-lab/spark/extension",
] as const;

const BUILTIN_EXTENSION_FACTORIES: readonly SparkBuiltinExtensionFactory[] = [
  {
    name: "@zendev-lab/pi-ask",
    specifier: "@zendev-lab/pi-ask/extension",
    factory: piAskExtension as SparkExtensionFactory,
  },
  {
    name: "@zendev-lab/pi-cue",
    specifier: "@zendev-lab/pi-cue/extension",
    factory: piCueExtension as SparkExtensionFactory,
  },
  {
    name: "@zendev-lab/pi-roles",
    specifier: "@zendev-lab/pi-roles/extension",
    factory: piRolesExtension as SparkExtensionFactory,
  },
  {
    name: "@zendev-lab/pi-graft",
    specifier: "@zendev-lab/pi-graft/extension",
    factory: piGraftExtension as SparkExtensionFactory,
  },
  {
    name: "spark",
    specifier: "@zendev-lab/spark/extension",
    factory: sparkExtension as SparkExtensionFactory,
  },
];

export class SparkExtensionLoader {
  private readonly api: ExtensionAPI;
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
          `Extension plugin "${specifier}" must default-export a function(api: ExtensionAPI)`,
        );
      }
      const result = (factory as SparkExtensionFactory)(this.api);
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

export function loadBuiltinExtensionFactories(): SparkBuiltinExtensionFactory[] {
  return BUILTIN_EXTENSION_FACTORIES.map((entry) => ({ ...entry }));
}

export function getBuiltinExtensionFactory(
  specifier: string,
): SparkBuiltinExtensionFactory | undefined {
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
