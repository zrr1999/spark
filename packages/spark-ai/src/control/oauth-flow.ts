import { randomUUID } from "node:crypto";

import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";

import { SparkAuthStore } from "./auth.ts";

export type SparkOAuthFlowPhase =
  | "running"
  | "waiting_for_input"
  | "complete"
  | "failed"
  | "cancelled";

export interface SparkOAuthFlowPrompt {
  id: string;
  kind: "text" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface SparkOAuthFlowSnapshot {
  id: string;
  providerId: string;
  phase: SparkOAuthFlowPhase;
  createdAt: string;
  updatedAt: string;
  auth?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  prompt?: SparkOAuthFlowPrompt;
  progress: string[];
  error?: string;
}

export interface SparkOAuthFlowBrokerOptions {
  store: SparkAuthStore;
  now?: () => Date;
  completedFlowTtlMs?: number;
}

interface PendingInput {
  promptId: string;
  resolve(value: string | undefined): void;
}

interface SparkOAuthFlowRecord extends SparkOAuthFlowSnapshot {
  abortController: AbortController;
  pending?: PendingInput;
}

const DEFAULT_COMPLETED_FLOW_TTL_MS = 30 * 60 * 1000;
const MAX_PROGRESS_ENTRIES = 50;

export class SparkOAuthFlowBroker {
  readonly #store: SparkAuthStore;
  readonly #now: () => Date;
  readonly #completedFlowTtlMs: number;
  readonly #flows = new Map<string, SparkOAuthFlowRecord>();

  constructor(options: SparkOAuthFlowBrokerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#completedFlowTtlMs = options.completedFlowTtlMs ?? DEFAULT_COMPLETED_FLOW_TTL_MS;
  }

  async start(providerId: string): Promise<SparkOAuthFlowSnapshot> {
    this.#cleanup();
    const now = this.#now().toISOString();
    const record: SparkOAuthFlowRecord = {
      id: randomUUID(),
      providerId,
      phase: "running",
      createdAt: now,
      updatedAt: now,
      progress: [],
      abortController: new AbortController(),
    };
    this.#flows.set(record.id, record);
    void this.#run(record);
    // Let providers that synchronously emit an auth URL/device code publish it
    // before the start response is serialized.
    await Promise.resolve();
    return snapshotFlow(record);
  }

  status(flowId: string): SparkOAuthFlowSnapshot | undefined {
    this.#cleanup();
    const flow = this.#flows.get(flowId);
    return flow ? snapshotFlow(flow) : undefined;
  }

  respond(flowId: string, promptId: string, value: string): SparkOAuthFlowSnapshot {
    const flow = this.#requireFlow(flowId);
    const prompt = flow.prompt;
    const pending = flow.pending;
    if (!prompt || !pending || prompt.id !== promptId || pending.promptId !== promptId) {
      throw new Error(`OAuth flow ${flowId} is not waiting for prompt ${promptId}`);
    }
    if (prompt.kind === "select" && !prompt.options?.some((option) => option.id === value)) {
      throw new Error(`OAuth flow ${flowId} received an invalid selection`);
    }
    if (prompt.allowEmpty !== true && prompt.kind !== "select" && !value.trim()) {
      throw new Error("OAuth prompt response must be non-empty");
    }
    delete flow.prompt;
    delete flow.pending;
    flow.phase = "running";
    this.#touch(flow);
    pending.resolve(value);
    return snapshotFlow(flow);
  }

  cancel(flowId: string): SparkOAuthFlowSnapshot {
    const flow = this.#requireFlow(flowId);
    if (isTerminal(flow.phase)) return snapshotFlow(flow);
    flow.phase = "cancelled";
    flow.abortController.abort();
    flow.pending?.resolve(undefined);
    delete flow.pending;
    delete flow.prompt;
    this.#touch(flow);
    return snapshotFlow(flow);
  }

  async #run(flow: SparkOAuthFlowRecord): Promise<void> {
    try {
      await this.#store.loginOAuth(flow.providerId, this.#callbacks(flow));
      if (flow.phase === "cancelled") return;
      flow.phase = "complete";
      delete flow.prompt;
      delete flow.pending;
      this.#touch(flow);
    } catch (error) {
      if (flow.phase === "cancelled" || flow.abortController.signal.aborted) {
        flow.phase = "cancelled";
      } else {
        flow.phase = "failed";
        flow.error = sanitizeError(error);
      }
      delete flow.prompt;
      delete flow.pending;
      this.#touch(flow);
    }
  }

