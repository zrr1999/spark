declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(config: ToolConfig): void;
  }

  export interface ToolConfig {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: ExtensionContext,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }

  export interface ExtensionContext {
    ui?: {
      notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
      confirm?: (title: string, message: string) => Promise<boolean>;
      input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
      select?: (title: string, options: string[]) => Promise<string | undefined>;
    };
  }
}
