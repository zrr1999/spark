import {
  channelSessionPresentation,
  type ChannelSessionPresentation,
} from "$lib/channel-session-title";
import { workbenchSessionScope } from "$lib/workbench-session-scope";
import { workspacePath } from "$lib/workspace-routes";
import type {
  SessionRecord,
  SessionsMessages,
  SessionsWorkbenchCopy,
  WorkspaceOption,
} from "./types";

export function workspaceLabel(
  workspaces: WorkspaceOption[],
  workspaceId: string,
  unknownWorkspace: string,
): string {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? unknownWorkspace;
}

export function sessionScopeLabel(
  workspaces: WorkspaceOption[],
  session: SessionRecord,
  unknownWorkspace: string,
): string {
  const scope = workbenchSessionScope(session);
  if (scope.kind === "workspace") {
    return workspaceLabel(workspaces, scope.workspaceId, unknownWorkspace);
  }
  return unknownWorkspace;
}

export function sessionPresentation(
  session: SessionRecord,
  messages: SessionsMessages,
  copy: SessionsWorkbenchCopy,
): ChannelSessionPresentation {
  return channelSessionPresentation(session, {
    labels: messages.channelLabels,
    fallback: copy.newConversation,
  });
}

export function workspaceHref(
  workspaces: WorkspaceOption[],
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  return workspace ? workspacePath(workspace) : null;
}

export function channelsSettingsHref(
  workspaces: WorkspaceOption[],
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  return workspace ? workspacePath(workspace, "/settings/channels") : null;
}
