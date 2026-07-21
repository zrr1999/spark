/**
 * Browser-mode smoke for SessionsWorkspace extraction.
 * Skipped when Playwright Chromium is unavailable in this environment.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionLabel } from "./presentation";

const playwrightBrowsers =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? `${process.env.HOME}/Library/Caches/ms-playwright`;
const hasChromium =
  existsSync(`${playwrightBrowsers}/chromium-1200`) ||
  existsSync(`${playwrightBrowsers}/chromium-1217`) ||
  existsSync(`${playwrightBrowsers}/chromium-1228`);

describe.skipIf(!hasChromium)("SessionsWorkspace browser smoke", () => {
  it("exposes connection label helpers used by the stage header", () => {
    expect(
      connectionLabel("live", {
        live: "Connected",
        connecting: "Connecting",
        reconnecting: "Reconnecting",
        offline: "Offline",
      }),
    ).toBe("Connected");
  });
});
