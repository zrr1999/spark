import { json } from "@sveltejs/kit";
import { readCockpitUpdateProjection } from "$lib/server/update-projection";

export async function GET(): Promise<Response> {
  return json(await readCockpitUpdateProjection(), {
    headers: { "cache-control": "no-store" },
  });
}
