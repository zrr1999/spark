import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { NaviaPaths } from "@navia-dev/system";
import { createNaviaResourceLoader } from "./resource-loader.js";

export interface RunPiPromptOptions {
  cwd: string;
  prompt: string;
  paths: NaviaPaths;
  tools: string[];
  invocationId: string;
  persistSession?: boolean;
  onEvent?: (event: AgentSessionEvent) => void;
}

export async function runPiPrompt(options: RunPiPromptOptions): Promise<void> {
  const agentDir = options.paths.piAgentDir ?? join(options.paths.dataDir, "pi-agent");
  const authStorage = AuthStorage.create(join(options.paths.dataDir, "pi-auth.json"));
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(options.paths.dataDir, "pi-models.json"),
  );
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = createNaviaResourceLoader();
  const sessionManager = options.persistSession
    ? SessionManager.create(
        options.cwd,
        join(options.paths.dataDir, "sessions", safeSegment(options.invocationId)),
      )
    : SessionManager.inMemory(options.cwd);

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager,
    tools: options.tools,
  });

  const unsubscribe = options.onEvent ? session.subscribe(options.onEvent) : undefined;
  try {
    await session.prompt(options.prompt, { streamingBehavior: "followUp", source: "rpc" });
  } finally {
    unsubscribe?.();
    session.dispose();
  }
}

export function extractTextDelta(event: AgentSessionEvent): string | null {
  if (!("assistantMessageEvent" in event) || event.type !== "message_update") {
    return null;
  }
  const update = event.assistantMessageEvent;
  if (
    update &&
    typeof update === "object" &&
    "type" in update &&
    update.type === "text_delta" &&
    "delta" in update &&
    typeof update.delta === "string"
  ) {
    return update.delta;
  }
  return null;
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
