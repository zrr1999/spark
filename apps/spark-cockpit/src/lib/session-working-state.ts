/**
 * Resolve the visible run state for the selected conversation.
 *
 * A live session view is newer than the registry row rendered with the page,
 * so its terminal state must win while the next server refresh is still in
 * flight. When no live view is available, the registry remains the fallback.
 */
export function sessionIsWorking(input: {
  registryStatus?: string | null;
  liveStatus?: string | null;
}): boolean {
  return (input.liveStatus ?? input.registryStatus) === "running";
}
