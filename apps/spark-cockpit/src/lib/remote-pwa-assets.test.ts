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

  it("keeps approval and task review surfaces responsive on phone-width viewports", () => {
    const inboxDetail = readAppFile(
      "src/routes/(workbench)/[workspaceId]/inbox/[inboxItemId]/+page.svelte",
    );
    const projectDetail = readAppFile(
      "src/routes/(workbench)/[workspaceId]/projects/[projectId]/+page.svelte",
    );
    const workbenchLayout = readAppFile("src/routes/(workbench)/+layout.svelte");

    expect(inboxDetail).toContain("@media (max-width: 640px)");
    expect(inboxDetail).toContain(".approval-card");
    expect(inboxDetail).toContain("grid-template-columns: 1fr");
    expect(projectDetail).toMatch(/@media \(max-width: (700|1023)px\)/);
    expect(workbenchLayout).toMatch(/@media \(max-width: (700|1023)px\)/);
  });
});
