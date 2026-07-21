/** Persisted Spark agent session facade shared by TUI/daemon-style callers. */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { classifyProviderFailure } from "@zendev-lab/spark-ai";
import { sparkTextPhaseFromSignature } from "@zendev-lab/spark-protocol";
import {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  lowerSparkPromptItems,
  parseSparkPromptItemMetadata,
  sparkPromptItemFromProviderMessage,
  sparkPromptItemMetadata,
  sparkRuntimePromptItem,
  type SparkPromptItem,
  type SparkRunOutcome,
} from "@zendev-lab/spark-turn";

import type { SparkCliHostServices } from "./bootstrap.ts";
import {
  CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
  DEFAULT_SPARK_COMPACTION_SETTINGS,
  compactSparkSessionRecord,
  deterministicSparkCompactionSummary,
  meterSparkContextTokens,
  prepareSparkCompaction,
  scheduleSparkCompaction,
  shouldSparkCompact,
  type SparkCompactionScheduleResult,
  type SparkCompactionSettings,
  type SparkCompactionPreparation,
} from "./compaction.ts";
import { getSparkSessionBranch } from "./session-navigation.ts";
import type {
  SparkBranchSummaryEntry,
  SparkCompactionEntry,
  SparkCustomMessageEntry,
  SparkSessionEntry,
  SparkSessionMessage,
  SparkSessionMessageEntry,
  SparkSessionRecord,
} from "./session-store.ts";

export interface SparkAgentSessionRunOptions {
  sessionId: string;
  prompt: UserMessage["content"];
  reset?: boolean;
  forkFromSession?: string;
  /** Display-safe metadata persisted on this turn's submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /**
   * When true, the turn continues after a daemon/process interrupt. The model is
   * told to resume from persisted session state without redoing completed work.
   */
  resumeFromInterrupt?: boolean;
}

const MAX_CONTEXT_OVERFLOW_COMPACTIONS = 5;
const CONTEXT_OVERFLOW_COMPACT_BACKOFF_MS = [0, 500, 1_500, 4_000, 10_000] as const;
/** Provider concurrency/rate-limit retries after the stream already failed closed. */
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
const DAEMON_RESUME_NOTICE =
  "[Spark daemon resume] The previous attempt of this turn was interrupted mid-execution. Continue from the current session history. Do not repeat side effects that already completed.";

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function promptWithResumeNotice(
  prompt: UserMessage["content"],
  resumeFromInterrupt: boolean | undefined,
): UserMessage["content"] {
  if (!resumeFromInterrupt) return prompt;
  if (typeof prompt === "string") return `${DAEMON_RESUME_NOTICE}\n\n${prompt}`;
  return [{ type: "text", text: DAEMON_RESUME_NOTICE }, ...prompt];
}

export interface SparkAgentSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  assistant?: AssistantMessage;
  outcome?: SparkRunOutcome;
  sessionPersistence?: "persistent" | "anonymous";
}

export class SparkAgentSession {
  private readonly services: SparkCliHostServices;

  constructor(services: SparkCliHostServices) {
    this.services = services;
  }

