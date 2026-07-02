import { loadWorkbenchLayout } from "@zendev-lab/spark-server/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ url }) => loadWorkbenchLayout(getDatabase(), url.pathname);
