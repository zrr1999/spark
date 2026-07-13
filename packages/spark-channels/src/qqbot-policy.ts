import type { QqbotAdapterConfig, QqbotGroupPolicy, QqbotGroupTrigger } from "./types.ts";
import type { QqbotChatType } from "./qqbot-types.ts";

/** Empty / missing allowlist means all private senders are accepted. */
export function isQqbotPrivateAllowed(config: QqbotAdapterConfig, senderId: string): boolean {
  const allowed = config.allowed_user_ids ?? [];
  if (allowed.length === 0) return true;
  const set = new Set(allowed.map((entry) => entry.trim()).filter(Boolean));
  return set.has(senderId.trim());
}

/**
 * Group ingress policy (Infoflow-aligned):
 * - disabled (default): drop all group messages
 * - open: accept every group
 * - allowlist: only `allowed_group_ids`
 */
export function isQqbotGroupAllowed(config: QqbotAdapterConfig, groupId: string): boolean {
  const policy = resolveQqbotGroupPolicy(config);
  switch (policy) {
    case "disabled":
      return false;
    case "open":
      return true;
    case "allowlist": {
      const allowed = new Set(
        (config.allowed_group_ids ?? []).map((entry) => entry.trim()).filter(Boolean),
      );
      return allowed.has(groupId.trim());
    }
    default: {
      const unexpected: never = policy;
      throw new Error(`unsupported qqbot group_policy: ${String(unexpected)}`);
    }
  }
}

export function resolveQqbotGroupPolicy(config: QqbotAdapterConfig): QqbotGroupPolicy {
  return config.group_policy ?? "disabled";
}

/** Default to explicit bot mentions so open group traffic cannot silently create turns. */
export function resolveQqbotGroupTrigger(config: QqbotAdapterConfig): QqbotGroupTrigger {
  return config.group_trigger ?? "mention";
}

export function isQqbotGroupTriggered(
  config: QqbotAdapterConfig,
  input: { text: string; eventType?: string; mentionedSelf?: boolean },
): boolean {
  const trigger = resolveQqbotGroupTrigger(config);
  const eventType = input.eventType?.trim().toUpperCase();
  // QQ AT events are an explicit mention of the bot.
  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    if (trigger === "all" || trigger === "mention") return true;
  }
  switch (trigger) {
    case "mention":
      return input.mentionedSelf === true || eventType === "GROUP_AT_MESSAGE_CREATE";
    case "command":
      return /^\s*[!/][^\s]*/u.test(input.text);
    case "all":
      return true;
    default: {
      const unexpected: never = trigger;
      throw new Error(`unsupported qqbot group_trigger: ${String(unexpected)}`);
    }
  }
}

export function isQqbotInboundAllowed(
  config: QqbotAdapterConfig,
  input: {
    chatType: QqbotChatType;
    senderId: string;
    groupId?: string;
    text?: string;
    eventType?: string;
    mentionedSelf?: boolean;
  },
): boolean {
  switch (input.chatType) {
    case "c2c":
      return isQqbotPrivateAllowed(config, input.senderId);
    case "channel":
      // Guild channel messages are @-gated by the platform for public bots; accept when allowed.
      return true;
    case "group": {
      const groupId = input.groupId?.trim();
      if (!groupId) return false;
      return (
        isQqbotGroupAllowed(config, groupId) &&
        isQqbotGroupTriggered(config, {
          text: input.text ?? "",
          ...(input.eventType ? { eventType: input.eventType } : {}),
          ...(typeof input.mentionedSelf === "boolean"
            ? { mentionedSelf: input.mentionedSelf }
            : {}),
        })
      );
    }
    default: {
      const unexpected: never = input.chatType;
      throw new Error(`unsupported qqbot chat type: ${String(unexpected)}`);
    }
  }
}
