export interface SparkDaemonResourceDiagnostic {
  message?: string;
  severity?: string;
  [key: string]: unknown;
}

export interface SparkDaemonResourceLoader {
  getExtensions(): { extensions: unknown[]; errors: unknown[]; runtime: Record<string, never> };
  getSkills(): { skills: unknown[]; diagnostics: SparkDaemonResourceDiagnostic[] };
  getPrompts(): { prompts: unknown[]; diagnostics: SparkDaemonResourceDiagnostic[] };
  getThemes(): { themes: unknown[]; diagnostics: SparkDaemonResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: unknown[] };
  getSystemPrompt(): string;
  getAppendSystemPrompt(): string[];
  extendResources(): void;
  reload(): Promise<void>;
}

export function createSparkDaemonResourceLoader(systemPrompt?: string): SparkDaemonResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      systemPrompt ??
      "You are running inside Spark Daemon. Follow the workspace instructions, report progress clearly, and use only the tools exposed for this invocation.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function emptyDiagnostics(): SparkDaemonResourceDiagnostic[] {
  return [];
}