  async run(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    const record = await this.loadOrCreateRecord(options);
    this.services.runtime.setSessionId(record.header.id);
    this.services.agentLoop.setViewSessionId(record.header.id);
    const prompt = promptWithResumeNotice(options.prompt, options.resumeFromInterrupt);
    await this.tryPreflightCompaction(record, prompt);
    let beforeCount = this.loadPromptItems(record);
    let outcome = await this.services.agentLoop.submitWithOutcome(prompt);

    let compactAttempt = 0;
    while (
      outcome.status === "failed" &&
      classifyProviderFailure(outcome.errorMessage).failureClass === "context_overflow" &&
      compactAttempt < MAX_CONTEXT_OVERFLOW_COMPACTIONS
    ) {
      await delay(CONTEXT_OVERFLOW_COMPACT_BACKOFF_MS[compactAttempt] ?? 10_000);
      if (!(await this.tryCompact(record, "context_overflow", true, true))) break;
      compactAttempt += 1;
      // The failed attempt only exists in the loop's transient prompt state.
      // Reload from the persisted compacted record so the user prompt and
      // provider error are neither duplicated nor written into session history.
      beforeCount = this.loadPromptItems(record);
      outcome = await this.services.agentLoop.submitWithOutcome(prompt);
    }
    let rateLimitAttempt = 0;
    while (
      outcome.status === "failed" &&
      classifyProviderFailure(outcome.errorMessage).failureClass === "rate_limit" &&
      rateLimitAttempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await delay(RATE_LIMIT_BACKOFF_MS[rateLimitAttempt] ?? 20_000);
      rateLimitAttempt += 1;
      // Same as overflow recovery: drop the failed transient turn and resubmit
      // from the last persisted session snapshot.
      beforeCount = this.loadPromptItems(record);
      outcome = await this.services.agentLoop.submitWithOutcome(prompt);
    }
    const assistant = outcome.assistant;

    const newItems = this.services.agentLoop.getPromptItems().slice(beforeCount);
    let pendingMessageMetadata = options.messageMetadata;
    let persistedCount = 0;
    for (const item of newItems) {
      if (item.persistence !== "session") continue;
      if (item.content.kind === "runtime") {
        const details = {
          ...(item.details ?? {}),
          [SPARK_PROMPT_ITEM_METADATA_KEY]: sparkPromptItemMetadata(item),
        };
        this.services.sessionStore.appendCustomMessage(
          record,
          item.customType ?? "spark-runtime-message",
          item.content.value,
          item.visibility === "visible",
          details,
        );
        persistedCount += 1;
        continue;
      }
      const message = item.content.message as Message;
      const persisted = agentMessageToSessionMessage(message);
      if (item.authority === "user" && pendingMessageMetadata) {
        persisted.metadata = {
          ...recordMetadata(persisted.metadata),
          ...pendingMessageMetadata,
        };
        pendingMessageMetadata = undefined;
      }
      this.services.sessionStore.appendMessage(record, persisted);
      persistedCount += 1;
    }
    await this.services.sessionStore.save(record);

    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      newMessageCount: persistedCount,
      assistantText: assistantMessageToFinalAnswerText(assistant),
      assistant,
      outcome,
      sessionPersistence: "persistent",
    };
  }

  async runAnonymous(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    this.services.runtime.setSessionId(options.sessionId);
    this.services.agentLoop.setViewSessionId(options.sessionId);
    this.services.agentLoop.replacePromptItems([]);
    let beforeCount = this.services.agentLoop.getPromptItems().length;
    let outcome = await this.services.agentLoop.submitWithOutcome(options.prompt);
    let rateLimitAttempt = 0;
    while (
      outcome.status === "failed" &&
      classifyProviderFailure(outcome.errorMessage).failureClass === "rate_limit" &&
      rateLimitAttempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await delay(RATE_LIMIT_BACKOFF_MS[rateLimitAttempt] ?? 20_000);
      rateLimitAttempt += 1;
      this.services.agentLoop.replacePromptItems([]);
      beforeCount = this.services.agentLoop.getPromptItems().length;
      outcome = await this.services.agentLoop.submitWithOutcome(options.prompt);
    }
    const assistant = outcome.assistant;

    return {
      sessionId: options.sessionId,
      sessionPath: "",
      newMessageCount: this.services.agentLoop
        .getPromptItems()
        .slice(beforeCount)
        .filter((item) => item.persistence === "session").length,
      assistantText: assistantMessageToFinalAnswerText(assistant),
      assistant,
      outcome,
      sessionPersistence: "anonymous",
    };
  }

  private async loadOrCreateRecord(
    options: SparkAgentSessionRunOptions,
  ): Promise<SparkSessionRecord> {
    if (options.forkFromSession) {
      const parent = await this.services.sessionStore.loadByRef(options.forkFromSession);
      return this.services.sessionStore.forkSession(parent, { id: options.sessionId });
    }
    if (options.reset) return this.services.sessionStore.createSession({ id: options.sessionId });
    const existing = await this.services.sessionStore.findById(options.sessionId);
    return existing ?? this.services.sessionStore.createSession({ id: options.sessionId });
  }

  private loadPromptItems(record: SparkSessionRecord): number {
    this.services.agentLoop.replacePromptItems(sessionRecordToPromptItems(record));
    return this.services.agentLoop.getPromptItems().length;
  }

  private async tryPreflightCompaction(
    record: SparkSessionRecord,
    prompt: UserMessage["content"],
  ): Promise<void> {
    let model: ReturnType<SparkCliHostServices["providerRegistry"]["buildActiveModel"]>;
    try {
      model = this.services.providerRegistry.buildActiveModel();
    } catch {
      return;
    }
    if (!model) return;
    const contextWindow = positiveNumber(model.contextWindow);
    if (!contextWindow) return;
    const settings = this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS;
    if (!settings.enabled) return;
    const requestedOutput = positiveNumber(model.maxTokens) ?? 0;
    const replayMessages = activeSessionReplayMessages(record);
    const contextMeter = meterSparkContextTokens({
      messages: replayMessages,
      reportedTokens: latestReportedContextTokens(record),
    });
    const promptMeter = meterSparkContextTokens({ messages: [{ role: "user", content: prompt }] });
    const schedule = scheduleSparkCompaction(replayMessages, contextWindow, settings);
    const micro = schedule.find((pass) => pass.type === "micro");
    let replayTokensAfter = contextMeter.tokens;
    if (micro && (await this.tryPersistMicroCompaction(record, replayMessages, micro))) {
      replayTokensAfter = micro.tokensAfter;
    }

    const estimatedRequestTokens = replayTokensAfter + promptMeter.tokens + requestedOutput;
    const requiresFull =
      schedule.some((pass) => pass.type === "full") ||
      shouldSparkCompact(estimatedRequestTokens, contextWindow, settings);
    if (!requiresFull) return;
    await this.tryCompact(record, "auto", false, true, settings);
  }

  private async tryPersistMicroCompaction(
    record: SparkSessionRecord,
    before: readonly SparkSessionMessage[],
    pass: SparkCompactionScheduleResult,
  ): Promise<boolean> {
    const changes = changedMicroToolResults(before, pass.messages);
    if (changes.length !== pass.compactedMessages) return false;

    const applied: Array<{ entry: SparkSessionMessageEntry; content: unknown }> = [];
    const branch = getSparkSessionBranch(record);
    const available = branch.filter(
      (entry): entry is SparkSessionMessageEntry =>
        entry.type === "message" && entry.message.role === "toolResult",
    );
    const used = new Set<string>();
    for (const change of changes) {
      const entry = findMicroToolResultEntry(available, used, change.before);
      if (!entry) {
        restoreMicroToolResults(applied);
        return false;
      }
      used.add(entry.id);
      applied.push({ entry, content: entry.message.content });
      entry.message = { ...entry.message, content: change.after.content };
    }

    const telemetryId = this.services.sessionStore.appendCustomEntry(
      record,
      "spark-compaction-micro",
      {
        type: "micro",
        tokensBefore: pass.tokensBefore,
        tokensAfter: pass.tokensAfter,
        compactedMessages: pass.compactedMessages,
        ...(pass.abortReason ? { abortReason: pass.abortReason } : {}),
        metadata: {
          summaryVersion: CURRENT_SPARK_COMPACTION_SUMMARY_VERSION,
          tokenSource: pass.tokenSource,
          measuredReductionRatio: pass.measuredReductionRatio,
        },
      },
    );
    try {
      await this.services.sessionStore.save(record);
      return true;
    } catch {
      restoreMicroToolResults(applied);
      if (record.entries.at(-1)?.id === telemetryId) record.entries.pop();
      return false;
    }
  }

  private async tryCompact(
    record: SparkSessionRecord,
    reason: "auto" | "context_overflow",
    willRetry: boolean,
    force: boolean,
    settings?: SparkCompactionSettings,
  ): Promise<boolean> {
    try {
      return await this.compact(
        record,
        reason,
        willRetry,
        force,
        settings ?? this.services.config.compact ?? DEFAULT_SPARK_COMPACTION_SETTINGS,
      );
    } catch {
      // Keep the original provider outcome if compaction itself cannot be
      // completed. The user still receives the actionable overflow error.
      return false;
    }
  }

  private async compact(
    record: SparkSessionRecord,
    reason: "auto" | "context_overflow",
    willRetry: boolean,
    force: boolean,
    settings: SparkCompactionSettings,
  ): Promise<boolean> {
    const initialPreparation = prepareForAutomaticCompaction(record, force, settings);
    if (!initialPreparation || initialPreparation.messagesToSummarize.length === 0) return false;

    let compactionEntry: SparkCompactionEntry | undefined;
    let compactionSucceeded = false;
    let lifecycleStarted = false;
    try {
      lifecycleStarted = true;
      const results = await this.services.runtime.emit("session_before_compact", {
        reason,
        willRetry,
        consumeMessage: true,
      });
      appendCompactionCheckpointMessages(this.services, record, results);
      const preparation = prepareForAutomaticCompaction(record, force, settings);
      if (!preparation || preparation.messagesToSummarize.length === 0) return false;
      const replayBefore = activeSessionReplayMessages(record);
      const beforeMeter = meterSparkContextTokens({
        messages: replayBefore,
        reportedTokens: latestReportedContextTokens(record),
      });
      // Reduction must compare the same meter on both sides. Provider usage
      // describes the request before compaction and cannot be compared with a
      // newly estimated compacted replay.
      const estimatedTokensBefore = meterSparkContextTokens({ messages: replayBefore }).tokens;
      compactionEntry = await compactSparkSessionRecord(
        record,
        preparation,
        deterministicSparkCompactionSummary,
        {
          tokenSource: beforeMeter.tokenSource,
          measuredReductionRatio: 0,
          fallbackReason: "deterministic_requested",
        },
      );
      const estimatedTokensAfter = meterSparkContextTokens({
        messages: activeSessionReplayMessages(record),
      }).tokens;
      const repeatedCompaction =
        preparation.messagesToSummarize.length === 1 &&
        preparation.messagesToSummarize[0]?.role === "compactionSummary";
      const reductionRatio = measuredReductionRatio(estimatedTokensBefore, estimatedTokensAfter);
      if (repeatedCompaction && reductionRatio < settings.minUsefulReduction) {
        if (record.entries.at(-1)?.id === compactionEntry.id) record.entries.pop();
        compactionEntry = undefined;
        return false;
      }
      if (compactionEntry.metadata) {
        compactionEntry.metadata.measuredReductionRatio = reductionRatio;
      }
      await this.services.sessionStore.save(record);
      compactionSucceeded = true;
      return true;
    } finally {
      if (lifecycleStarted) {
        try {
          await this.services.runtime.emit("session_compact", {
            reason,
            willRetry,
            sessionId: record.header.id,
            compactType: "full",
            succeeded: compactionSucceeded,
            ...(compactionSucceeded && compactionEntry
              ? { compactionEntryId: compactionEntry.id, compactionEntry }
              : {}),
          });
        } catch {
          // The durable compaction already succeeded. A projection listener
          // must not make the caller resend the same prompt or duplicate it.
        }
      }
    }
  }
}

