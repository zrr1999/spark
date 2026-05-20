export type AgentRunMode = "fresh" | "forked";
export type AgentSpecRef = `agent:${string}`;
export type AgentRunRef = `run:${string}`;

export interface PiAgentRunRequest {
  specRef: AgentSpecRef;
  instruction: string;
  mode?: AgentRunMode;
  systemPrompt?: string;
  sessionDir?: string;
  forkFromSession?: string;
}

export interface PiAgentCommandInput extends PiAgentRunRequest {
  systemPrompt: string;
}

export interface PiAgentRunRecord {
  ref: AgentRunRef;
  specRef: AgentSpecRef;
  mode: AgentRunMode;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "not_started";
  instruction: string;
  startedAt: string;
  finishedAt?: string;
  sessionDir?: string;
  forkFromSession?: string;
  failureKind?: string;
  errorMessage?: string;
}

export function normalizeAgentRunMode(value: unknown): AgentRunMode {
  return value === "forked" ? "forked" : "fresh";
}

export function buildPiAgentPrompt(
  input: Pick<PiAgentCommandInput, "systemPrompt" | "instruction">,
): string {
  return [
    input.systemPrompt,
    "",
    "Spark subagent ask policy:",
    "- You have access to Spark ask tools in this run. If the task is blocked by missing user intent, an approval gate, or a real ambiguity that cannot be resolved from repository context, use the available Spark ask tools rather than only writing questions in your final response.",
    "- Do not ask for routine implementation choices you can safely infer from the assigned task and repository context; proceed and document the decision.",
    "- If an ask times out or returns no selection for a decision/approval gate, stop and report the blocked state rather than continuing.",
    "",
    "Spark naming quality policy:",
    "- Judge whether the active thread title and your task @name/title are placeholder, generic, stale, too broad, or inconsistent with the current instruction.",
    "- When the improvement is obvious, update Spark display names without asking: use spark_rename_thread for the thread, and spark_claim_task with the existing task ref/name intent to improve your claimed task @name/title/description. Stable refs must remain unchanged.",
    "- Preserve user-specific intentional names and distinctive project/code names; ask only if multiple plausible names require a real user decision.",
    "",
    "Instruction:",
    input.instruction,
  ].join("\n");
}

export function buildPiAgentArgs(input: PiAgentCommandInput): string[] {
  if (!input.specRef) throw new Error("agent run specRef is required");
  if (!input.instruction.trim()) throw new Error("agent run instruction is required");
  const mode = normalizeAgentRunMode(input.mode);
  const args = ["--print", "--mode", "json"];
  if (input.sessionDir) args.push("--session-dir", input.sessionDir);
  if (mode === "forked") {
    if (!input.forkFromSession?.trim())
      throw new Error("forked agent run requires forkFromSession");
    args.push("--fork", input.forkFromSession.trim());
  }
  args.push("--append-system-prompt", input.systemPrompt, buildPiAgentPrompt(input));
  return args;
}

export function parsePiJsonlEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Pi may emit non-JSON diagnostics. Keep parser tolerant.
    }
  }
  return events;
}
