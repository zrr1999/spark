import { redirect, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  redirect(303, "/");
};

export const actions: Actions = {
  default: async () => {
    redirect(303, "/");
  },
};
