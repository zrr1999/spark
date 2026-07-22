import { sparkNativeTuiStrings } from "@zendev-lab/spark-i18n/cli";

export const nativeTuiStrings = sparkNativeTuiStrings();

export const NATIVE_WORKING_SPINNER_FRAMES = [
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
  "⠋",
  "⠙",
  "⠹",
  "⠸",
] as const;
export const NATIVE_WORKING_SPINNER_INTERVAL_MS = 120;
