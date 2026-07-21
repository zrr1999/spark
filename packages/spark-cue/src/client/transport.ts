/** cue-shell transport resolution. */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { cueShellProcessEnvironment } from "../executable-environment.ts";
import { CueError, type CueResolvedTransport } from "../wire/types.ts";

export type { CueResolvedTransport };
// ── Default socket path ────────────────────────────────────────────────────

const APP_DIR = "cue-shell";
const SOCK_NAME = "cued.sock";

/** Resolve the default cue-shell daemon socket path. */
export function defaultSocketPath(): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || tmpdir();
  return join(runtimeDir, APP_DIR, SOCK_NAME);
}

interface ResolverAttempt {
  command: string;
  args: string[];
}

export const DEFAULT_CUE_RESOLVER_TIMEOUT_MS = 10_000;
export const DEFAULT_CUE_CONNECT_TIMEOUT_MS = 10_000;

const RESOLVER_ATTEMPTS: ResolverAttempt[] = [
  { command: "cue-client", args: ["target", "resolve", "--json"] },
  { command: "cue", args: ["client", "target", "resolve", "--json"] },
];

export async function resolveCueTransport(): Promise<CueResolvedTransport> {
  const failures: string[] = [];
  for (const attempt of RESOLVER_ATTEMPTS) {
    try {
      const stdout = await runResolverAttempt(attempt);
      return parseResolvedTransport(stdout, `${attempt.command} ${attempt.args.join(" ")}`);
    } catch (error) {
      failures.push(`${attempt.command} ${attempt.args.join(" ")}: ${(error as Error).message}`);
    }
  }
  throw new CueError(
    "TRANSPORT_RESOLVE_FAILED",
    `failed to resolve cue-shell client transport via cue-client. Tried:\n${failures.join("\n")}`,
  );
}

function runResolverAttempt(attempt: ResolverAttempt): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(attempt.command, attempt.args, {
      env: cueShellProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = timeoutMsFromEnv(
      "PI_CUE_RESOLVER_TIMEOUT_MS",
      DEFAULT_CUE_RESOLVER_TIMEOUT_MS,
    );
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cb();
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(detail || `exited with code ${code}`));
      });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(() =>
          reject(
            new Error(
              `resolver timed out after ${timeoutMs}ms: ${attempt.command} ${attempt.args.join(" ")}`,
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}

function parseResolvedTransport(text: string, source: string): CueResolvedTransport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON from ${source}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid resolver payload from ${source}: expected object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new Error(
      `unsupported resolver schema_version from ${source}: ${String(record.schema_version)}`,
    );
  }
  if (record.transport === "unix") {
    if (typeof record.profile_name !== "string" || typeof record.socket_path !== "string") {
      throw new Error(`invalid unix resolver payload from ${source}`);
    }
    return {
      schema_version: 1,
      profile_name: record.profile_name,
      transport: "unix",
      socket_path: record.socket_path,
    };
  }
  if (record.transport === "ssh") {
    if (
      typeof record.profile_name !== "string" ||
      typeof record.destination !== "string" ||
      typeof record.gateway_command !== "string" ||
      typeof record.start_command !== "string"
    ) {
      throw new Error(`invalid ssh resolver payload from ${source}`);
    }
    return {
      schema_version: 1,
      profile_name: record.profile_name,
      transport: "ssh",
      destination: record.destination,
      gateway_command: record.gateway_command,
      start_command: record.start_command,
    };
  }
  throw new Error(`unsupported resolver transport from ${source}: ${String(record.transport)}`);
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : 0;
}
