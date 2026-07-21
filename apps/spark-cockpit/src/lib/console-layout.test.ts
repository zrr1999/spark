import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const layoutServer = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/+layout.server.ts",
);

describe("console layout load", () => {
  it("skips remote session listing so settings pages stay local-fast", () => {
    const source = readFileSync(layoutServer, "utf8");
    expect(source).toContain("isGlobalConsolePath");
    expect(source).toContain("sessions: []");
    expect(source).not.toContain("listManagedSessionsForCockpit");
  });
});
