import { randomUUID } from "node:crypto";

import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
} from "@agentclientprotocol/sdk";

/**
 * In-memory ACP session mapped to a future Spark session id.
 * Production wiring would call daemon local-rpc (`turn.submit` / session APIs)
 * instead of this stub store.
 */
export interface SparkAcpSessionRecord {
  acpSessionId: string;
  /** Placeholder for a real Spark session id once daemon ACP is enabled. */
  sparkSessionId: string;
  cwd: string;
  createdAt: string;
}

export interface SparkAcpAgentOptions {
  /** Agent name advertised to ACP clients (editors). */
  name?: string;
  /** Default cwd stamped onto new sessions (cwd comes from session/new when present). */
  defaultCwd?: string;
}

export interface SparkAcpAgentHandle {
  app: AgentApp;
  sessions: Map<string, SparkAcpSessionRecord>;
}

function promptText(params: { prompt?: ReadonlyArray<{ type?: string; text?: string }> }): string {
  const chunks = params.prompt ?? [];
  return chunks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Build a minimal ACP AgentApp that editors can drive in-process or over stdio.
 *
 * This is a spike only: prompts are acknowledged with a stub message and are
 * **not** forwarded to spark-daemon. See `docs/operations/acp-spike.md`.
 */
export function createSparkAcpAgent(options: SparkAcpAgentOptions = {}): SparkAcpAgentHandle {
  const sessions = new Map<string, SparkAcpSessionRecord>();
  const name = options.name ?? "spark-acp-spike";
  const defaultCwd = options.defaultCwd ?? process.cwd();

  const app = agent({ name })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name,
        version: "0.1.0",
      },
    }))
    .onRequest(methods.agent.authenticate, async () => ({}))
    .onRequest(methods.agent.session.new, async (ctx) => {
      const acpSessionId = randomUUID().replaceAll("-", "");
      const cwd =
        typeof ctx.params.cwd === "string" && ctx.params.cwd.length > 0
          ? ctx.params.cwd
          : defaultCwd;
      const record: SparkAcpSessionRecord = {
        acpSessionId,
        // Future: allocate / bind a real Spark session via daemon RPC.
        sparkSessionId: `spark-session-pending:${acpSessionId}`,
        cwd,
        createdAt: new Date().toISOString(),
      };
      sessions.set(acpSessionId, record);
      return { sessionId: acpSessionId };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) {
        throw new Error(`unknown ACP session: ${ctx.params.sessionId}`);
      }
      const text = promptText(ctx.params);
      await emitStubTurn(ctx.client, session, text);
      return { stopReason: "end_turn" as const };
    })
    .onNotification(methods.agent.session.cancel, async () => {
      // Spike: nothing to cancel yet (no daemon invocation).
    });

  return { app, sessions };
}

async function emitStubTurn(
  client: AgentContext,
  session: SparkAcpSessionRecord,
  prompt: string,
): Promise<void> {
  const preview = prompt.trim().slice(0, 200);
  await client.notify(methods.client.session.update, {
    sessionId: session.acpSessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          `[spark-acp-spike] stub reply for Spark session ` +
          `${session.sparkSessionId} (cwd=${session.cwd}). ` +
          `Received prompt (${preview.length} chars)` +
          (preview ? `: ${preview}` : ".") +
          ` Daemon turn.submit is not wired in this spike.`,
      },
    },
  });
}
