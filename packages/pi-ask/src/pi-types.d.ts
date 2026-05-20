declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(config: ToolConfig): void;
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
    ui?: {
      notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
      confirm?: (title: string, message: string) => Promise<boolean>;
      input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
      select?: (title: string, options: string[]) => Promise<string | undefined>;
    };
  }
}
