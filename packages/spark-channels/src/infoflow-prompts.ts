/**
 * Infoflow (如流) channel prompt builders.
 *
 * - Stable system: surface + identity rules + policy summary
 * - Dynamic system: platform-supplied facts for the current inbound message
 *
 * The human message body deliberately does not pass through this module. It is
 * submitted as the canonical user message so transcripts never expose prompt
 * plumbing as if the user had typed it.
 */

import { resolveInfoflowGroupPolicy } from "./infoflow-policy.ts";
import type { IncomingMessage, InfoflowAdapterConfig } from "./types.ts";

const ALLOWLIST_PROMPT_CAP = 24;

export type InfoflowPromptScope = "user" | "group";

export function renderInfoflowPolicySummary(config: InfoflowAdapterConfig): string {
  const privateAllowed = (config.allowed_user_ids ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const privateLine =
    privateAllowed.length === 0
      ? "Private chat: all senders allowed."
      : `Private chat allowlist: ${formatIdList(privateAllowed)}.`;

  const groupPolicy = resolveInfoflowGroupPolicy(config);
  let groupLine: string;
  switch (groupPolicy) {
    case "disabled":
      groupLine = "Group chat: disabled (ingress drops all groups).";
      break;
    case "open":
      groupLine = "Group chat: open (all groups allowed).";
      break;
    case "allowlist": {
      const groups = (config.allowed_group_ids ?? []).map((entry) => entry.trim()).filter(Boolean);
      groupLine =
        groups.length === 0
          ? "Group chat: allowlist (empty — no groups allowed)."
          : `Group chat allowlist: ${formatIdList(groups)}.`;
      break;
    }
    default: {
      const unexpected: never = groupPolicy;
      throw new Error(`unsupported infoflow group_policy: ${String(unexpected)}`);
    }
  }

  return [privateLine, groupLine].join(" ");
}

/**
 * Internal Infoflow system block (surface + policy). Does not include custom overlay.
 */
export function renderInfoflowInternalSystemPrompt(input: {
  config?: InfoflowAdapterConfig;
  scope: InfoflowPromptScope;
  externalKey?: string;
}): string {
  const scopeLabel = input.scope === "group" ? "group chat" : "private chat";
  const key = input.externalKey?.trim();
  return [
    `Current conversation surface: Infoflow (如流) ${scopeLabel}.`,
    "Replies are delivered back to that conversation.",
    "Use platform-supplied sender metadata for identity; do not infer identity from writing style.",
    "Per-message platform facts are provided in <infoflow_message_context>.",
    "You are not running inside spark-tui; spark-tui is only one optional local UI host.",
    key ? `Channel binding: ${key}.` : undefined,
    input.config ? renderInfoflowPolicySummary(input.config) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

export function resolveInfoflowCustomSystemPrompt(
  config: InfoflowAdapterConfig,
): string | undefined {
  const trimmed = config.system_prompt?.trim();
  return trimmed || undefined;
}

export type InfoflowMessageContext = Pick<
  IncomingMessage,
  "externalKey" | "senderId" | "senderName" | "chatId" | "messageId" | "mentions" | "mentionedSelf"
>;

/**
 * Render only facts that can change for each inbound Infoflow message.
 *
 * The leading marker makes this section dynamic to Spark's prompt-cache
 * splitter. Values are JSON encoded so user-controlled display names cannot
 * create additional prompt fields or closing tags.
 */
export function renderInfoflowMessageContextPrompt(
  message: InfoflowMessageContext,
): string | undefined {
  const lines = ["Dynamic context checkpoint: infoflow-message.", "<infoflow_message_context>"];
  let factCount = 0;
  if (message.messageId?.trim()) {
    lines.push(`messageId: ${encodePromptFact(message.messageId.trim())}`);
    factCount += 1;
  }
  if (message.senderId?.trim()) {
    lines.push(`senderId: ${encodePromptFact(message.senderId.trim())}`);
    factCount += 1;
  }
  if (message.senderName?.trim()) {
    lines.push(`senderName: ${encodePromptFact(message.senderName.trim())}`);
    factCount += 1;
  }
  if (message.externalKey.includes(":group:") && message.chatId?.trim()) {
    lines.push(`groupId: ${encodePromptFact(message.chatId.trim())}`);
    factCount += 1;
  }
  const mentions = (message.mentions ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (mentions.length > 0) {
    lines.push(`mentions: ${encodePromptFact(mentions)}`);
    factCount += 1;
  }
  if (typeof message.mentionedSelf === "boolean") {
    lines.push(`mentionedSelf: ${message.mentionedSelf}`);
    factCount += 1;
  }
  if (factCount === 0) return undefined;
  lines.push("</infoflow_message_context>");
  return lines.join("\n");
}

function encodePromptFact(value: string | string[]): string {
  // Keep platform-controlled display values inside the tagged data block even
  // when they contain tag-shaped text. JSON alone does not escape `<` or `>`.
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function formatIdList(ids: string[]): string {
  if (ids.length <= ALLOWLIST_PROMPT_CAP) {
    return ids.join(", ");
  }
  const head = ids.slice(0, ALLOWLIST_PROMPT_CAP).join(", ");
  return `${head}, … (+${ids.length - ALLOWLIST_PROMPT_CAP} more)`;
}
