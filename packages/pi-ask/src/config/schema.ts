import type { Keymap } from "../state/key-router.ts";

export interface AskBehaviour {
  /** Auto-submit when all questions are answered and no notes are present. */
  autoSubmitWhenAnsweredWithoutNotes: boolean;
  /** Ask for confirmation before dismissing when answers are dirty. */
  confirmDismissWhenDirty: boolean;
  /** Show footer hints at the bottom of the dialog. */
  showFooterHints: boolean;
  /** Present single-select questions as multi-select UI while preserving type in results. */
  presentSingleAsMulti: boolean;
}

export interface AskNotifications {
  /** Whether notifications are enabled. */
  enabled: boolean;
}

export interface AskConfig {
  schemaVersion: number;
  behaviour: AskBehaviour;
  keymaps: Keymap;
  notifications: AskNotifications;
}
