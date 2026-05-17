declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerCommand(name: string, config: CommandConfig): void;
    registerTool?(config: ToolConfig): void;
    on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    sendUserMessage?(
      content: string,
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): void;
  }

  export interface CommandConfig {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
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
    cwd: string;
    hasUI?: boolean;
    ui?: {
      notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
      confirm?: (title: string, message: string) => Promise<boolean>;
      input?: (title: string, defaultValue?: string) => Promise<string>;
      select?: (title: string, options: string[]) => Promise<string>;
    };
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle?: () => Promise<void>;
    sendUserMessage?: (content: string) => Promise<void>;
  }
}
