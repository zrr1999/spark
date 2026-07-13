import type { ModelListItem } from "@cursor/sdk";

/**
 * Reviewed, public Cursor model metadata used when live discovery is unavailable.
 * Runtime availability still depends on the caller's Cursor SDK API key.
 *
 * Keep this list small and canonical: aliases are retained for resolution, but
 * the catalog converter only exposes `item.id` in the picker.
 */
export const FALLBACK_CURSOR_MODEL_ITEMS: ModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer-latest", "composer", "composer-2-5"],
    parameters: [
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        displayName: "Composer 2.5",
        isDefault: true,
        params: [{ id: "fast", value: "true" }],
      },
      {
        displayName: "Composer 2.5",
        params: [{ id: "fast", value: "false" }],
      },
    ],
  },
  {
    id: "grok-4.5",
    displayName: "Cursor Grok 4.5",
    parameters: [
      {
        id: "effort",
        displayName: "Effort",
        values: [
          { value: "low", displayName: "Low" },
          { value: "medium", displayName: "Medium" },
          { value: "high", displayName: "High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        displayName: "Cursor Grok 4.5",
        isDefault: true,
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      },
    ],
  },
  {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    aliases: ["opus-latest", "opus", "opus-4.8", "opus-4-8"],
    parameters: [
      {
        id: "context",
        values: [{ value: "300k" }, { value: "1m" }],
      },
      {
        id: "thinking",
        values: [{ value: "false" }, { value: "true" }],
      },
      {
        id: "effort",
        values: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        displayName: "Opus 4.8",
        isDefault: true,
        params: [
          { id: "thinking", value: "true" },
          { id: "context", value: "1m" },
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
];
