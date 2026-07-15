<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    channelSessionScopeKind,
    type ChannelSessionAdapter,
    type ChannelSessionScope,
  } from "$lib/channel-session-title";
  import type { IconName } from "$lib/icons";

  let {
    adapter,
    scope,
    label,
  }: {
    adapter: ChannelSessionAdapter;
    scope: ChannelSessionScope;
    label: string;
  } = $props();

  let adapterIcon = $derived<IconName>(
    adapter === "qqbot" ? "agents" : adapter === "feishu" ? "send" : "waves",
  );
  let scopeKind = $derived(channelSessionScopeKind(adapter, scope));
  let scopeIcon = $derived<IconName>(
    scopeKind === "private"
      ? "user"
      : scopeKind === "group"
        ? "users"
        : scopeKind === "channel"
          ? "hash"
          : "message",
  );
</script>

<span
  class="channel-session-icon {adapter} scope-{scopeKind}"
  role="img"
  aria-label={label}
  title={label}
>
  <Icon name={adapterIcon} size={14} stroke={2.1} />
  <span class="scope-icon" aria-hidden="true">
    <Icon name={scopeIcon} size={10} stroke={2.5} />
  </span>
</span>

<style>
  .channel-session-icon {
    --channel-color: var(--color-primary);
    --scope-color: var(--color-ink-subtle);
    align-items: center;
    background: color-mix(in srgb, var(--channel-color) 11%, var(--color-surface));
    border: 1px solid color-mix(in srgb, var(--channel-color) 18%, var(--color-border-soft));
    border-radius: 6px;
    color: var(--channel-color);
    display: inline-flex;
    flex: 0 0 22px;
    height: 22px;
    justify-content: center;
    position: relative;
    width: 22px;
  }

  .channel-session-icon.qqbot {
    --channel-color: #1677d2;
  }

  .channel-session-icon.infoflow {
    --channel-color: #4c5ee5;
  }

  .channel-session-icon.feishu {
    --channel-color: #078a67;
  }

  .scope-icon {
    align-items: center;
    background: var(--scope-color);
    border: 0;
    border-radius: 4px;
    bottom: -3px;
    box-shadow: 0 0 0 2px var(--color-surface);
    color: white;
    display: inline-flex;
    height: 14px;
    justify-content: center;
    position: absolute;
    right: -3px;
    width: 14px;
  }

  .scope-private {
    --scope-color: var(--color-info);
  }

  .scope-private .scope-icon {
    border-radius: 999px;
  }

  .scope-group {
    --scope-color: var(--color-purple);
  }

  .scope-group .scope-icon {
    border-radius: 4px;
  }

  .scope-channel {
    --scope-color: #0f766e;
  }

  .scope-channel .scope-icon {
    border-radius: 3px;
  }

  @media (forced-colors: active) {
    .scope-icon {
      background: CanvasText;
      box-shadow: 0 0 0 1px Canvas;
      color: Canvas;
      forced-color-adjust: none;
    }
  }
</style>