function prepareForAutomaticCompaction(
  record: SparkSessionRecord,
  force: boolean,
  settings: SparkCompactionSettings = DEFAULT_SPARK_COMPACTION_SETTINGS,
): SparkCompactionPreparation | undefined {
  const preparation = prepareSparkCompaction(record, undefined, settings, {
    allowCompactionLeaf: force,
  });
  if (!force || !preparation || preparation.messagesToSummarize.length > 0) return preparation;
  return prepareSparkCompaction(
    record,
    undefined,
    {
      ...settings,
      keepRecentTokens: Math.max(1, Math.min(10_000, Math.floor(preparation.tokensBefore / 2))),
    },
    { allowCompactionLeaf: true },
  );
}

function appendCompactionCheckpointMessages(
  services: SparkCliHostServices,
  record: SparkSessionRecord,
  results: unknown[],
): void {
  for (const result of results) {
    const message = recordMetadata(recordMetadata(result).message);
    const customType = typeof message.customType === "string" ? message.customType : "";
    const content = typeof message.content === "string" ? message.content : "";
    if (!customType || !content) continue;
    services.sessionStore.appendCustomMessage(
      record,
      customType,
      content,
      message.display === true,
      recordMetadata(message.details),
    );
  }
}

function latestReportedContextTokens(record: SparkSessionRecord): number | undefined {
  const branch = getSparkSessionBranch(record);
  const latestCompactionIndex = findLastIndex(branch, (entry) => entry.type === "compaction");
  for (let index = branch.length - 1; index > latestCompactionIndex; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = recordMetadata(entry.message.usage);
    const input = nonNegativeNumber(usage.input);
    const cacheRead = nonNegativeNumber(usage.cacheRead) ?? 0;
    const cacheWrite = nonNegativeNumber(usage.cacheWrite) ?? 0;
    if (input !== undefined) return input + cacheRead + cacheWrite;
  }
  return undefined;
}

