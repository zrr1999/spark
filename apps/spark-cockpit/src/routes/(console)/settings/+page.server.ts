import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  const workspace = url.searchParams.get("workspace");
  // With a workspace hint, land on workspace-scoped daemon settings (models).
  // Without one, land on the control-plane settings hub (browser access).
  redirect(
    307,
    workspace ? `/settings/models?workspace=${encodeURIComponent(workspace)}` : "/settings/access",
  );
};
