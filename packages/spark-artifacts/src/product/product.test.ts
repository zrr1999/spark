import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_ARTIFACT_KINDS,
  defaultProductArtifactStore,
  issueBodyFromSnapshot,
  parseForgeUrl,
  prBodyFromSnapshot,
  attachPrWorktree,
  removePrWorktree,
} from "./index.ts";

describe("product artifact kinds", () => {
  it("keeps the public kind surface limited to issue, pr, and preview", () => {
    expect(PRODUCT_ARTIFACT_KINDS).toEqual(["issue", "pr", "preview"]);
  });

  it("stores preview with continuous versioned updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-product-preview-"));
    const store = defaultProductArtifactStore(dir);
    const created = await store.put({
      kind: "preview",
      title: "Landing",
      format: "mdx",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "mdx",
        content: "# Draft",
        version: 1,
        progress: { label: "outline", percent: 10 },
      },
    });
    const updated = await store.update(created.ref, {
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "mdx",
        content: "# Draft\n\n## Section",
        version: 2,
        progress: { label: "sections", percent: 40, stage: "writing" },
      },
    });
    expect(updated.body.kind).toBe("preview");
    if (updated.body.kind !== "preview") throw new Error("expected preview");
    expect(updated.body.version).toBe(2);
    expect(updated.body.progress?.percent).toBe(40);
    const listed = await store.list({ kind: "preview" });
    expect(listed).toHaveLength(1);
  });

  it("parses forge issue and PR URLs", () => {
    expect(parseForgeUrl("https://github.com/acme/app/issues/12")).toEqual({
      forge: "github",
      repo: "acme/app",
      kind: "issue",
      number: 12,
    });
    expect(parseForgeUrl("https://github.com/acme/app/pull/9")).toEqual({
      forge: "github",
      repo: "acme/app",
      kind: "pr",
      number: 9,
    });
    expect(parseForgeUrl("https://gitlab.com/acme/app/-/merge_requests/3")).toEqual({
      forge: "gitlab",
      repo: "acme/app",
      kind: "pr",
      number: 3,
    });
  });

  it("maps forge snapshots into issue/pr bodies", () => {
    const issue = issueBodyFromSnapshot({
      forge: "github",
      repo: "acme/app",
      number: 1,
      url: "https://github.com/acme/app/issues/1",
      state: "open",
      title: "Bug",
      labels: ["bug"],
    });
    expect(issue.kind).toBe("issue");
    expect(issue.syncedAt).toBeTruthy();
    const pr = prBodyFromSnapshot({
      forge: "github",
      repo: "acme/app",
      number: 2,
      url: "https://github.com/acme/app/pull/2",
      state: "open",
      title: "Fix",
      labels: [],
      headRef: "feature",
      baseRef: "main",
      draft: false,
    });
    expect(pr.kind).toBe("pr");
    expect(pr.headRef).toBe("feature");
  });

  it("attaches and removes a PR worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-pr-worktree-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: dir });
    const committed = spawnSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" });
    expect(committed.status).toBe(0);
    spawnSync("git", ["branch", "feature-pr"], { cwd: dir });

    const attached = await attachPrWorktree({
      cwd: dir,
      forge: "github",
      repo: "acme/app",
      number: 42,
      headRef: "feature-pr",
      baseRef: "main",
      runner: async (command, args, cwd) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
        };
      },
    });
    expect(attached.worktreeStatus).toBe("attached");
    expect(attached.worktreePath).toContain(".spark/worktrees/pr-github-acme-app-42");

    const removed = await removePrWorktree({
      cwd: dir,
      worktreePath: attached.worktreePath,
      force: true,
      runner: async (command, args, cwd) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
        };
      },
    });
    expect(removed.worktreeStatus).toBe("removed");
  });

  it("keeps product artifacts out of evidence-only listing expectations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-product-isolation-"));
    await mkdir(join(dir, ".spark", "artifacts"), { recursive: true });
    const store = defaultProductArtifactStore(dir);
    await store.put({
      kind: "preview",
      title: "Only product",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "md",
        content: "hi",
        version: 1,
      },
    });
    const listed = await store.list();
    expect(listed.every((item) => ["issue", "pr", "preview"].includes(item.kind))).toBe(true);
  });
});
