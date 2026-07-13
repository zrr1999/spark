import type { InfoflowAdapterConfig, InfoflowChatType, InfoflowGroupTrigger } from "./types.ts";

export type InfoflowGroupPolicy = NonNullable<InfoflowAdapterConfig["group_policy"]>;

/** Empty / missing allowlist means all private senders are accepted. */
export function isInfoflowPrivateAllowed(
  config: InfoflowAdapterConfig,
  senderId: string,
  senderName?: string,
): boolean {
  const allowed = config.allowed_user_ids ?? [];
  if (allowed.length === 0) return true;
  const set = new Set(allowed.map((entry) => entry.trim()).filter(Boolean));
  if (set.has(senderId.trim())) return true;
  return Boolean(senderName?.trim() && set.has(senderName.trim()));
}

/**
 * Group ingress policy (nyakore-aligned):
 * - disabled (default): drop all group messages
 * - open: accept every group
 * - allowlist: only `allowed_group_ids`
 */
export function isInfoflowGroupAllowed(config: InfoflowAdapterConfig, groupId: string): boolean {
  const policy = resolveInfoflowGroupPolicy(config);
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
      throw new Error(`unsupported infoflow group_policy: ${String(unexpected)}`);
    }
  }
}

export function resolveInfoflowGroupPolicy(config: InfoflowAdapterConfig): InfoflowGroupPolicy {
  return config.group_policy ?? "disabled";
}

/** Default to explicit bot mentions so ALL_MESSAGE_FORWARD cannot silently create turns. */
export function resolveInfoflowGroupTrigger(config: InfoflowAdapterConfig): InfoflowGroupTrigger {
  return config.group_trigger ?? "mention";
}

export function isInfoflowGroupTriggered(
  config: InfoflowAdapterConfig,
  input: { text: string; eventType?: string; mentionedSelf?: boolean },
): boolean {
  const trigger = resolveInfoflowGroupTrigger(config);
  const eventType = input.eventType?.trim().toUpperCase();
  if (eventType === "ALL_MESSAGE_FORWARD" && trigger !== "all") return false;
  if (eventType && eventType !== "MESSAGE_RECEIVE" && eventType !== "ALL_MESSAGE_FORWARD") {
    return false;
  }
  switch (trigger) {
    case "mention":
      return input.mentionedSelf === true;
    case "command":
      return /^\s*[!/][^\s]*/u.test(input.text);
    case "all":
      return true;
    default: {
      const unexpected: never = trigger;
      throw new Error(`unsupported infoflow group_trigger: ${String(unexpected)}`);
    }
  }
}

export function isInfoflowInboundAllowed(
  config: InfoflowAdapterConfig,
  input: {
    chatType: InfoflowChatType;
    senderId: string;
    senderName?: string;
    groupId?: string;
    text?: string;
    eventType?: string;
    mentionedSelf?: boolean;
  },
): boolean {
  switch (input.chatType) {
    case "private":
      return isInfoflowPrivateAllowed(config, input.senderId, input.senderName);
    case "group": {
      const groupId = input.groupId?.trim();
      if (!groupId) return false;
      return (
        isInfoflowGroupAllowed(config, groupId) &&
        isInfoflowGroupTriggered(config, {
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
      throw new Error(`unsupported infoflow chat type: ${String(unexpected)}`);
    }
  }
}
