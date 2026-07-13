/**
 * Host-neutral Spark agent identity and conversation-surface prompts.
 *
 * These strings are shared by TUI, daemon headless, and channel sessions.
 * `spark-tui` is only one optional UI host — never describe it as "the environment".
 */

/** Default identity for Spark coding agents across all execution surfaces. */
export const DEFAULT_SPARK_IDENTITY_PROMPT =
  "You are Spark, a coding assistant. Use Spark as the project/task coordination layer, not as your assistant identity. Local UIs such as spark-tui are optional hosts; daemon/headless and IM channels are equally valid surfaces.";

export type SparkChannelSurface = {
  adapter: "feishu" | "infoflow" | (string & {});
  scope: "user" | "group";
  /** Stable external key, e.g. infoflow:user:alice or infoflow:group:123. */
  externalKey?: string;
};

/** Human label for channel adapters in prompts. */
export function sparkChannelAdapterLabel(adapter: string): string {
  switch (adapter) {
    case "infoflow":
      return "Infoflow (如流)";
    case "feishu":
      return "Feishu";
    case "qqbot":
      return "QQ Bot";
    default:
      return adapter;
  }
}

/**
 * Surface context for IM channel sessions so the model knows where the user is
 * chatting and that replies are delivered back to that conversation.
 */
export function renderSparkChannelSurfacePrompt(surface: SparkChannelSurface): string {
  const label = sparkChannelAdapterLabel(surface.adapter);
  const scope = surface.scope === "group" ? "group chat" : "private chat";
  const key = surface.externalKey?.trim();
  return [
    `Current conversation surface: ${label} ${scope}.`,
    "Replies are delivered back to that conversation.",
    "You are not running inside spark-tui; spark-tui is only one optional local UI host.",
    key ? `Channel binding: ${key}.` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

/**
 * Per-turn runtime context. Kept as its own prompt section so prompt-cache
 * logic can treat date/cwd as dynamic while identity/skills stay stable.
 */
export function renderAgentRuntimeContextPrompt(input: { cwd: string; now?: Date }): string {
  const cwd = input.cwd.trim();
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  return [
    `Current date: ${date}`,
    `Current working directory: ${cwd}`,
    "Default relative file/tool paths and bare directory listings to this working directory. Do not use the filesystem root (/) unless the user explicitly asks for it.",
  ].join("\n");
}
