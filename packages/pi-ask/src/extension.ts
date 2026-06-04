import type { ExtensionAPI, ToolConfig } from "pi-extension-api";

import { registerPiAskFlowTool } from "./flow.ts";
import { registerPiAskTools } from "./index.ts";

export default function piAskExtension(pi: ExtensionAPI): void {
  if (!pi.registerTool) throw new Error("pi-ask extension requires registerTool support");

  const api = {
    registerTool: (config: unknown): void => pi.registerTool?.(config as ToolConfig),
  };

  registerPiAskTools(api);
  registerPiAskFlowTool(api);
}
