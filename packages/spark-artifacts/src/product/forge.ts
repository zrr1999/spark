import { spawn } from "node:child_process";
import type { ForgeHost, IssueArtifactBody, PrArtifactBody } from "./types.ts";

export interface ForgeIssueSnapshot {
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels: string[];
  bodyText?: string;
}

export interface ForgePrSnapshot extends ForgeIssueSnapshot {
  headRef: string;
  baseRef: string;
  draft: boolean;
  checksSummary?: string;
  diffSummary?: string;
}

export interface ForgeSyncOptions {
  cwd: string;
  forge?: ForgeHost;
  repo?: string;
  number: number;
  /** Optional override for tests. */
  runner?: CommandRunner;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export async function syncForgeIssue(options: ForgeSyncOptions): Promise<ForgeIssueSnapshot> {
  const forge = options.forge ?? (await detectForge(options.cwd, options.runner));
  if (forge === "github") return syncGitHubIssue(options);
  return syncGitLabIssue(options);
}

export async function syncForgePr(options: ForgeSyncOptions): Promise<ForgePrSnapshot> {
  const forge = options.forge ?? (await detectForge(options.cwd, options.runner));
  if (forge === "github") return syncGitHubPr(options);
  return syncGitLabPr(options);
}

export function issueBodyFromSnapshot(snapshot: ForgeIssueSnapshot): IssueArtifactBody {
  return {
    schemaVersion: 1,
    kind: "issue",
    forge: snapshot.forge,
    repo: snapshot.repo,
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    title: snapshot.title,
    labels: snapshot.labels,
    bodyText: snapshot.bodyText,
    syncedAt: new Date().toISOString(),
  };
}

export function prBodyFromSnapshot(snapshot: ForgePrSnapshot): PrArtifactBody {
  return {
    schemaVersion: 1,
    kind: "pr",
    forge: snapshot.forge,
    repo: snapshot.repo,
    number: snapshot.number,
    url: snapshot.url,
    state: snapshot.state,
    title: snapshot.title,
    labels: snapshot.labels,
    bodyText: snapshot.bodyText,
    headRef: snapshot.headRef,
    baseRef: snapshot.baseRef,
    draft: snapshot.draft,
    checksSummary: snapshot.checksSummary,
    diffSummary: snapshot.diffSummary,
    syncedAt: new Date().toISOString(),
  };
}

export function parseForgeUrl(
  value: string,
): { forge: ForgeHost; repo: string; number: number; kind: "issue" | "pr" } | undefined {
  const trimmed = value.trim();
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/iu.exec(
    trimmed,
  );
  if (github) {
    return {
      forge: "github",
      repo: `${github[1]}/${github[2]}`,
      kind: github[3] === "pull" ? "pr" : "issue",
      number: Number(github[4]),
    };
  }
  const gitlab =
    /^https?:\/\/(?:www\.)?gitlab\.com\/(.+?)\/-\/(issues|merge_requests)\/(\d+)(?:\/|$)/iu.exec(
      trimmed,
    );
  if (gitlab) {
    return {
      forge: "gitlab",
      repo: gitlab[1]!,
      kind: gitlab[2] === "merge_requests" ? "pr" : "issue",
      number: Number(gitlab[3]),
    };
  }
  return undefined;
}

async function detectForge(cwd: string, runner?: CommandRunner): Promise<ForgeHost> {
  const run = runner ?? defaultRunner;
  const remote = await run("git", ["remote", "get-url", "origin"], cwd);
  const url = `${remote.stdout}\n${remote.stderr}`.toLowerCase();
  if (url.includes("gitlab")) return "gitlab";
  return "github";
}

async function syncGitHubIssue(options: ForgeSyncOptions): Promise<ForgeIssueSnapshot> {
  const run = options.runner ?? defaultRunner;
  const repo = options.repo ?? (await githubRepo(options.cwd, run));
  const result = await run(
    "gh",
    [
      "issue",
      "view",
      String(options.number),
      "--repo",
      repo,
      "--json",
      "number,title,state,url,body,labels",
    ],
    options.cwd,
  );
  if (result.code !== 0) {
    throw new Error(
      `gh issue view failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const raw = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    state: string;
    url: string;
    body?: string;
    labels?: Array<{ name: string }>;
  };
  return {
    forge: "github",
    repo,
    number: raw.number,
    url: raw.url,
    state: String(raw.state).toLowerCase(),
    title: raw.title,
    labels: (raw.labels ?? []).map((label) => label.name),
    bodyText: raw.body,
  };
}

async function syncGitHubPr(options: ForgeSyncOptions): Promise<ForgePrSnapshot> {
  const run = options.runner ?? defaultRunner;
  const repo = options.repo ?? (await githubRepo(options.cwd, run));
  const result = await run(
    "gh",
    [
      "pr",
      "view",
      String(options.number),
      "--repo",
      repo,
      "--json",
      "number,title,state,url,body,labels,headRefName,baseRefName,isDraft,statusCheckRollup",
    ],
    options.cwd,
  );
  if (result.code !== 0) {
    throw new Error(
      `gh pr view failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const raw = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    state: string;
    url: string;
    body?: string;
    labels?: Array<{ name: string }>;
    headRefName: string;
    baseRefName: string;
    isDraft?: boolean;
    statusCheckRollup?: Array<{ state?: string; name?: string }>;
  };
  const checks = raw.statusCheckRollup ?? [];
  const checksSummary =
    checks.length === 0
      ? undefined
      : checks.map((check) => `${check.name ?? "check"}=${check.state ?? "unknown"}`).join(", ");
  let diffSummary: string | undefined;
  const diff = await run("gh", ["pr", "diff", String(options.number), "--repo", repo], options.cwd);
  if (diff.code === 0 && diff.stdout.trim()) {
    const lines = diff.stdout.split("\n");
    diffSummary = lines.slice(0, 80).join("\n");
    if (lines.length > 80) diffSummary += `\n… truncated ${lines.length - 80} line(s)`;
  }
  return {
    forge: "github",
    repo,
    number: raw.number,
    url: raw.url,
    state: String(raw.state).toLowerCase(),
    title: raw.title,
    labels: (raw.labels ?? []).map((label) => label.name),
    bodyText: raw.body,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    draft: Boolean(raw.isDraft),
    checksSummary,
    diffSummary,
  };
}

async function syncGitLabIssue(options: ForgeSyncOptions): Promise<ForgeIssueSnapshot> {
  const run = options.runner ?? defaultRunner;
  const repo = options.repo ?? (await gitlabRepo(options.cwd, run));
  const result = await run(
    "glab",
    ["issue", "view", String(options.number), "--repo", repo, "-F", "json"],
    options.cwd,
  );
  if (result.code !== 0) {
    throw new Error(
      `glab issue view failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const raw = JSON.parse(result.stdout) as {
    iid?: number;
    id?: number;
    title: string;
    state: string;
    web_url?: string;
    description?: string;
    labels?: string[];
  };
  const number = raw.iid ?? raw.id ?? options.number;
  return {
    forge: "gitlab",
    repo,
    number,
    url: raw.web_url ?? `https://gitlab.com/${repo}/-/issues/${number}`,
    state: String(raw.state).toLowerCase(),
    title: raw.title,
    labels: raw.labels ?? [],
    bodyText: raw.description,
  };
}

async function syncGitLabPr(options: ForgeSyncOptions): Promise<ForgePrSnapshot> {
  const run = options.runner ?? defaultRunner;
  const repo = options.repo ?? (await gitlabRepo(options.cwd, run));
  const result = await run(
    "glab",
    ["mr", "view", String(options.number), "--repo", repo, "-F", "json"],
    options.cwd,
  );
  if (result.code !== 0) {
    throw new Error(
      `glab mr view failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const raw = JSON.parse(result.stdout) as {
    iid?: number;
    id?: number;
    title: string;
    state: string;
    web_url?: string;
    description?: string;
    labels?: string[];
    source_branch?: string;
    target_branch?: string;
    draft?: boolean;
  };
  const number = raw.iid ?? raw.id ?? options.number;
  return {
    forge: "gitlab",
    repo,
    number,
    url: raw.web_url ?? `https://gitlab.com/${repo}/-/merge_requests/${number}`,
    state: String(raw.state).toLowerCase(),
    title: raw.title,
    labels: raw.labels ?? [],
    bodyText: raw.description,
    headRef: raw.source_branch ?? "HEAD",
    baseRef: raw.target_branch ?? "main",
    draft: Boolean(raw.draft),
  };
}

async function githubRepo(cwd: string, run: CommandRunner): Promise<string> {
  const result = await run("gh", ["repo", "view", "--json", "nameWithOwner"], cwd);
  if (result.code !== 0) {
    throw new Error(
      `gh repo view failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const raw = JSON.parse(result.stdout) as { nameWithOwner: string };
  return raw.nameWithOwner;
}

async function gitlabRepo(cwd: string, run: CommandRunner): Promise<string> {
  const remote = await run("git", ["remote", "get-url", "origin"], cwd);
  if (remote.code !== 0) {
    throw new Error(`git remote get-url origin failed: ${remote.stderr || remote.stdout}`);
  }
  const url = remote.stdout.trim();
  const https = /gitlab\.com[:/](.+?)(?:\.git)?$/iu.exec(url);
  if (https?.[1]) return https[1].replace(/\.git$/u, "");
  throw new Error(`unable to parse GitLab repo from origin: ${url}`);
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
