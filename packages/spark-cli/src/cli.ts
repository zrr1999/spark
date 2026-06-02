import { fileURLToPath } from "node:url";
import registerBaiduOneApiProvider from "./baidu-oneapi-provider.ts";

const SPARK_SKILLS_DIR = fileURLToPath(new URL("../../spark/skills", import.meta.url));

type SparkCliExtensionFactory = (pi: never) => void | Promise<void>;

interface BuiltinExtensionSpec {
  packageSubpath: string;
  fallbackPath: string;
}

interface SparkCliServices {
  diagnostics: unknown[];
}

interface SparkCliRuntimeResult {
  services: SparkCliServices;
  diagnostics: unknown[];
  [key: string]: unknown;
}

interface SparkCliRuntime {
  dispose(): Promise<void>;
}

interface SparkCliSdk {
  createAgentSessionServices(options: {
    cwd: string;
    agentDir: string;
    resourceLoaderOptions: {
      noExtensions?: boolean;
      noSkills?: boolean;
      additionalSkillPaths: string[];
      extensionFactories: SparkCliExtensionFactory[];
    };
  }): Promise<SparkCliServices>;
  createAgentSessionFromServices(options: {
    services: SparkCliServices;
    sessionManager: unknown;
    sessionStartEvent?: unknown;
  }): Promise<Record<string, unknown>>;
  createAgentSessionRuntime(
    createRuntime: (options: {
      cwd: string;
      agentDir: string;
      sessionManager: unknown;
      sessionStartEvent?: unknown;
    }) => Promise<SparkCliRuntimeResult>,
    options: { cwd: string; agentDir: string; sessionManager: unknown },
  ): Promise<SparkCliRuntime>;
  getAgentDir(): string;
  InteractiveMode: new (
    runtime: SparkCliRuntime,
    options: {
      initialMessage?: string;
      initialImages: unknown[];
      initialMessages: string[];
      migratedProviders: string[];
      modelFallbackMessage?: string;
    },
  ) => { run(): Promise<void> };
  SessionManager: { create(cwd: string): unknown };
}

interface ExtensionFactoryModule {
  default: SparkCliExtensionFactory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredFunction<T>(exports: Record<string, unknown>, name: string): T {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new Error(`@earendil-works/pi-coding-agent export ${name} must be a function`);
  }
  return value as T;
}

export interface SparkCliArgs {
  initialMessage?: string;
  help: boolean;
}

export function parseSparkCliArgs(argv: string[]): SparkCliArgs {
  if (argv.some((arg) => arg === "-h" || arg === "--help")) return { help: true };
  const initialMessage = argv.join(" ").trim();
  return { help: false, initialMessage: initialMessage || undefined };
}

export async function runSparkCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseSparkCliArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const sdk = await loadPiSdk();
  const builtinExtensionFactories = await loadBuiltinExtensionFactories();
  const cwd = process.cwd();
  const agentDir = sdk.getAgentDir();

  const createRuntime = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    sessionManager: unknown;
    sessionStartEvent?: unknown;
  }): Promise<SparkCliRuntimeResult> => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        additionalSkillPaths: [SPARK_SKILLS_DIR],
        extensionFactories: builtinExtensionFactories,
      },
    });

    return {
      ...(await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: sdk.SessionManager.create(cwd),
  });

  try {
    const mode = new sdk.InteractiveMode(runtime, {
      initialMessage: args.initialMessage,
      initialImages: [],
      initialMessages: [],
      migratedProviders: [],
      modelFallbackMessage: undefined,
    });
    await mode.run();
  } finally {
    await runtime.dispose();
  }
}

async function loadPiSdk(): Promise<SparkCliSdk> {
  const moduleValue: unknown = await import("@earendil-works/pi-coding-agent");
  if (!isRecord(moduleValue)) {
    throw new Error("@earendil-works/pi-coding-agent must load as an object module");
  }
  const sessionManager = moduleValue.SessionManager;
  if (
    (typeof sessionManager !== "object" && typeof sessionManager !== "function") ||
    sessionManager === null ||
    !("create" in sessionManager) ||
    typeof sessionManager.create !== "function"
  ) {
    throw new Error("@earendil-works/pi-coding-agent export SessionManager.create is required");
  }
  return {
    createAgentSessionServices: requiredFunction(moduleValue, "createAgentSessionServices"),
    createAgentSessionFromServices: requiredFunction(moduleValue, "createAgentSessionFromServices"),
    createAgentSessionRuntime: requiredFunction(moduleValue, "createAgentSessionRuntime"),
    getAgentDir: requiredFunction(moduleValue, "getAgentDir"),
    InteractiveMode: requiredFunction(moduleValue, "InteractiveMode"),
    SessionManager: {
      create: sessionManager.create as SparkCliSdk["SessionManager"]["create"],
    },
  };
}

export async function loadBuiltinExtensionFactories(): Promise<SparkCliExtensionFactory[]> {
  const hostExtension = (await import("./spark-host-extension.ts")).default;
  const specs: BuiltinExtensionSpec[] = [
    {
      packageSubpath: "spark/extension",
      fallbackPath: "../../spark/src/extension/index.ts",
    },
    {
      packageSubpath: "pi-roles/extension",
      fallbackPath: "../../pi-roles/src/extension.ts",
    },
    {
      packageSubpath: "pi-graft/extension",
      fallbackPath: "../../pi-graft/src/extension.ts",
    },
  ];
  return [
    registerBaiduOneApiProvider,
    hostExtension,
    ...(await Promise.all(specs.map(loadExtensionFactory))),
  ];
}

async function loadExtensionFactory(spec: BuiltinExtensionSpec): Promise<SparkCliExtensionFactory> {
  try {
    const module = (await import(spec.packageSubpath)) as ExtensionFactoryModule;
    return module.default;
  } catch (error) {
    if (!shouldFallbackToSourceExtension(error)) throw error;
    const module = (await import(spec.fallbackPath)) as ExtensionFactoryModule;
    return module.default;
  }
}

function shouldFallbackToSourceExtension(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING";
}

function printHelp(): void {
  console.log(
    `spark - Spark-first TUI host\n\nUsage:\n  spark [initial message]\n  spark --help\n\nThe MVP only supports interactive TUI mode. Positional arguments are joined and sent as the initial TUI message.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSparkCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
