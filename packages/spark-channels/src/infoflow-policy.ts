import type { InfoflowAdapterConfig, InfoflowChatType } from "./types.ts";

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

export function isInfoflowInboundAllowed(
  config: InfoflowAdapterConfig,
  input: {
    chatType: InfoflowChatType;
    senderId: string;
    senderName?: string;
    groupId?: string;
  },
): boolean {
  switch (input.chatType) {
    case "private":
      return isInfoflowPrivateAllowed(config, input.senderId, input.senderName);
    case "group": {
      const groupId = input.groupId?.trim();
      if (!groupId) return false;
      return isInfoflowGroupAllowed(config, groupId);
    }
    default: {
      const unexpected: never = input.chatType;
      throw new Error(`unsupported infoflow chat type: ${String(unexpected)}`);
    }
  }
}
