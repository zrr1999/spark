export interface WorkspaceAvatarSource {
  id?: string;
  slug?: string;
  name?: string | null;
}

const workspaceAvatarPalette = [
  { background: "#E0F2FE", border: "#BAE6FD", ink: "#0369A1" },
  { background: "#DCFCE7", border: "#BBF7D0", ink: "#15803D" },
  { background: "#FEF3C7", border: "#FDE68A", ink: "#A16207" },
  { background: "#EDE9FE", border: "#DDD6FE", ink: "#6D28D9" },
  { background: "#FFE4E6", border: "#FECDD3", ink: "#BE123C" },
  { background: "#CCFBF1", border: "#99F6E4", ink: "#0F766E" },
  { background: "#E0E7FF", border: "#C7D2FE", ink: "#4338CA" },
  { background: "#FED7AA", border: "#FDBA74", ink: "#C2410C" },
] as const;

export function workspaceInitial(workspace: WorkspaceAvatarSource | null | undefined): string {
  const label = (workspace?.name || workspace?.slug || "").trim();
  return Array.from(label)[0]?.toLocaleUpperCase() ?? "?";
}

export function workspaceAvatarStyle(workspace: WorkspaceAvatarSource | null | undefined): string {
  const color = workspaceAvatarPalette[workspaceAvatarColorIndex(workspace)]!;
  return `--avatar-bg: ${color.background}; --avatar-border: ${color.border}; --avatar-ink: ${color.ink};`;
}

export function workspaceAvatarColorIndex(
  workspace: WorkspaceAvatarSource | null | undefined,
): number {
  const value = `${workspace?.id ?? ""}|${workspace?.slug ?? ""}|${workspace?.name ?? ""}`;
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }

  return hash % workspaceAvatarPalette.length;
}
