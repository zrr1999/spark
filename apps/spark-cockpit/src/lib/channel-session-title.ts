/** Turn stored `channel <adapter>:<scope>:<id>` titles into UI-friendly labels. */

const CHANNEL_TITLE_RE = /^channel\s+(infoflow|qqbot|feishu):(group|user|c2c|channel|chat):(.+)$/iu;
const CHANNEL_KEY_RE = /^(infoflow|qqbot|feishu):(group|user|c2c|channel|chat):(.+)$/iu;

export type ChannelSessionAdapter = "infoflow" | "qqbot" | "feishu";
export type ChannelSessionScope = "group" | "user" | "c2c" | "channel" | "chat";
export type ChannelSessionScopeKind = "private" | "group" | "channel" | "conversation";

export type ChannelSessionLabels = {
  infoflowGroup: string;
  infoflowPrivate: string;
  qqGroup: string;
  qqChannel: string;
  qqPrivate: string;
  feishuConversation: string;
};

type ChannelSessionPresentationOptions = {
  fallback: string;
  labels?: ChannelSessionLabels;
  /** @deprecated Pass translated `labels`; kept for older Cockpit consumers. */
  locale?: string;
};

export type ChannelSessionDescriptor = {
  adapter: ChannelSessionAdapter;
  scope: ChannelSessionScope;
  externalId: string;
  label: string;
};

export type ChannelSessionPresentation = {
  title: string;
  channel: ChannelSessionDescriptor | null;
};

/** Map adapter-specific scopes to the visual meaning we can assert from runtime data. */
export function channelSessionScopeKind(
  adapter: ChannelSessionAdapter,
  scope: ChannelSessionScope,
): ChannelSessionScopeKind {
  if (adapter === "infoflow") {
    if (scope === "user") return "private";
    if (scope === "group") return "group";
  }
  if (adapter === "qqbot") {
    if (scope === "c2c") return "private";
    if (scope === "group") return "group";
    if (scope === "channel") return "channel";
  }
  return "conversation";
}

export function sessionHasChannelBinding(session: {
  bindings?: Array<{ kind?: string }> | null;
  title?: string | null;
}): boolean {
  if (session.bindings?.some((binding) => binding.kind === "channel")) return true;
  return CHANNEL_TITLE_RE.test(session.title?.trim() ?? "");
}

export function formatChannelSessionTitle(
  title: string | undefined | null,
  options: ChannelSessionPresentationOptions,
): string {
  const raw = title?.trim() || options.fallback;
  const match = raw.match(CHANNEL_TITLE_RE);
  if (!match) return raw;

  const adapter = match[1]!.toLowerCase();
  const scope = match[2]!.toLowerCase();
  const id = match[3]!.trim();
  const scopeLabel = channelScopeLabel(adapter, scope, resolveChannelSessionLabels(options));
  if (!scopeLabel) return raw;
  return `${scopeLabel} · ${shortenOpaqueChannelId(id)}`;
}

/**
 * Keep a channel session compact where an icon already carries adapter/scope.
 * Custom user titles remain untouched; generated channel titles collapse to the
 * human or shortened external id.
 */
export function channelSessionPresentation(
  session: {
    title?: string | null;
    bindings?: Array<{
      kind?: string;
      adapter?: string;
      externalKey?: string;
    }> | null;
  },
  options: ChannelSessionPresentationOptions,
): ChannelSessionPresentation {
  const rawTitle = session.title?.trim() ?? "";
  const titleIdentity = parseChannelIdentity(rawTitle.replace(/^channel\s+/iu, ""));
  const bindingIdentity = session.bindings
    ?.filter((binding) => !binding.kind || binding.kind === "channel")
    .map((binding) => parseChannelIdentity(binding.externalKey ?? ""))
    .find((identity) => identity !== null);
  const identity = bindingIdentity ?? titleIdentity;
  return {
    title: titleIdentity
      ? shortenOpaqueChannelId(titleIdentity.externalId)
      : rawTitle || (identity ? shortenOpaqueChannelId(identity.externalId) : options.fallback),
    channel: identity
      ? {
          ...identity,
          label:
            channelScopeLabel(
              identity.adapter,
              identity.scope,
              resolveChannelSessionLabels(options),
            ) ?? `${identity.adapter} ${identity.scope}`,
        }
      : null,
  };
}

function parseChannelIdentity(value: string): Omit<ChannelSessionDescriptor, "label"> | null {
  const match = value.trim().match(CHANNEL_KEY_RE);
  if (!match) return null;
  const adapter = match[1]!.toLowerCase() as ChannelSessionAdapter;
  const scope = match[2]!.toLowerCase() as ChannelSessionScope;
  const externalId = match[3]!.trim();
  return isSupportedChannelIdentity(adapter, scope) && externalId
    ? { adapter, scope, externalId }
    : null;
}

function isSupportedChannelIdentity(adapter: string, scope: string): boolean {
  return (
    (adapter === "infoflow" && (scope === "group" || scope === "user")) ||
    (adapter === "qqbot" && (scope === "group" || scope === "channel" || scope === "c2c")) ||
    (adapter === "feishu" && scope === "chat")
  );
}

function resolveChannelSessionLabels(
  options: Pick<ChannelSessionPresentationOptions, "labels" | "locale">,
): ChannelSessionLabels {
  if (options.labels) return options.labels;
  const zh = options.locale?.toLowerCase().startsWith("zh") ?? false;
  return zh
    ? {
        infoflowGroup: "如流群聊",
        infoflowPrivate: "如流私聊",
        qqGroup: "QQ 群聊",
        qqChannel: "QQ 频道",
        qqPrivate: "QQ 私聊",
        feishuConversation: "飞书会话",
      }
    : {
        infoflowGroup: "Infoflow group",
        infoflowPrivate: "Infoflow chat",
        qqGroup: "QQ group",
        qqChannel: "QQ channel",
        qqPrivate: "QQ chat",
        feishuConversation: "Feishu chat",
      };
}

function channelScopeLabel(
  adapter: string,
  scope: string,
  labels: ChannelSessionLabels,
): string | null {
  switch (adapter) {
    case "infoflow":
      if (scope === "group") return labels.infoflowGroup;
      if (scope === "user") return labels.infoflowPrivate;
      return null;
    case "qqbot":
      if (scope === "group") return labels.qqGroup;
      if (scope === "channel") return labels.qqChannel;
      if (scope === "c2c") return labels.qqPrivate;
      return null;
    case "feishu":
      if (scope === "chat") return labels.feishuConversation;
      return null;
    default:
      return null;
  }
}

/** Opaque openids stay short; human names / short ids stay as-is. */
export function shortenOpaqueChannelId(id: string): string {
  if (/^[0-9A-Fa-f]{16,}$/u.test(id)) {
    return `${id.slice(0, 8)}…`;
  }
  return id;
}
