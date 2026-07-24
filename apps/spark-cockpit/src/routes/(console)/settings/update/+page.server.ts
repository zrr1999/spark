import { readCockpitUpdateProjection } from "$lib/server/update-projection";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => ({
  update: await readCockpitUpdateProjection(),
});
