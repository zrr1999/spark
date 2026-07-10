import type { ModelListItem } from "@cursor/sdk";

/**
 * Reviewed, public Cursor model metadata used when live discovery is unavailable.
 * Runtime availability still depends on the caller's Cursor SDK API key.
 */
export const FALLBACK_CURSOR_MODEL_ITEMS: ModelListItem[] = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    aliases: ["composer-2-5"],
    parameters: [
      {
        id: "context",
        values: [{ value: "272k" }, { value: "1m" }],
      },
      {
        id: "reasoning",
        values: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }],
      },
      {
        id: "effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
      {
        id: "fast",
        values: [{ value: "false" }, { value: "true" }],
      },
    ],
    variants: [
      {
        displayName: "Composer 2.5",
        isDefault: true,
        params: [
          { id: "context", value: "272k" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    parameters: [
      {
        id: "context",
        values: [{ value: "300k" }],
      },
      {
        id: "thinking",
        values: [{ value: "false" }, { value: "true" }],
      },
      {
        id: "effort",
        values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
      },
    ],
    variants: [
      {
        displayName: "Claude Opus 4.8",
        isDefault: true,
        params: [{ id: "context", value: "300k" }],
      },
    ],
  },
];
