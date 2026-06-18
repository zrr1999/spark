import { json } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { searchProjects } from "$lib/server/search";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  const activeWorkspaceId = url.searchParams.get("workspaceId");
  const requestedLimit = Number(url.searchParams.get("limit") ?? 8);

  return json({
    results: searchProjects(getDatabase(), query, {
      activeWorkspaceId,
      limit: requestedLimit,
    }),
  });
};
