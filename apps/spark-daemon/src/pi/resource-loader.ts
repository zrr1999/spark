import {
  createExtensionRuntime,
  type ResourceLoader,
  type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";

export function createNaviaResourceLoader(systemPrompt?: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
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

export function emptyDiagnostics(): ResourceDiagnostic[] {
  return [];
}