function activeSessionReplayMessages(record: SparkSessionRecord): SparkSessionMessage[] {
  return sessionRecordToAgentMessages(record).map(agentMessageToSessionMessage);
}

interface SparkMicroToolResultChange {
  before: SparkSessionMessage;
  after: SparkSessionMessage;
}

function changedMicroToolResults(
  before: readonly SparkSessionMessage[],
  after: readonly SparkSessionMessage[],
): SparkMicroToolResultChange[] {
  const changes: SparkMicroToolResultChange[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index];
    const next = after[index];
    if (!previous || !next || previous.role !== "toolResult" || next.role !== "toolResult")
      continue;
    if (JSON.stringify(previous.content) === JSON.stringify(next.content)) continue;
    changes.push({ before: previous, after: next });
  }
  return changes;
}

function findMicroToolResultEntry(
  entries: readonly SparkSessionMessageEntry[],
  used: ReadonlySet<string>,
  message: SparkSessionMessage,
): SparkSessionMessageEntry | undefined {
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  if (toolCallId) {
    const byCallId = entries.find(
      (entry) => !used.has(entry.id) && entry.message.toolCallId === toolCallId,
    );
    if (byCallId) return byCallId;
  }
  const signature = JSON.stringify({
    toolName: message.toolName,
    content: message.content,
  });
  return entries.find(
    (entry) =>
      !used.has(entry.id) &&
      JSON.stringify({
        toolName: entry.message.toolName,
        content: entry.message.content,
      }) === signature,
  );
}