  #callbacks(flow: SparkOAuthFlowRecord): OAuthLoginCallbacks {
    return {
      onAuth: (info) => this.#onAuth(flow, info),
      onDeviceCode: (info) => this.#onDeviceCode(flow, info),
      onPrompt: async (prompt) => {
        const response = await this.#waitForInput(flow, textPrompt(prompt));
        if (response === undefined) throw abortError();
        return response;
      },
      onManualCodeInput: async () => {
        const response = await this.#waitForInput(flow, {
          id: randomUUID(),
          kind: "manual_code",
          message: "Paste the authorization code",
          allowEmpty: false,
        });
        if (response === undefined) throw abortError();
        return response;
      },
      onSelect: (prompt) => this.#waitForInput(flow, selectPrompt(prompt)),
      onProgress: (message) => {
        flow.progress = [...flow.progress, redact(message)].slice(-MAX_PROGRESS_ENTRIES);
        this.#touch(flow);
      },
      signal: flow.abortController.signal,
    };
  }

  #onAuth(flow: SparkOAuthFlowRecord, info: OAuthAuthInfo): void {
    flow.auth = {
      url: info.url,
      ...(info.instructions ? { instructions: info.instructions } : {}),
    };
    this.#touch(flow);
  }

  #onDeviceCode(flow: SparkOAuthFlowRecord, info: OAuthDeviceCodeInfo): void {
    flow.deviceCode = {
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      ...(info.intervalSeconds !== undefined ? { intervalSeconds: info.intervalSeconds } : {}),
      ...(info.expiresInSeconds !== undefined ? { expiresInSeconds: info.expiresInSeconds } : {}),
    };
    this.#touch(flow);
  }

  #waitForInput(
    flow: SparkOAuthFlowRecord,
    prompt: SparkOAuthFlowPrompt,
  ): Promise<string | undefined> {
    if (flow.abortController.signal.aborted) return Promise.resolve(undefined);
    if (flow.pending) throw new Error("OAuth provider requested overlapping prompts");
    flow.phase = "waiting_for_input";
    flow.prompt = prompt;
    this.#touch(flow);
    return new Promise((resolve) => {
      flow.pending = { promptId: prompt.id, resolve };
    });
  }

  #requireFlow(flowId: string): SparkOAuthFlowRecord {
    this.#cleanup();
    const flow = this.#flows.get(flowId);
    if (!flow) throw new Error(`Unknown OAuth flow: ${flowId}`);
    return flow;
  }

  #touch(flow: SparkOAuthFlowRecord): void {
    flow.updatedAt = this.#now().toISOString();
  }

  #cleanup(): void {
    const cutoff = this.#now().getTime() - this.#completedFlowTtlMs;
    for (const [id, flow] of this.#flows) {
      if (isTerminal(flow.phase) && Date.parse(flow.updatedAt) < cutoff) this.#flows.delete(id);
    }
  }
}

function textPrompt(prompt: OAuthPrompt): SparkOAuthFlowPrompt {
  return {
    id: randomUUID(),
    kind: "text",
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.allowEmpty !== undefined ? { allowEmpty: prompt.allowEmpty } : {}),
  };
}

function selectPrompt(prompt: OAuthSelectPrompt): SparkOAuthFlowPrompt {
  return {
    id: randomUUID(),
    kind: "select",
    message: prompt.message,
    options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
  };
}

function snapshotFlow(flow: SparkOAuthFlowRecord): SparkOAuthFlowSnapshot {
  return {
    id: flow.id,
    providerId: flow.providerId,
    phase: flow.phase,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.auth ? { auth: { ...flow.auth } } : {}),
    ...(flow.deviceCode ? { deviceCode: { ...flow.deviceCode } } : {}),
    ...(flow.prompt
      ? {
          prompt: {
            ...flow.prompt,
            ...(flow.prompt.options
              ? { options: flow.prompt.options.map((option) => ({ ...option })) }
              : {}),
          },
        }
      : {}),
    progress: [...flow.progress],
    ...(flow.error ? { error: flow.error } : {}),
  };
}

function isTerminal(phase: SparkOAuthFlowPhase): boolean {
  return phase === "complete" || phase === "failed" || phase === "cancelled";
}

function abortError(): Error {
  const error = new Error("OAuth login cancelled");
  error.name = "AbortError";
  return error;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message || "OAuth login failed");
}

function redact(message: string): string {
  return message
    .replace(/(authorization|token|secret|api[_ -]?key)(\s*[:=]\s*)\S+/giu, "$1$2[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}
