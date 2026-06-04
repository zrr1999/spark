interface SparkCliHostApi {
  on?(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; streamingBehavior?: "steer" | "followUp" },
  ): void;
  isIdle?(): boolean;
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

    const text = input.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) {
      return { action: "continue" };
    }

    // Always provide queueing semantics. Some runtimes expose the lower-level
    // `streamingBehavior` option directly, while Pi extension `sendUserMessage`
    // maps `deliverAs` to that option internally. Supplying both avoids the
    // "Agent is already processing" path even when idle state is stale or absent.
    const delivery = { deliverAs: "followUp" as const, streamingBehavior: "followUp" as const };
    pi.sendUserMessage?.(`/spark ${text}`, delivery);
    return { action: "handled" };
  });
}
