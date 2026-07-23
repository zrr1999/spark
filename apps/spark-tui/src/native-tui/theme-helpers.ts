/** Theme / key helpers for the native TUI editor chrome. */

import type { OverlayOptions, SelectListTheme } from "../tui/pi-tui-adapter.ts";
import {
  BUILTIN_SPARK_THEMES,
  createSparkHostRenderTheme,
  type SparkTheme,
} from "../host/theme.ts";

export const DEFAULT_NATIVE_THEME = BUILTIN_SPARK_THEMES.find((theme) => theme.id === "dark")!;
export const SPARK_APP_KEYS = new Set([
  "shift+tab",
  "ctrl+k",
  "shift+ctrl+k",
  "ctrl+l",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+o",
  "ctrl+t",
]);
export function createEditorTheme(theme: SparkTheme) {
  const renderTheme = createSparkHostRenderTheme(theme);
  const editorSelectListTheme: SelectListTheme = {
    selectedPrefix: (text) => renderTheme.fg("accent", text),
    selectedText: (text) => renderTheme.fg("foreground", text),
    description: (text) => renderTheme.fg("muted", text),
    scrollInfo: (text) => renderTheme.fg("muted", text),
    noMatch: (text) => renderTheme.fg("warning", text),
  };
  return {
    borderColor: (text: string) => renderTheme.fg("border", text),
    selectList: editorSelectListTheme,
  };
}

export function isSparkAppKey(key: string): boolean {
  return SPARK_APP_KEYS.has(key);
}

export function isOverlayRequest(value: unknown): value is {
  overlay?: boolean;
  overlayOptions?: OverlayOptions;
} {
  return typeof value === "object" && value !== null;
}
