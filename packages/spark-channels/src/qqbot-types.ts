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

/**
 * Opaque callback correlation value placed in `action.data` and returned as
 * `button_data`. spark-channels never interprets or rewrites it.
 */
export type QqbotCallbackToken = string;

/** QQ button permission codes from the current Open Platform protocol. */
export type QqbotKeyboardPermission =
  | { type: 0; specify_user_ids: string[]; specify_role_ids?: never }
  | { type: 1; specify_user_ids?: never; specify_role_ids?: never }
  | { type: 2; specify_user_ids?: never; specify_role_ids?: never }
  | { type: 3; specify_user_ids?: never; specify_role_ids: string[] };

/** Callback-only action used by Spark native asks. */
export interface QqbotCallbackKeyboardAction {
  type: 1;
  permission: QqbotKeyboardPermission;
  data: QqbotCallbackToken;
  unsupport_tips: string;
}

export interface QqbotKeyboardRenderData {
  label: string;
  visited_label: string;
  /** 0 gray outline, 1 blue outline. */
  style: 0 | 1;
}

export interface QqbotKeyboardButton {
  /** Unique within one keyboard message when provided. */
  id?: string;
  render_data: QqbotKeyboardRenderData;
  action: QqbotCallbackKeyboardAction;
}

export interface QqbotKeyboardRow {
  buttons: QqbotKeyboardButton[];
}

export interface QqbotCustomKeyboard {
  rows: QqbotKeyboardRow[];
}

/** Template id and custom content are mutually exclusive wire forms. */
export type QqbotMessageKeyboard =
  | { id: string; content?: never }
  | { id?: never; content: QqbotCustomKeyboard };

/** Exact Markdown + keyboard request accepted by C2C and group message APIs. */
export interface QqbotMarkdownKeyboardMessageRequest {
  markdown: { content: string };
  keyboard: QqbotMessageKeyboard;
  msg_id?: string;
  msg_seq?: number;
  event_id?: string;
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
