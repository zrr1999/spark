/**
 * Detect outdated `cued` daemons from the spark-cue extension.
 *
 * spark-cue itself does not have an authoritative "expected" cued version —
 * it is shipped independently and may be installed against many cue-shell
 * releases over its lifetime. So instead of comparing against spark-cue's own
 * `package.json` version, we ask the upstream release channel:
 *
 *   GET https://api.github.com/repos/zrr1999/cue-shell/releases/latest
 *
 * That mirrors `cued upgrade`'s own self-update source of truth (see
 * `crates/cue-daemon/src/upgrade.rs`).
 *
 * Flow on the very first connection of each Node process:
 *
 * 1. Issue `Ping` and read the `version` field from `Pong`.
 *    - Pre-version-reporting daemons reply with `Pong: {}`, surfaced as
 *      `null` and treated as "outdated, version unknown".
 * 2. In the background, fetch the latest release tag from GitHub
 *    (cached in `~/.cache/spark-cue/cued-version.json`, TTL 6h).
 * 3. Compare. Warn at most once per process when:
 *    - daemon hides its version, OR
 *    - daemon reports a version older than the latest release.
 * 4. Notify via `ctx.ui.notify(..., "warning")` when available, else
 *    fall back to `console.warn`.
 *
 * Everything is best-effort: any HTTP / cache / IPC failure silently
 * suppresses the warning rather than disrupting extension startup.
 *
 * Toggles:
 *   - `PI_CUE_NO_VERSION_CHECK=1`   — disable entirely
 *   - `PI_CUE_VERSION_CACHE_TTL_MS` — override the 6h cache TTL
 *   - `PI_CUE_LATEST_RELEASE_URL`   — override the GitHub API URL (tests)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import type { CueClient } from "./cue-client.ts";

export type DaemonVersion = { kind: "reported"; version: string } | { kind: "unknown" };

export type VersionVerdict =
  | { kind: "match" }
  | { kind: "outdated"; daemon: DaemonVersion; latest: string }
  | { kind: "unknown-running"; latest: string }
  | { kind: "no-latest"; daemon: DaemonVersion };

export interface VersionCheckOptions {
  /**
   * Override the latest-release lookup. When provided, no HTTP/cache work
   * happens and `null` means "no upstream version known".
   */
  latest?: string | null | (() => Promise<string | null>);
}

interface NotifyContext {
  ui?: { notify?: (message: string, level: "info" | "warning" | "error" | "success") => void };
}

const DEFAULT_API_URL = "https://api.github.com/repos/zrr1999/cue-shell/releases/latest";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HTTP_TIMEOUT_MS = 4000;
const NOTIFY_LEVEL = "warning";
const ENV_NO_CHECK = "PI_CUE_NO_VERSION_CHECK";
const ENV_TTL = "PI_CUE_VERSION_CACHE_TTL_MS";
const ENV_API_URL = "PI_CUE_LATEST_RELEASE_URL";

let warnedForProcess = false;

/**
 * Compare a daemon-reported version against the latest known upstream
 * version.
 *
 * - `latest === null` (lookup failed): only "unknown daemon" is actionable;
 *   we cannot prove anything about a version-reporting daemon.
 * - Reported daemon vs `latest`: actionable only when `daemon < latest`.
 *   Equal-or-newer daemons (e.g. local dev builds ahead of last release)
 *   are treated as a match to avoid noise.
 */
export function classifyDaemonVersion(
  daemon: DaemonVersion,
  latest: string | null,
): VersionVerdict {
  if (latest === null) {
    if (daemon.kind === "unknown") return { kind: "no-latest", daemon };
    return { kind: "match" };
  }
  if (daemon.kind === "unknown") {
    return { kind: "unknown-running", latest };
  }
  return compareSemver(daemon.version, latest) < 0
    ? { kind: "outdated", daemon, latest }
    : { kind: "match" };
}

/**
 * Render the user-visible warning, or `null` when no warning is needed.
 */
export function renderWarning(verdict: VersionVerdict): string | null {
  if (verdict.kind === "match") return null;
  if (verdict.kind === "no-latest") return null;
  const lines: string[] = [];
  if (verdict.kind === "unknown-running") {
    lines.push(
      `spark-cue: cued does not report its version; latest cue-shell release is ${verdict.latest}.`,
    );
  } else {
    lines.push(
      `spark-cue: cued ${verdict.daemon.kind === "reported" ? verdict.daemon.version : "(unknown)"} is older than latest cue-shell release ${verdict.latest}.`,
    );
  }
  lines.push("  Self-update + restart:  cued upgrade");
  lines.push("  Or just restart:        cued restart");
  lines.push(`  Suppress with ${ENV_NO_CHECK}=1.`);
  return lines.join("\n");
}

