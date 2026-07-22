/** Read a human-readable message from a SvelteKit action result. */
export function resultMessage(result: unknown, fallback: string): string {
  if (!result || typeof result !== "object") return fallback;

  if ("data" in result && result.data && typeof result.data === "object") {
    const candidate = (result.data as { message?: unknown }).message;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  if ("error" in result && result.error instanceof Error && result.error.message) {
    return result.error.message;
  }
  return fallback;
}

/** Read the selected model value returned by a successful model-select action. */
export function resultModel(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("data" in result)) return null;
  const data = result.data;
  if (!data || typeof data !== "object" || !("model" in data)) return null;
  return typeof data.model === "string" && data.model.trim() ? data.model : null;
}

/** Read invocationStatus from a cancel/dequeue action result payload. */
export function invocationStatusFromActionResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const data =
    "data" in result && result.data && typeof result.data === "object" ? result.data : result;
  if (!data || typeof data !== "object" || !("invocationStatus" in data)) return null;
  const value = data.invocationStatus;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
