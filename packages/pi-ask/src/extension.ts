import type { ExtensionAPI, ToolConfig } from "@zendev-lab/pi-extension-api";

import { registerPiAskActionTool } from "./action-tool.ts";
import { registerPiAskFlowTool } from "./flow.ts";
import { registerPiAskTools } from "./index.ts";

export default function piAskExtension(pi: ExtensionAPI): void {
  if (!pi.registerTool) throw new Error("pi-ask extension requires registerTool support");

  const askImplementationTools = new Map<string, ToolConfig>();
  const internalApi = {
    registerTool: (config: unknown): void => {
      const toolConfig = config as ToolConfig;
      askImplementationTools.set(toolConfig.name, toolConfig);
    },
  };
  const publicApi = {
    registerTool: (config: unknown): void => {
      pi.registerTool?.(config as ToolConfig);
    },
  };

  registerPiAskTools(internalApi);
  registerPiAskFlowTool(internalApi);
  registerPiAskActionTool(publicApi, {
    resolveTool: (name) => askImplementationTools.get(name),
  });
}
