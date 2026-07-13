import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ url }) => {
  const workspace = url.searchParams.get("workspace");
  redirect(
    307,
    workspace ? `/settings/models?workspace=${encodeURIComponent(workspace)}` : "/settings/models",
  );
};
