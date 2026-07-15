import { workbenchSessionScope } from "../workbench-session-scope";
import { formatChannelSessionTitle, type ChannelSessionLabels } from "../channel-session-title";

export interface CockpitSearchSession {
  sessionId: string;
  workspaceId?: string;
  scope?:
    | { kind: "workspace"; workspaceId: string }
    | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
  title?: string;
  status: string;
  activityStatus?: string;
}

export interface CockpitSearchWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface CockpitSearchResult {
  id: string;
  type: "session" | "workspace" | "page";
  title: string;
  description: string | null;
  status?: string;
  href: string;
}

export function buildCockpitSearchResults(input: {
  query: string;
  sessions: CockpitSearchSession[];
  workspaces: CockpitSearchWorkspace[];
  untitledConversationLabel: string;
  channelLabels: ChannelSessionLabels;
  statusLabels: Record<string, string>;
  pages?: CockpitSearchResult[];
}): CockpitSearchResult[] {
  const query = input.query.trim().toLowerCase();
  if (!query) return input.pages?.slice(0, 8) ?? [];

  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const sessionResults = input.sessions
    .filter((session) => {
      const scope = workbenchSessionScope(session);
      // Cockpit search is workspace-scoped. Daemon-scoped conversations are
      // owned by the session tool / TUI and are not surfaced here.
      if (scope.kind !== "workspace") return false;
      const workspace = workspaceById.get(scope.workspaceId);
      return [session.sessionId, session.title ?? "", workspace?.name ?? "", workspace?.slug ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 6)
    .map((session): CockpitSearchResult => {
      const scope = workbenchSessionScope(session);
      const workspace =
        scope.kind === "workspace" ? workspaceById.get(scope.workspaceId) : undefined;
      const activityStatus = session.activityStatus ?? session.status;
      return {
        id: session.sessionId,
        type: "session",
        title: formatChannelSessionTitle(session.title, {
          labels: input.channelLabels,
          fallback: input.untitledConversationLabel,
        }),
        description: workspace ? workspace.name : null,
        status: activityStatus,
        href: `/sessions/${session.sessionId}`,
      };
    });

  const workspaceResults = input.workspaces
    .filter((workspace) =>
      [workspace.name, workspace.slug].join("\n").toLowerCase().includes(query),
    )
    .slice(0, Math.max(0, 8 - sessionResults.length))
    .map(
      (workspace): CockpitSearchResult => ({
        id: workspace.id,
        type: "workspace",
        title: workspace.name,
        description: `/${workspace.slug}`,
        href: `/${workspace.slug}`,
      }),
    );

  const pageResults = (input.pages ?? [])
    .filter((page) => `${page.title}\n${page.description ?? ""}`.toLowerCase().includes(query))
    .slice(0, Math.max(0, 10 - sessionResults.length - workspaceResults.length));

  return [...sessionResults, ...workspaceResults, ...pageResults];
}
