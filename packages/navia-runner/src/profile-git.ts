import { spawnSync } from "node:child_process";

export interface ProfileGitAccess {
  canRead: boolean;
  canPull: boolean;
  canPush: boolean;
  reason: string | null;
  checkedAt: string;
}

export interface GitCommandResult {
  status: number;
  stdout?: string;
  stderr?: string;
}

export type GitCommandRunner = (args: string[]) => GitCommandResult;

export function detectProfileGitAccess(
  profilePath: string,
  runGit: GitCommandRunner = defaultGitCommandRunner,
  checkedAt = new Date().toISOString(),
): ProfileGitAccess {
  const insideWorkTree = runGit(["-C", profilePath, "rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.status !== 0) {
    return {
      canRead: false,
      canPull: false,
      canPush: false,
      reason: reasonFrom(insideWorkTree, "not a readable git worktree"),
      checkedAt,
    };
  }

  const fetchDryRun = runGit(["-C", profilePath, "fetch", "--dry-run"]);
  const canPull = fetchDryRun.status === 0;
  const pushDryRun = runGit(["-C", profilePath, "push", "--dry-run"]);
  const canPush = pushDryRun.status === 0;

  return {
    canRead: true,
    canPull,
    canPush,
    reason: canPull && canPush ? null : reasonFrom(canPull ? pushDryRun : fetchDryRun, null),
    checkedAt,
  };
}

function defaultGitCommandRunner(args: string[]): GitCommandResult {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function reasonFrom(result: GitCommandResult, fallback: string | null) {
  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}