function restoreMicroToolResults(
  applied: ReadonlyArray<{ entry: SparkSessionMessageEntry; content: unknown }>,
): void {
  for (const { entry, content } of applied) entry.message = { ...entry.message, content };
}

function measuredReductionRatio(tokensBefore: number, tokensAfter: number): number {
  if (tokensBefore <= 0) return 0;
  return Math.max(0, Math.min(1, (tokensBefore - tokensAfter) / tokensBefore));
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Extract only display-safe answer prose from the terminal assistant message.
 * Thinking, tool arguments, and signed commentary remain available in the
 * structured session record but must never become a channel/static reply.
 */
export function assistantMessageToFinalAnswerText(message: {
  content?: unknown;
  stopReason?: unknown;
}): string {
  if (typeof message.content === "string") {
    return message.stopReason === "toolUse" ? "" : message.content;
  }
  if (!Array.isArray(message.content)) return "";
  let hasToolCall = false;
  const textParts = message.content.flatMap((value): Array<{ text: string; phase?: string }> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const part = value as Record<string, unknown>;
    if (part.type === "toolCall" || part.type === "tool-call") hasToolCall = true;
    if (part.type !== "text" || typeof part.text !== "string") return [];
    const phase = sparkTextPhaseFromSignature(part.textSignature);
    if (phase === "commentary") return [];
    return [{ text: part.text, ...(phase ? { phase } : {}) }];
  });
  const explicitFinal = textParts.filter((part) => part.phase === "final_answer");
  if (explicitFinal.length > 0) {
    return explicitFinal
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
  }
  if (message.stopReason === "toolUse" || hasToolCall) return "";
  return textParts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

export function sessionRecordToAgentMessages(record: SparkSessionRecord): Message[] {
  return lowerSparkPromptItems(sessionRecordToPromptItems(record)) as Message[];
}

export function sessionRecordToPromptItems(record: SparkSessionRecord): SparkPromptItem[] {
  return sessionEntriesToPromptItems(record.entries);
}

export function sessionMessageToAgentMessage(message: SparkSessionMessage): Message | undefined {
  if (message.role === "user" && isKnownContent(message.content)) {
    return {
      role: "user",
      content: message.content as UserMessage["content"],
      timestamp: normalizeTimestamp(message.timestamp),
    };
  }
  if (message.role === "assistant") {
    if (Array.isArray(message.content)) return message as Message;
    if (typeof message.content === "string") {
      return {
        ...(message as unknown as Record<string, unknown>),
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        timestamp: normalizeTimestamp(message.timestamp),
      } as Message;
    }
  }
  if (message.role === "toolResult" && Array.isArray(message.content)) return message as Message;
  return undefined;
}

export function agentMessageToSessionMessage(message: Message): SparkSessionMessage {
  return { ...(message as unknown as Record<string, unknown>), role: message.role };
}

export function sessionEntriesToAgentMessages(entries: SparkSessionEntry[]): Message[] {
  return lowerSparkPromptItems(sessionEntriesToPromptItems(entries)) as Message[];
}

export function sessionEntriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const pathEntries = branchEntriesForLeaf(entries);
  const latestCompactionIndex = findLastIndex(
    pathEntries,
    (entry): entry is SparkCompactionEntry => entry.type === "compaction",
  );
  if (latestCompactionIndex < 0) return entriesToPromptItems(pathEntries);

  const compaction = pathEntries[latestCompactionIndex] as SparkCompactionEntry;
  const items: SparkPromptItem[] = [compactionSummaryToPromptItem(compaction)];
  let foundFirstKept = false;
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = pathEntries[index]!;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendEntryPromptItem(items, entry);
  }
  for (let index = latestCompactionIndex + 1; index < pathEntries.length; index += 1)
    appendEntryPromptItem(items, pathEntries[index]!);
  return items;
}