/**
 * Run the version handshake against `client`, fetch the latest upstream
 * release in the background, and warn on the first outdated daemon
 * detected within this Node process.
 *
 * Always resolves; never throws. The promise resolves once the warning
 * decision is final (or skipped). Callers in hot paths can ignore the
 * returned promise — IPC and HTTP failures are swallowed deliberately.
 */
export async function checkAndWarn(
  client: CueClient,
  ctx?: NotifyContext,
  options?: VersionCheckOptions,
): Promise<VersionVerdict | null> {
  if (warnedForProcess) return null;
  if (envFlag(ENV_NO_CHECK)) {
    warnedForProcess = true;
    return null;
  }

  let daemon: DaemonVersion;
  try {
    const reported = await client.pingForVersion();
    daemon =
      reported !== null && reported.length > 0
        ? { kind: "reported", version: reported }
        : { kind: "unknown" };
  } catch {
    // Don't promote transport errors into version warnings.
    return null;
  }

  const latest = await resolveLatest(options?.latest);
  const verdict = classifyDaemonVersion(daemon, latest);
  const message = renderWarning(verdict);
  if (message === null) {
    warnedForProcess = true;
    return verdict;
  }

  warnedForProcess = true;
  if (ctx?.ui?.notify) {
    ctx.ui.notify(message, NOTIFY_LEVEL);
  } else {
    console.warn(message);
  }
  return verdict;
}

async function resolveLatest(override: VersionCheckOptions["latest"]): Promise<string | null> {
  if (override !== undefined) {
    if (typeof override === "function") {
      try {
        return await override();
      } catch {
        return null;
      }
    }
    return override;
  }
  return await fetchLatestRelease();
}

/**
 * Fetch the latest cue-shell release tag, with a small on-disk cache.
 *
 * Returns `null` on any failure (offline, rate-limited, parse error,
 * tag missing, etc.) so callers stay quiet rather than nagging users
 * about transient issues.
 */
export async function fetchLatestRelease(): Promise<string | null> {
  const apiUrl = process.env[ENV_API_URL] ?? DEFAULT_API_URL;
  const ttl = parseTtl(process.env[ENV_TTL]) ?? DEFAULT_TTL_MS;
  const cachePath = cacheFilePath();

  const cached = await readCache(cachePath);
  if (cached && cached.url === apiUrl && Date.now() - cached.fetchedAt < ttl) {
    return cached.tag;
  }

  const tag = await httpGetReleaseTag(apiUrl);
  // Always write cache, even on negative result, so we don't hammer the
  // API on every connection while offline. Negative entries respect the
  // same TTL window.
  await writeCache(cachePath, { url: apiUrl, tag, fetchedAt: Date.now() });
  return tag;
}

interface CacheEntry {
  url: string;
  tag: string | null;
  fetchedAt: number;
}

function cacheFilePath(): string {
  const base =
    process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.length > 0
      ? process.env.XDG_CACHE_HOME
      : join(homedir(), ".cache");
  return join(base, "@zendev-lab/spark-cue", "cued-version.json");
}

async function readCache(path: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as Partial<CacheEntry>;
    if (
      typeof data.url === "string" &&
      typeof data.fetchedAt === "number" &&
      (data.tag === null || typeof data.tag === "string")
    ) {
      return { url: data.url, tag: data.tag, fetchedAt: data.fetchedAt };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(path: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), "utf-8");
  } catch {
    // Best-effort; a read-only HOME just means we'll re-fetch next time.
  }
}

async function httpGetReleaseTag(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "spark-cue version-check",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string" || data.tag_name.length === 0) return null;
    return normalizeTag(data.tag_name);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function parseTtl(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * Lexicographic semver-ish comparison.
 *
 * Splits on dot, compares numeric parts numerically, falls back to string
 * compare for anything non-numeric (e.g. `1.0.0-rc1`). Good enough to
 * decide "older than latest release" on the cue-shell tag scheme without
 * pulling a full semver library into this extension.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): Array<number | string> =>
    normalizeTag(v)
      .split(/[.+-]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) && /^\d+$/.test(part) ? n : part;
      });
  const ap = parse(a);
  const bp = parse(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i += 1) {
    const av = ap[i];
    const bv = bp[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av < bv ? -1 : 1;
      continue;
    }
    const as = String(av);
    const bs = String(bv);
    if (as !== bs) return as < bs ? -1 : 1;
  }
  return 0;
}

/**
 * Reset the once-per-process state. Test-only.
 *
 * @internal
 */
export function __resetForTests(): void {
  warnedForProcess = false;
}
