/** Turn stored `channel <adapter>:<scope>:<id>` titles into sidebar-friendly labels. */

const CHANNEL_TITLE_RE = /^channel\s+(infoflow|qqbot|feishu):(group|user|c2c|channel|chat):(.+)$/iu;

export function sessionHasChannelBinding(session: {
  bindings?: Array<{ kind?: string }> | null;
  title?: string | null;
}): boolean {
  if (session.bindings?.some((binding) => binding.kind === "channel")) return true;
  return CHANNEL_TITLE_RE.test(session.title?.trim() ?? "");
}

export function formatChannelSessionTitle(
  title: string | undefined | null,
  options: { locale?: string; fallback: string },
): string {
  const raw = title?.trim() || options.fallback;
  const match = raw.match(CHANNEL_TITLE_RE);
  if (!match) return raw;

  const adapter = match[1]!.toLowerCase();
  const scope = match[2]!.toLowerCase();
  const id = match[3]!.trim();
  const zh = (options.locale ?? "").toLowerCase().startsWith("zh");
  const scopeLabel = channelScopeLabel(adapter, scope, zh);
  if (!scopeLabel) return raw;
  return `${scopeLabel} · ${shortenOpaqueChannelId(id)}`;
}

function channelScopeLabel(adapter: string, scope: string, zh: boolean): string | null {
  switch (adapter) {
    case "infoflow":
      if (scope === "group") return zh ? "如流群聊" : "Infoflow group";
      if (scope === "user") return zh ? "如流私聊" : "Infoflow chat";
      return null;
    case "qqbot":
      if (scope === "group") return zh ? "QQ 群聊" : "QQ group";
      if (scope === "channel") return zh ? "QQ 频道" : "QQ channel";
      if (scope === "c2c") return zh ? "QQ 私聊" : "QQ chat";
      return null;
    case "feishu":
      if (scope === "chat") return zh ? "飞书会话" : "Feishu chat";
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
