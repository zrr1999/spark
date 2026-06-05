import type { ExtensionAPI, ToolConfig } from "pi-extension-api";

import { registerPiAskActionTool } from "./action-tool.ts";
import { registerPiAskFlowTool } from "./flow.ts";
import { registerPiAskTools } from "./index.ts";

export default function piAskExtension(pi: ExtensionAPI): void {
  if (!pi.registerTool) throw new Error("pi-ask extension requires registerTool support");

  const registeredTools = new Map<string, ToolConfig>();
  const api = {
    registerTool: (config: unknown): void => {
      const toolConfig = config as ToolConfig;
      registeredTools.set(toolConfig.name, toolConfig);
      pi.registerTool?.(toolConfig);
    },
  };

  registerPiAskTools(api);
  registerPiAskFlowTool(api);
  registerPiAskActionTool(api, {
    resolveTool: (name) => registeredTools.get(name),
  });
}