function branchEntriesForLeaf(entries: SparkSessionEntry[]): SparkSessionEntry[] {
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SparkSessionEntry[] = [];
  let current: SparkSessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function entriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const items: SparkPromptItem[] = [];
  for (const entry of entries) appendEntryPromptItem(items, entry);
  return items;
}

function appendEntryPromptItem(items: SparkPromptItem[], entry: SparkSessionEntry): void {
  const item = entryToPromptItem(entry);
  if (item) items.push(item);
}

function entryToPromptItem(entry: SparkSessionEntry): SparkPromptItem | undefined {
  if (entry.type === "message") {
    const message = sessionMessageToAgentMessage(entry.message);
    return message
      ? sparkPromptItemFromProviderMessage(
          message as unknown as Record<string, unknown> & { role: string },
        )
      : undefined;
  }
  if (entry.type === "custom_message") return customMessageToPromptItem(entry);
  if (entry.type === "branch_summary") return branchSummaryToPromptItem(entry);
  return undefined;
}

function customMessageToPromptItem(entry: SparkCustomMessageEntry): SparkPromptItem {
  const details = recordMetadata(entry.details);
  const metadata = parseSparkPromptItemMetadata(details[SPARK_PROMPT_ITEM_METADATA_KEY]);
  const authority =
    metadata?.authority === "system" ||
    metadata?.authority === "developer" ||
    metadata?.authority === "runtime_control" ||
    metadata?.authority === "runtime_data"
      ? metadata.authority
      : "runtime_data";
  return sparkRuntimePromptItem({
    authority,
    // Legacy custom messages did not carry authority. Treat them as data rather
    // than silently promoting old transcript text into trusted control.
    trust: metadata?.trust ?? "untrusted",
    visibility: entry.display === false ? "hidden" : (metadata?.visibility ?? "visible"),
    persistence: "session",
    content: entry.content,
    customType: entry.customType,
    details,
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function branchSummaryToPromptItem(entry: SparkBranchSummaryEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-branch-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function compactionSummaryToPromptItem(entry: SparkCompactionEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-compaction-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function isKnownContent(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

function normalizeTimestamp(timestamp: unknown): number {
  return typeof timestamp === "number" ? timestamp : Date.now();
}

function recordMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
