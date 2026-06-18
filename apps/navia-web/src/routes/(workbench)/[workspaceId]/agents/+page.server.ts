import { createId } from "@navia-dev/protocol";
import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

type AgentSource = "builtin" | "workspace" | "imported";
const agentSources = new Set<AgentSource>(["builtin", "workspace", "imported"]);

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

  const agentSpecs = db
    .prepare(
      `SELECT id,
              name,
              source,
              status,
              description,
              config_json AS configJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM agent_specs
       WHERE workspace_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
                updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    name: string;
    source: string;
    status: string;
    description: string | null;
    configJson: string;
    createdAt: string;
    updatedAt: string;
  }>;

  const counts = agentSpecs.reduce(
    (acc, agent) => {
      acc.total += 1;
      if (agent.status === "active") acc.active += 1;
      if (agent.status === "disabled") acc.disabled += 1;
      if (agent.status === "archived") acc.archived += 1;
      return acc;
    },
    { total: 0, active: 0, disabled: 0, archived: 0 },
  );

  return { workspace, agentSpecs, counts };
};

export const actions: Actions = {
  createAgentSpec: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).agents.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

    const formData = await request.formData();
    const name = formText(formData, "name").trim();
    const source = formText(formData, "source", "workspace") as AgentSource;
    const description = formText(formData, "description").trim() || null;
    const roleRef = formText(formData, "roleRef").trim();
    const instructions = formText(formData, "instructions").trim();

    if (!name) {
      return fail(400, { message: t.nameRequired });
    }
    if (!agentSources.has(source)) {
      return fail(400, { message: t.unsupportedSource });
    }

    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO agent_specs
          (id, workspace_id, name, source, status, description, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        createId("agent"),
        workspace.id,
        name,
        source,
        description,
        JSON.stringify({ roleRef: roleRef || undefined, instructions: instructions || undefined }),
        now,
        now,
      );
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.createFailed,
      });
    }

    redirect(303, workspacePath(workspace, "/agents"));
  },

  setAgentStatus: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).agents.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const formData = await request.formData();
    const agentSpecId = formText(formData, "agentSpecId");
    const status = formText(formData, "status");
    if (!agentSpecId || !["active", "disabled", "archived"].includes(status)) {
      return fail(400, { message: t.invalidStatus });
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE agent_specs SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).run(status, now, agentSpecId, workspace.id);

    redirect(303, workspacePath(workspace, "/agents"));
  },
};
