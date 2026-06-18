import { describe, expect, it } from "vitest";
import { detectProfileGitAccess, type GitCommandRunner } from "./profile-git.js";

describe("profile git access", () => {
  it("reports no access when the profile path is not a readable git worktree", () => {
    const runGit: GitCommandRunner = () => ({
      status: 128,
      stderr: "not a git repository",
    });

    expect(detectProfileGitAccess("/profile", runGit, "2026-05-22T00:00:00.000Z")).toEqual({
      canRead: false,
      canPull: false,
      canPush: false,
      reason: "not a git repository",
      checkedAt: "2026-05-22T00:00:00.000Z",
    });
  });

  it("distinguishes read, pull, and push permissions", () => {
    const runGit: GitCommandRunner = (args: string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "rev-parse --is-inside-work-tree") {
        return { status: 0, stdout: "true\n" };
      }
      if (command === "fetch --dry-run") {
        return { status: 0 };
      }
      if (command === "push --dry-run") {
        return { status: 1, stderr: "permission denied" };
      }
      return { status: 1, stderr: `unexpected command: ${command}` };
    };

    expect(detectProfileGitAccess("/profile", runGit, "2026-05-22T00:00:00.000Z")).toEqual({
      canRead: true,
      canPull: true,
      canPush: false,
      reason: "permission denied",
      checkedAt: "2026-05-22T00:00:00.000Z",
    });
  });
});
