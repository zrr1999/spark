import { json } from "@sveltejs/kit";

export function errorJson(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
  requestId?: string,
) {
  return json({ error: { code, message, details, requestId } }, { status });
}
