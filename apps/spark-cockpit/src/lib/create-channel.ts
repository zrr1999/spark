export type CreateChannelAdapter = "feishu" | "infoflow" | "qqbot";

export type CreateChannelFormValues = {
  adapter: CreateChannelAdapter;
  scope: string;
  externalId: string;
  title: string;
  feishuAppId: string;
  feishuAppSecret: string;
  infoflowEndpoint: string;
  infoflowAppKey: string;
  infoflowAppAgentId: string;
  infoflowAppSecret: string;
  qqbotAppId: string;
  qqbotClientSecret: string;
  qqbotSandbox: boolean;
};

export type WorkspaceChannelListItem = {
  sessionId: string;
  title: string;
  status: string;
  updatedAt: string;
  bindings: Array<{
    adapter: CreateChannelAdapter;
    externalKey: string;
    boundAt?: string;
  }>;
};

const createChannelScopesByAdapter: Record<CreateChannelAdapter, readonly string[]> = {
  feishu: ["chat"],
  infoflow: ["user", "group"],
  qqbot: ["c2c", "group", "channel"],
};

export function createChannelScopes(adapter: CreateChannelAdapter): readonly string[] {
  return createChannelScopesByAdapter[adapter];
}

export function defaultCreateChannelScope(adapter: CreateChannelAdapter): string {
  return createChannelScopesByAdapter[adapter][0]!;
}

export function isValidCreateChannelScope(adapter: CreateChannelAdapter, scope: string): boolean {
  return createChannelScopesByAdapter[adapter].includes(scope);
}

function isCreateChannelAdapter(value: string): value is CreateChannelAdapter {
  return value === "feishu" || value === "infoflow" || value === "qqbot";
}

export function parseChannelExternalKeyParts(externalKey: string): {
  adapter: CreateChannelAdapter;
  scope: string;
  id: string;
} | null {
  const parts = externalKey.trim().split(":").filter(Boolean);
  if (parts.length < 3) return null;
  const adapter = parts[0];
  if (!isCreateChannelAdapter(adapter)) return null;
  const scope = parts[1]!;
  if (!isValidCreateChannelScope(adapter, scope)) return null;
  const id = parts.slice(2).join(":").trim();
  if (!id) return null;
  return { adapter, scope, id };
}

/** Sessions in this workspace that already have at least one channel binding. */
export function workspaceChannelListFromSessions(
  sessions: Array<{
    sessionId: string;
    title?: string;
    status: string;
    updatedAt: string;
    bindings: Array<{ kind: string; adapter: string; externalKey: string; boundAt?: string }>;
  }>,
): WorkspaceChannelListItem[] {
  return sessions
    .flatMap((session): WorkspaceChannelListItem[] => {
      const bindings: WorkspaceChannelListItem["bindings"] = session.bindings.flatMap((binding) => {
        if (binding.kind !== "channel" || !isCreateChannelAdapter(binding.adapter)) return [];
        return [
          {
            adapter: binding.adapter,
            externalKey: binding.externalKey,
            ...(binding.boundAt ? { boundAt: binding.boundAt } : {}),
          },
        ];
      });
      return bindings.length > 0
        ? [
            {
              sessionId: session.sessionId,
              title: session.title?.trim() || session.sessionId,
              status: session.status,
              updatedAt: session.updatedAt,
              bindings,
            },
          ]
        : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
