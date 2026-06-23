import { existsSync } from "node:fs";

const fixedGitCandidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
const fixedLaunchctl = "/bin/launchctl";

export function gitCommand(): string {
  const configured = process.env.SPARK_GIT_COMMAND;
  if (configured?.startsWith("/") && existsSync(configured)) {
    return configured;
  }

  for (const candidate of fixedGitCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Spark requires git at a fixed absolute path or SPARK_GIT_COMMAND.");
}

export function launchctlCommand(): string {
  if (existsSync(fixedLaunchctl)) {
    return fixedLaunchctl;
  }

  throw new Error("launchctl was not found at /bin/launchctl.");
}
