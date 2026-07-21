import type { SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";

import { registerSparkAskActionTool } from "./action-tool.ts";
import { registerSparkAskFlowTool } from "./flow.ts";
import { registerSparkAskTools } from "./index.ts";

export default function piAskExtension(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-ask extension requires registerTool support");

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

  registerSparkAskTools(internalApi);
  registerSparkAskFlowTool(internalApi);
  registerSparkAskActionTool(publicApi, {
    resolveTool: (name) => askImplementationTools.get(name),
  });
}
