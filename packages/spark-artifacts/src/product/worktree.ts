import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ForgeHost, PrArtifactBody, WorktreeStatus } from "./types.ts";

export interface AttachPrWorktreeInput {
  cwd: string;
  forge: ForgeHost;
  repo: string;
  number: number;
  headRef: string;
  baseRef?: string;
  /** Optional override for tests. */
  runner?: WorktreeCommandRunner;
}

export interface AttachPrWorktreeResult {
  worktreePath: string;
  worktreeBranch: string;
  worktreeStatus: WorktreeStatus;
  worktreeError?: string;
}

export type WorktreeCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export function prWorktreePath(
  cwd: string,
  forge: ForgeHost,
  repo: string,
  number: number,
): string {
  const safeRepo = repo.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/gu, "_");
  return join(cwd, ".spark", "worktrees", `pr-${forge}-${safeRepo}-${number}`);
}

export async function attachPrWorktree(
  input: AttachPrWorktreeInput,
): Promise<AttachPrWorktreeResult> {
  const run = input.runner ?? defaultRunner;
  const worktreePath = prWorktreePath(input.cwd, input.forge, input.repo, input.number);
  const worktreeBranch = input.headRef;
  await mkdir(join(input.cwd, ".spark", "worktrees"), { recursive: true });

  if (await pathExists(worktreePath)) {
    const head = await run(
      "git",
      ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"],
      input.cwd,
    );
    if (head.code === 0 && head.stdout.trim() === "true") {
      return { worktreePath: resolve(worktreePath), worktreeBranch, worktreeStatus: "attached" };
    }
  }

  const localBranch = await run(
    "git",
    ["rev-parse", "--verify", `refs/heads/${worktreeBranch}`],
    input.cwd,
  );
  if (localBranch.code !== 0) {
    const remoteBranch = await run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${worktreeBranch}`],
      input.cwd,
    );
    if (remoteBranch.code === 0) {
      const tracked = await run(
        "git",
        ["branch", "--track", worktreeBranch, `origin/${worktreeBranch}`],
        input.cwd,
      );
      if (tracked.code !== 0) {
        return {
          worktreePath,
          worktreeBranch,
          worktreeStatus: "failed",
          worktreeError: tracked.stderr || tracked.stdout || "unable to track remote PR branch",
        };
      }
    } else {
      const fetchArgs =
        input.forge === "github"
          ? ["fetch", "origin", `pull/${input.number}/head:${worktreeBranch}`]
          : ["fetch", "origin", `merge-requests/${input.number}/head:${worktreeBranch}`];
      const fetched = await run("git", fetchArgs, input.cwd);
      if (fetched.code !== 0) {
        const base = input.baseRef ?? "HEAD";
        const created = await run("git", ["branch", worktreeBranch, base], input.cwd);
        if (created.code !== 0) {
          return {
            worktreePath,
            worktreeBranch,
            worktreeStatus: "failed",
            worktreeError:
              fetched.stderr ||
              created.stderr ||
              `unable to resolve PR head branch ${worktreeBranch}`,
          };
        }
      }
    }
  }

  const added = await run("git", ["worktree", "add", worktreePath, worktreeBranch], input.cwd);
  if (added.code !== 0) {
    return {
      worktreePath,
      worktreeBranch,
      worktreeStatus: "failed",
      worktreeError: added.stderr || added.stdout || `git worktree add failed`,
    };
  }
  return { worktreePath: resolve(worktreePath), worktreeBranch, worktreeStatus: "attached" };
}

export async function removePrWorktree(input: {
  cwd: string;
  worktreePath: string;
  force?: boolean;
  runner?: WorktreeCommandRunner;
}): Promise<{ worktreeStatus: WorktreeStatus; worktreeError?: string }> {
  const run = input.runner ?? defaultRunner;
  if (!(await pathExists(input.worktreePath))) {
    return { worktreeStatus: "removed" };
  }
  const args = ["worktree", "remove", input.worktreePath];
  if (input.force) args.push("--force");
  const removed = await run("git", args, input.cwd);
  if (removed.code !== 0) {
    return {
      worktreeStatus: "failed",
      worktreeError: removed.stderr || removed.stdout || "git worktree remove failed",
    };
  }
  return { worktreeStatus: "removed" };
}

export function applyWorktreeToPrBody(
  body: PrArtifactBody,
  result: AttachPrWorktreeResult,
): PrArtifactBody {
  return {
    ...body,
    worktreePath: result.worktreePath,
    worktreeBranch: result.worktreeBranch,
    worktreeStatus: result.worktreeStatus,
    worktreeError: result.worktreeError,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultRunner(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolvePromise({ stdout, stderr: error.message, code: 127 });
    });
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}
