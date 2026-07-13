/** Read the daemon-confirmed turn id from a successful SvelteKit action result. */
export function cancelledTurnIdFromActionResult(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  const value = result.data.cancelledTurnId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
