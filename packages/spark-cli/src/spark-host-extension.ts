interface SparkCliHostApi {
  on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

interface SparkCliHostContext {
  ui?: {
    setTitle?: (title: string) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

interface SparkCliInputEvent {
  text?: unknown;
  source?: unknown;
}

export default function sparkCliHostExtension(pi: SparkCliHostApi): void {
  pi.on?.("session_start", (_event, ctx) => {
    const hostContext = ctx as SparkCliHostContext;
    hostContext.ui?.setTitle?.("spark");
    hostContext.ui?.setStatus?.("spark", "Spark");
  });

  pi.on?.("input", (event) => {
    const input = event as SparkCliInputEvent;
    if (input.source === "extension") return { action: "continue" };
    if (typeof input.text !== "string") return { action: "continue" };
    return { action: "continue" };
  });
}
