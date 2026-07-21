import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readAppFile(path: string) {
  return readFileSync(resolve(appRoot, path), "utf8");
}

describe("remote PWA assets", () => {
  it("ships an installable Cockpit manifest with maskable icons", () => {
    const manifest = JSON.parse(readAppFile("static/manifest.webmanifest")) as {
      name?: string;
      display?: string;
      start_url?: string;
      icons?: Array<{ src: string; purpose?: string }>;
    };

    expect(manifest).toMatchObject({
      name: "Spark Cockpit",
      display: "standalone",
      start_url: "/",
    });
    expect(manifest.icons?.some((icon) => icon.src === "/icons/spark.svg")).toBe(true);
    expect(manifest.icons?.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  it("links PWA metadata and ships a notification-capable service worker", () => {
    const layout = readAppFile("src/routes/+layout.svelte");
    const serviceWorker = readAppFile("static/service-worker.js");
    expect(layout).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(layout).toContain('name="theme-color"');
    expect(layout).toContain('rel="apple-touch-icon"');
    expect(serviceWorker).toContain('addEventListener("push"');
    expect(serviceWorker).toContain("showNotification");
    expect(serviceWorker).toContain("notificationclick");
  });

  it("keeps approval and conversation detail surfaces responsive on phone-width viewports", () => {
    const inboxDetail = readAppFile(
      "src/routes/(workbench)/[workspaceId]/inbox/[inboxItemId]/+page.svelte",
    );
    const askQuestionField = readAppFile("src/lib/AskQuestionField.svelte");
    const conversationDetail = [
      readAppFile("src/lib/SessionsWorkspace.svelte"),
      readAppFile("src/lib/sessions-workspace/SessionStageHeader.svelte"),
      readAppFile("src/lib/sessions-workspace/SessionConversationPane.svelte"),
    ].join("\n");
    const workbenchLayout = readAppFile("src/routes/(workbench)/+layout.svelte");
    const cockpitTopbar = readAppFile("src/lib/shell/CockpitTopbar.svelte");

    expect(inboxDetail).toContain("@media (max-width: 640px)");
    expect(inboxDetail).toContain("<AskQuestionField");
    expect(askQuestionField).toContain(".question-block");
    expect(inboxDetail).toContain("flex-direction: column");
    expect(conversationDetail).toContain(".mobile-details");
    expect(conversationDetail).toMatch(/@media \(max-width: (640|960)px\)/);
    expect(workbenchLayout).toContain("@media (max-width: 900px)");
    expect(cockpitTopbar).toContain("@media (max-width: 560px)");
  });
});
