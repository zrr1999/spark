import {
  channelSessionPresentation,
  channelSessionScopeKind,
  sessionHasChannelBinding,
  type ChannelSessionLabels,
} from "./channel-session-title";
import {
  orderWorkbenchSessionsByAttention,
  type WorkbenchSessionOrderLike,
} from "./workbench-session-order";
import { workbenchSessionScope, type WorkbenchSessionScopeLike } from "./workbench-session-scope";

export type WorkbenchSessionType =
  | "workspace"
  | "daemon"
  | "private"
  | "group"
  | "channel"
  | "conversation";

export type WorkbenchSessionGroupLike = WorkbenchSessionOrderLike &
  WorkbenchSessionScopeLike & {
    title?: string | null;
    bindings?: Array<{
      kind?: string;
      adapter?: string;
      externalKey?: string;
    }> | null;
  };

export type WorkbenchSessionGroup<T extends WorkbenchSessionGroupLike> = {
  key: WorkbenchSessionType;
  label: string;
  sessions: T[];
};

export const workbenchSessionTypeOrder: readonly WorkbenchSessionType[] = [
  "workspace",
  "private",
  "group",
  "channel",
  "conversation",
  "daemon",
];

export function workbenchSessionType(
  session: WorkbenchSessionGroupLike,
  options: { channelLabels: ChannelSessionLabels; fallback: string },
): WorkbenchSessionType | null {
  const presentation = channelSessionPresentation(session, {
    labels: options.channelLabels,
    fallback: options.fallback,
  });
  if (presentation.channel) {
    return channelSessionScopeKind(presentation.channel.adapter, presentation.channel.scope);
  }
  if (sessionHasChannelBinding(session)) return "conversation";
  const scope = workbenchSessionScope(session);
  if (scope.kind === "daemon") return "daemon";
  return scope.kind === "workspace" ? "workspace" : null;
}

export function groupWorkbenchSessionsByType<T extends WorkbenchSessionGroupLike>(
  sessions: readonly T[],
  options: {
    channelLabels: ChannelSessionLabels;
    fallback: string;
    labels: Record<WorkbenchSessionType, string>;
  },
): WorkbenchSessionGroup<T>[] {
  const groups = new Map<WorkbenchSessionType, T[]>();
  for (const session of sessions) {
    const type = workbenchSessionType(session, options);
    if (type === null) continue;
    const group = groups.get(type);
    if (group) group.push(session);
    else groups.set(type, [session]);
  }

  return workbenchSessionTypeOrder.flatMap((key) => {
    const groupSessions = groups.get(key);
    return groupSessions
      ? [
          {
            key,
            label: options.labels[key],
            sessions: orderWorkbenchSessionsByAttention(groupSessions),
          },
        ]
      : [];
  });
}
