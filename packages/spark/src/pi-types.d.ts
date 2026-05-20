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
    renderCall?: (
      args: Record<string, unknown>,
      theme: ToolRenderTheme,
      context: unknown,
    ) => ToolRenderComponent;
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

  export interface ToolRenderTheme {
    fg?: (color: string, text: string) => string;
    bold?: (text: string) => string;
  }

  export interface ToolRenderComponent {
    render(width: number): string[];
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI?: boolean;
    ui?: {
      notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
      confirm?: (title: string, message: string) => Promise<boolean>;
      input?: (title: string, defaultValue?: string) => Promise<string>;
      select?: (title: string, options: string[]) => Promise<string>;
      setWidget?: (
        key: string,
        callback: unknown,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ) => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle?: () => Promise<void>;
    sendUserMessage?: (content: string) => Promise<void>;
  }
}
