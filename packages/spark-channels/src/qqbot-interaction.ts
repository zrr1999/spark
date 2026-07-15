import type { QqbotCallbackToken } from "./qqbot-types.ts";

export type QqbotInteractionScene = "c2c" | "group" | "guild";
export type QqbotInteractionChatType = 0 | 1 | 2;
export type QqbotInteractionType = 11 | 12;

/** Normalized INTERACTION_CREATE data before the transport maps it to a channel event. */
export interface QqbotNormalizedInteraction {
  eventType: "INTERACTION_CREATE";
  interactionId: string;
  interactionType: QqbotInteractionType;
  scene?: QqbotInteractionScene;
  chatType?: QqbotInteractionChatType;
  timestamp?: string;
  callbackToken?: QqbotCallbackToken;
  buttonId?: string;
  actorId?: string;
  userOpenid?: string;
  groupOpenid?: string;
  groupMemberOpenid?: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
  featureId?: string;
  version?: number;
  raw: unknown;
}

/**
 * Parse an INTERACTION_CREATE envelope without treating it as text ingress.
 * The parser accepts both gateway envelopes and the transport's event_type wrapper.
 */
export function normalizeQqbotInteractionEvent(
  raw: unknown,
): QqbotNormalizedInteraction | undefined {
  const envelope = asRecord(raw);
  if (!envelope) return undefined;

  const eventType = trimmedString(envelope.event_type) ?? trimmedString(envelope.t);
  if (eventType && eventType !== "INTERACTION_CREATE") return undefined;

  const payload = asRecord(envelope.d) ?? envelope;
  const data = asRecord(payload.data);
  // `resoloved` appears in one official table; live examples and Tencent's
  // implementation use `resolved`. Accepting both keeps the boundary defensive.
  const resolved = asRecord(data?.resolved) ?? asRecord(data?.resoloved);
  const interactionId = trimmedString(payload.id);
  const interactionType = interactionTypeValue(payload.type) ?? interactionTypeValue(data?.type);

  if (!interactionId || interactionType === undefined) return undefined;
  if (!eventType && !resolved) return undefined;

  const chatType = chatTypeValue(payload.chat_type);
  const explicitScene = sceneValue(payload.scene);
  const scene = explicitScene ?? sceneFromChatType(chatType);
  const callbackToken = opaqueString(resolved?.button_data);
  const userOpenid = trimmedString(payload.user_openid);
  const groupOpenid = trimmedString(payload.group_openid);
  const groupMemberOpenid = trimmedString(payload.group_member_openid);
  const guildId = trimmedString(payload.guild_id);
  const channelId = trimmedString(payload.channel_id);
  const resolvedUserId = trimmedString(resolved?.user_id);
  const actorId =
    scene === "c2c"
      ? (userOpenid ?? resolvedUserId)
      : scene === "group"
        ? groupMemberOpenid
        : scene === "guild"
          ? resolvedUserId
          : (userOpenid ?? groupMemberOpenid ?? resolvedUserId);

  const timestamp = trimmedString(payload.timestamp);
  const buttonId = trimmedString(resolved?.button_id);
  const messageId = trimmedString(resolved?.message_id);
  const featureId = trimmedString(resolved?.feature_id);
  const version = finiteNumber(payload.version);

  return {
    eventType: "INTERACTION_CREATE",
    interactionId,
    interactionType,
    ...(scene ? { scene } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(callbackToken !== undefined ? { callbackToken } : {}),
    ...(buttonId ? { buttonId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(userOpenid ? { userOpenid } : {}),
    ...(groupOpenid ? { groupOpenid } : {}),
    ...(groupMemberOpenid ? { groupMemberOpenid } : {}),
    ...(guildId ? { guildId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(featureId ? { featureId } : {}),
    ...(version !== undefined ? { version } : {}),
    raw,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function opaqueString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function interactionTypeValue(value: unknown): QqbotInteractionType | undefined {
  return value === 11 || value === 12 ? value : undefined;
}

function chatTypeValue(value: unknown): QqbotInteractionChatType | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

function sceneValue(value: unknown): QqbotInteractionScene | undefined {
  return value === "c2c" || value === "group" || value === "guild" ? value : undefined;
}

function sceneFromChatType(
  chatType: QqbotInteractionChatType | undefined,
): QqbotInteractionScene | undefined {
  switch (chatType) {
    case 0:
      return "guild";
    case 1:
      return "group";
    case 2:
      return "c2c";
    default:
      return undefined;
  }
}
