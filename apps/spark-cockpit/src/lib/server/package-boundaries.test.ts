import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const repoRoot = resolve(webRoot, "../..");

const sparkServerAdapters = [
  "agents-product.ts",
  "artifact-cache.ts",
  "command-submission.ts",
  "events.ts",
  "liveness.ts",
  "project-cockpit.ts",
  "projection-services.ts",
  "runtime-registration.ts",
  "runtime-ws.ts",
  "search.ts",
];

describe("package boundaries", () => {
  it("keeps migrated server coordination modules as spark-server adapters", () => {
    for (const adapter of sparkServerAdapters) {
      const source = readFileSync(join(webRoot, "src/lib/server", adapter), "utf8").trim();
      expect(source).toMatch(/^export \* from "@zendev-lab\/spark-server\//u);
    }
  });

  it("keeps SvelteKit page loads behind spark-server query APIs", () => {
    const pageServers = collectSourceFiles(join(webRoot, "src/routes")).filter((file) =>
      file.endsWith("+page.server.ts"),
    );
    const directSql = pageServers.filter((file) =>
      /\.prepare\s*\(/u.test(readFileSync(file, "utf8")),
    );
    expect(directSql).toEqual([]);
  });

  it("keeps Cockpit UI outside lib/server from importing spark-db directly", () => {
    const uiFiles = collectSourceFiles(join(webRoot, "src")).filter(
      (file) => !file.includes("/src/lib/server/"),
    );
    const violations = uiFiles.filter((file) =>
      /from\s+["']@zendev-lab\/spark-db/u.test(readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("keeps Cockpit source from bypassing daemon/protocol workspace artifact access", () => {
    const productionFiles = collectSourceFiles(join(webRoot, "src")).filter(
      (file) => !file.endsWith(".test.ts"),
    );
    const violations = productionFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes('resolveSparkPaths({ app: "daemon" })') ||
        source.includes('".spark", "artifacts"') ||
        source.includes("'.spark', 'artifacts'") ||
        source.includes(".spark/artifacts")
      );
    });
    expect(violations).toEqual([]);
  });

  it("keeps artifact fallback out of daemon/local workspace files", () => {
    const agentsProduct = readFileSync(
      join(repoRoot, "packages/spark-server/src/agents-product.ts"),
      "utf8",
    );
    expect(agentsProduct).not.toContain('resolveSparkPaths({ app: "daemon" })');
    expect(agentsProduct).not.toContain(".spark");
    expect(agentsProduct).not.toMatch(/readFileSync|new DatabaseSync/u);
  });

  it("does not import Spark daemon internals from the cockpit app", () => {
    const sourceFiles = collectSourceFiles(join(webRoot, "src"));
    const violations = sourceFiles.filter((file) =>
      /from\s+["']@zendev-lab\/spark-daemon/u.test(readFileSync(file, "utf8")),
    );

    expect(violations).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(svelte|ts)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
