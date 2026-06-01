declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(config: ToolConfig): void;
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    getAllTools(): ToolInfo[];
    setActiveTools(names: string[]): void;
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
      notify?: (msg: string, level: "info" | "warning" | "error" | "success") => void;
    };
  }

  export interface ToolInfo {
    name: string;
  }
}
