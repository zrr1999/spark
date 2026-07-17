/**
 * Resolve the visible run state for the selected conversation.
 *
 * A submission receipt proves only that a turn was admitted. It may still be
 * waiting for a worker, so it must not make the conversation look active.
 * Prefer the live daemon view over the registry row rendered with the page,
 * and fall back to that registry row only when no live view is available.
 */
export function sessionIsWorking(input: {
  registryStatus?: string | null;
  liveStatus?: string | null;
}): boolean {
  return (input.liveStatus ?? input.registryStatus) === "running";
}
