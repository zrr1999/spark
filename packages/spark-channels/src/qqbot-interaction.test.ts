import { describe, expect, it } from "vitest";
import { normalizeQqbotInteractionEvent } from "./qqbot-interaction.ts";

describe("normalizeQqbotInteractionEvent", () => {
  it("normalizes a C2C callback and preserves opaque button data verbatim", () => {
    const raw = {
      t: "INTERACTION_CREATE",
      d: {
        id: "interaction-1",
        type: 11,
        chat_type: 2,
        user_openid: "user-1",
        timestamp: "2026-07-14T12:00:00+08:00",
        data: {
          resolved: {
            button_id: "approve",
            button_data: " token with spaces ",
          },
        },
        version: 1,
      },
    };

    expect(normalizeQqbotInteractionEvent(raw)).toEqual({
      eventType: "INTERACTION_CREATE",
      interactionId: "interaction-1",
      interactionType: 11,
      scene: "c2c",
      chatType: 2,
      timestamp: "2026-07-14T12:00:00+08:00",
      callbackToken: " token with spaces ",
      buttonId: "approve",
      actorId: "user-1",
      userOpenid: "user-1",
      version: 1,
      raw,
    });
  });

  it("normalizes group ids from the event_type wrapper", () => {
    const interaction = normalizeQqbotInteractionEvent({
      event_type: "INTERACTION_CREATE",
      d: {
        id: "interaction-2",
        scene: "group",
        chat_type: 1,
        group_openid: "group-1",
        group_member_openid: "member-1",
        data: {
          type: 11,
          resolved: {
            button_id: "reject",
            button_data: "token-2",
          },
        },
      },
    });

    expect(interaction).toMatchObject({
      interactionId: "interaction-2",
      interactionType: 11,
      scene: "group",
      chatType: 1,
      actorId: "member-1",
      groupOpenid: "group-1",
      groupMemberOpenid: "member-1",
      callbackToken: "token-2",
    });
  });

  it("accepts the documented C2C user fallback and resoloved typo defensively", () => {
    expect(
      normalizeQqbotInteractionEvent({
        event_type: "INTERACTION_CREATE",
        d: {
          id: "interaction-3",
          type: 11,
          chat_type: 2,
          data: {
            resoloved: {
              user_id: "fallback-user",
              button_data: "token-3",
            },
          },
        },
      }),
    ).toMatchObject({
      actorId: "fallback-user",
      callbackToken: "token-3",
      scene: "c2c",
    });
  });

  it("keeps channel actor and source message metadata without promising channel sends", () => {
    expect(
      normalizeQqbotInteractionEvent({
        event_type: "INTERACTION_CREATE",
        d: {
          id: "interaction-4",
          type: 11,
          scene: "guild",
          chat_type: 0,
          guild_id: "guild-1",
          channel_id: "channel-1",
          data: {
            resolved: {
              user_id: "channel-user",
              button_data: "token-4",
              message_id: "source-4",
            },
          },
        },
      }),
    ).toMatchObject({
      scene: "guild",
      actorId: "channel-user",
      guildId: "guild-1",
      channelId: "channel-1",
      callbackToken: "token-4",
      messageId: "source-4",
    });
  });

  it("does not parse ordinary message events as interactions", () => {
    expect(
      normalizeQqbotInteractionEvent({
        event_type: "C2C_MESSAGE_CREATE",
        d: { id: "message-1", type: 11, data: { resolved: {} } },
      }),
    ).toBeUndefined();
  });
});
