import { getDatabase } from "$lib/server/db";
import { redirectToLatestWorkspace } from "$lib/server/workspace-routing";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => redirectToLatestWorkspace(getDatabase(), "/settings");
