/** Normalized QQ Bot inbound scene for policy + external keys. */
export type QqbotChatType = "c2c" | "group" | "channel";

export interface QqbotNormalizedInbound {
  chatType: QqbotChatType;
  /** Peer openid (C2C) or member openid (group) or author id (channel). */
  senderId: string;
  senderName?: string;
  /** group_openid or channel_id when applicable. */
  chatId?: string;
  text: string;
  messageId?: string;
  eventType?: string;
  mentionedSelf?: boolean;
  mentions?: string[];
}

/** Outbound recipient encoding used by daemon → transport. */
export type QqbotRecipient =
  | { kind: "c2c"; openid: string }
  | { kind: "group"; groupOpenid: string }
  | { kind: "channel"; channelId: string };

export function parseQqbotRecipient(recipient: string): QqbotRecipient {
  const trimmed = recipient.trim();
  const c2c = /^c2c:(.+)$/u.exec(trimmed);
  if (c2c?.[1]?.trim()) return { kind: "c2c", openid: c2c[1].trim() };
  const group = /^group:(.+)$/u.exec(trimmed);
  if (group?.[1]?.trim()) return { kind: "group", groupOpenid: group[1].trim() };
  const channel = /^channel:(.+)$/u.exec(trimmed);
  if (channel?.[1]?.trim()) return { kind: "channel", channelId: channel[1].trim() };
  throw new Error(
    `qqbot recipient must look like c2c:<openid>, group:<group_openid>, or channel:<channel_id>; got ${trimmed}`,
  );
}

export function formatQqbotRecipient(target: QqbotRecipient): string {
  switch (target.kind) {
    case "c2c":
      return `c2c:${target.openid}`;
    case "group":
      return `group:${target.groupOpenid}`;
    case "channel":
      return `channel:${target.channelId}`;
    default: {
      const unexpected: never = target;
      throw new Error(`unsupported qqbot recipient: ${String(unexpected)}`);
    }
  }
}
