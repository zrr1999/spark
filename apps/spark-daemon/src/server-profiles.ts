import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile, type SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";

const serverProfilesFileVersion = 1;
const defaultServerProfilesLockTimeoutMs = 10_000;
const defaultServerProfilesLockRetryIntervalMs = 25;
const defaultServerProfilesLockStaleMs = 60_000;
const serverProfileCredentialKeys = [
  "runtimeId",
  "runtimeToken",
  "runtimeTokenExpiresAt",
  "refreshToken",
  "refreshTokenExpiresAt",
  "webSocketUrl",
] as const;

type ServerProfileCredentialKey = (typeof serverProfileCredentialKeys)[number];

/** Private runtime credentials scoped to one Cockpit origin. */
export interface SparkDaemonServerProfile {
  serverUrl: string;
  runtimeId?: string;
  runtimeToken?: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  webSocketUrl?: string;
}

interface PersistedServerProfiles {
  version: typeof serverProfilesFileVersion;
  profiles: Record<string, Partial<Record<ServerProfileCredentialKey, string>>>;
}

interface ServerProfilesLockOwner {
  ownerId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface SparkDaemonServerProfilesLockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryIntervalMs?: number;
  staleMs?: number;
}

export type SparkDaemonServerProfileCasResult =
  | { applied: true; current: SparkDaemonServerProfile }
  | { applied: false; current: SparkDaemonServerProfile | undefined };

export class SparkDaemonServerProfilesLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for Spark daemon server profiles lock: ${lockPath}`);
    this.name = "SparkDaemonServerProfilesLockTimeoutError";
  }
}

const serverProfilesLockContext = new AsyncLocalStorage<ReadonlySet<string>>();

/** Keep the credential store beside daemon.toml so explicit config-file test and
 * embedding overrides remain self-contained. */
export function sparkDaemonServerProfilesFile(paths: SparkPaths): string {
  return join(dirname(paths.configFile), "daemon-server-profiles.json");
}

export function sparkDaemonServerProfilesLockPath(paths: SparkPaths): string {
  return `${sparkDaemonServerProfilesFile(paths)}.lock`;
}

/** Canonical profile key. Transport-security policy remains owned by the
 * registration boundary; this function only validates and normalizes origins. */
export function normalizeSparkDaemonServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Cockpit server URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Cockpit credentials must not be embedded in the server URL.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Cockpit server URL must be an origin without a path, query, or fragment.");
  }
  return `${parsed.origin}/`;
}

/** List persisted profiles, with a legacy daemon.toml credential tuple exposed
 * as a read-only fallback until the first upsert migrates it into this store. */
export function listSparkDaemonServerProfiles(paths: SparkPaths): SparkDaemonServerProfile[] {
  const profiles = readPersistedServerProfiles(paths);
  const legacy = sparkDaemonServerProfileFromConfig(readSparkDaemonConfig(paths));
  if (legacy && !profiles.has(legacy.serverUrl)) {
    profiles.set(legacy.serverUrl, legacy);
  }
  return [...profiles.values()].sort((left, right) =>
    left.serverUrl.localeCompare(right.serverUrl),
  );
}

/** Look up one Cockpit profile by its normalized origin. */
export function getSparkDaemonServerProfile(
  paths: SparkPaths,
  serverUrl: string,
): SparkDaemonServerProfile | undefined {
  const normalized = normalizeSparkDaemonServerUrl(serverUrl);
  return listSparkDaemonServerProfiles(paths).find((profile) => profile.serverUrl === normalized);
}

/** Insert or replace exactly one profile under the cross-process store lock. */
export async function upsertSparkDaemonServerProfile(
  paths: SparkPaths,
  profile: SparkDaemonServerProfile,
  options: SparkDaemonServerProfilesLockOptions = {},
): Promise<SparkDaemonServerProfile> {
  const normalized = normalizeServerProfile(profile);
  return withSparkDaemonServerProfilesLock(
    paths,
    () => {
      const profiles = readServerProfilesForMutation(paths);
      profiles.set(normalized.serverUrl, normalized);
      writePersistedServerProfiles(paths, profiles);
      return normalized;
    },
    options,
  );
}

/** Remove exactly one profile under the cross-process store lock. */
export async function removeSparkDaemonServerProfile(
  paths: SparkPaths,
  serverUrl: string,
  options: SparkDaemonServerProfilesLockOptions = {},
): Promise<boolean> {
  const normalized = normalizeSparkDaemonServerUrl(serverUrl);
  return withSparkDaemonServerProfilesLock(
    paths,
    () => {
      const profiles = readServerProfilesForMutation(paths);
      if (!profiles.delete(normalized)) {
        return false;
      }
      writePersistedServerProfiles(paths, profiles);
      return true;
    },
    options,
  );
}

/** Compare and replace one credential tuple in the same lock critical section.
 * A late refresh response therefore cannot overwrite a newer registration. */
export async function compareAndSwapSparkDaemonServerProfile(
  paths: SparkPaths,
  serverUrl: string,
  expected: { runtimeId: string; refreshToken: string },
  update: (current: SparkDaemonServerProfile) => SparkDaemonServerProfile,
  options: SparkDaemonServerProfilesLockOptions = {},
): Promise<SparkDaemonServerProfileCasResult> {
  const normalizedServerUrl = normalizeSparkDaemonServerUrl(serverUrl);
  return withSparkDaemonServerProfilesLock(
    paths,
    () => {
      const profiles = readServerProfilesForMutation(paths);
      const current = profiles.get(normalizedServerUrl);
      if (
        !current ||
        current.runtimeId !== expected.runtimeId ||
        current.refreshToken !== expected.refreshToken
      ) {
        return { applied: false, current };
      }

      const next = normalizeServerProfile(update(current));
      if (next.serverUrl !== normalizedServerUrl) {
        throw new Error(
          `Spark daemon server profile CAS cannot change its origin from ${normalizedServerUrl} to ${next.serverUrl}.`,
        );
      }
      profiles.set(normalizedServerUrl, next);
      writePersistedServerProfiles(paths, profiles);
      return { applied: true, current: next };
    },
    options,
  );
}

/** Run a bounded critical section guarded by the profile store's filesystem
 * lock. The directory lock is visible across daemon and CLI processes. */
export async function withSparkDaemonServerProfilesLock<T>(
  paths: SparkPaths,
  operation: () => T | Promise<T>,
  options: SparkDaemonServerProfilesLockOptions = {},
): Promise<T> {
  const lockPath = sparkDaemonServerProfilesLockPath(paths);
  const heldLocks = serverProfilesLockContext.getStore();
  if (heldLocks?.has(lockPath)) {
    throwIfAborted(options.signal);
    return operation();
  }

  const release = await acquireServerProfilesLock(lockPath, options);
  const nextHeldLocks = new Set(heldLocks);
  nextHeldLocks.add(lockPath);
  return serverProfilesLockContext.run(nextHeldLocks, async () => {
    try {
      throwIfAborted(options.signal);
      return await operation();
    } finally {
      await release();
    }
  });
}

/** Convert the legacy config shape into one profile without retaining daemon
 * identity fields. Returns undefined when daemon.toml has no server credential. */
export function sparkDaemonServerProfileFromConfig(
  config: SparkDaemonConfig,
): SparkDaemonServerProfile | undefined {
  const serverUrl = configuredServerUrl(config);
  if (!serverUrl || !serverProfileCredentialKeys.some((key) => config[key])) {
    return undefined;
  }
  return normalizeServerProfile({
    serverUrl,
    ...pickCredentialFields(config),
  });
}

/** Preserve the public SparkDaemonConfig shape for existing registration and
 * connection call sites while replacing, rather than mixing, credential tuples. */
export function sparkDaemonConfigForServerProfile(
  identity: Pick<SparkDaemonConfig, "installationId" | "displayName">,
  profile: SparkDaemonServerProfile,
): SparkDaemonConfig {
  const normalized = normalizeServerProfile(profile);
  return {
    installationId: identity.installationId,
    displayName: identity.displayName,
    serverUrl: normalized.serverUrl,
    ...pickCredentialFields(normalized),
  };
}

/** Mutate an existing compatibility config without leaving optional credential
 * fields from a previously selected server behind. */
export function replaceSparkDaemonConfigServerProfile(
  config: SparkDaemonConfig,
  profile: SparkDaemonServerProfile,
): SparkDaemonConfig {
  for (const key of ["serverUrl", ...serverProfileCredentialKeys] as const) {
    delete config[key];
  }
  Object.assign(config, sparkDaemonConfigForServerProfile(config, profile));
  return config;
}

function readPersistedServerProfiles(paths: SparkPaths): Map<string, SparkDaemonServerProfile> {
  const file = sparkDaemonServerProfilesFile(paths);
  if (!existsSync(file)) {
    return new Map();
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read Spark daemon server profiles from ${file}.`, { cause: error });
  }
  if (
    !isRecord(value) ||
    value.version !== serverProfilesFileVersion ||
    !isRecord(value.profiles)
  ) {
    throw new Error(`Invalid Spark daemon server profiles file at ${file}.`);
  }

  const profiles = new Map<string, SparkDaemonServerProfile>();
  for (const [storedServerUrl, storedProfile] of Object.entries(value.profiles)) {
    if (!isRecord(storedProfile)) {
      throw new Error(`Invalid Spark daemon server profile for ${storedServerUrl} in ${file}.`);
    }
    const profile = normalizeServerProfile({
      serverUrl: storedServerUrl,
      ...readCredentialFields(storedProfile, file, storedServerUrl),
    });
    if (profiles.has(profile.serverUrl)) {
      throw new Error(`Duplicate Spark daemon server profile for ${profile.serverUrl} in ${file}.`);
    }
    profiles.set(profile.serverUrl, profile);
  }
  return profiles;
}

function readServerProfilesForMutation(paths: SparkPaths): Map<string, SparkDaemonServerProfile> {
  return new Map(
    listSparkDaemonServerProfiles(paths).map((profile) => [profile.serverUrl, profile]),
  );
}

function writePersistedServerProfiles(
  paths: SparkPaths,
  profiles: ReadonlyMap<string, SparkDaemonServerProfile>,
): void {
  const file = sparkDaemonServerProfilesFile(paths);
  const storedProfiles: PersistedServerProfiles["profiles"] = {};
  for (const [serverUrl, profile] of [...profiles].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    storedProfiles[serverUrl] = pickCredentialFields(profile);
  }
  const contents = `${JSON.stringify(
    {
      version: serverProfilesFileVersion,
      profiles: storedProfiles,
    } satisfies PersistedServerProfiles,
    null,
    2,
  )}\n`;
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writePrivateFile(temporary, contents);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function acquireServerProfilesLock(
  lockPath: string,
  options: SparkDaemonServerProfilesLockOptions,
): Promise<() => Promise<void>> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? defaultServerProfilesLockTimeoutMs);
  const retryIntervalMs = Math.max(
    1,
    options.retryIntervalMs ?? defaultServerProfilesLockRetryIntervalMs,
  );
  const staleMs = Math.max(0, options.staleMs ?? defaultServerProfilesLockStaleMs);
  const startedMs = Date.now();
  const ownerId = `${process.pid}:${startedMs}:${randomUUID()}`;
  const ownerPath = join(lockPath, "owner.json");
  const startedAt = new Date(startedMs).toISOString();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    throwIfAborted(options.signal);
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      await removeStaleServerProfilesLock(lockPath, staleMs);
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs >= timeoutMs) {
        throw new SparkDaemonServerProfilesLockTimeoutError(lockPath);
      }
      await abortableDelay(Math.min(retryIntervalMs, timeoutMs - elapsedMs), options.signal);
      continue;
    }

    const owner = (): ServerProfilesLockOwner => ({
      ownerId,
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    });
    try {
      await writeServerProfilesLockOwner(ownerPath, owner());
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }

    const heartbeatIntervalMs = Math.max(10, Math.min(1_000, Math.floor(staleMs / 3)));
    let heartbeatWrite: Promise<void> | undefined;
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      heartbeatWrite = writeServerProfilesLockOwner(ownerPath, owner()).catch((error) => {
        heartbeatError = error;
      });
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    return async () => {
      clearInterval(heartbeat);
      await heartbeatWrite;
      if (await serverProfilesLockOwnerMatches(ownerPath, ownerId)) {
        await rm(lockPath, { recursive: true, force: true });
      }
      if (heartbeatError) {
        throw new Error(
          `Spark daemon server profiles lock heartbeat failed: ${errorMessage(heartbeatError)}`,
        );
      }
    };
  }
}

async function writeServerProfilesLockOwner(
  ownerPath: string,
  owner: ServerProfilesLockOwner,
): Promise<void> {
  const temporary = `${ownerPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, ownerPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeStaleServerProfilesLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const heartbeatMs = await serverProfilesLockHeartbeatMs(lockPath);
    if (Date.now() - heartbeatMs >= staleMs) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function serverProfilesLockHeartbeatMs(lockPath: string): Promise<number> {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const raw = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (isRecord(raw) && typeof raw.heartbeatAt === "string") {
      const heartbeatMs = Date.parse(raw.heartbeatAt);
      if (Number.isFinite(heartbeatMs)) {
        return heartbeatMs;
      }
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return (await stat(lockPath)).mtimeMs;
}

async function serverProfilesLockOwnerMatches(
  ownerPath: string,
  expectedOwnerId: string,
): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    return isRecord(raw) && raw.ownerId === expectedOwnerId;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("This operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeServerProfile(profile: SparkDaemonServerProfile): SparkDaemonServerProfile {
  return {
    serverUrl: normalizeSparkDaemonServerUrl(profile.serverUrl),
    ...pickCredentialFields(profile),
  };
}

function configuredServerUrl(config: SparkDaemonConfig): string | undefined {
  if (config.serverUrl) {
    return normalizeSparkDaemonServerUrl(config.serverUrl);
  }
  if (!config.webSocketUrl) {
    return undefined;
  }
  const parsed = new URL(config.webSocketUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return undefined;
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return normalizeSparkDaemonServerUrl(parsed.toString());
}

function pickCredentialFields(
  value: Partial<Record<ServerProfileCredentialKey, string>>,
): Partial<Record<ServerProfileCredentialKey, string>> {
  const result: Partial<Record<ServerProfileCredentialKey, string>> = {};
  for (const key of serverProfileCredentialKeys) {
    if (value[key]) {
      result[key] = value[key];
    }
  }
  return result;
}

function readCredentialFields(
  value: Record<string, unknown>,
  file: string,
  serverUrl: string,
): Partial<Record<ServerProfileCredentialKey, string>> {
  const result: Partial<Record<ServerProfileCredentialKey, string>> = {};
  for (const key of serverProfileCredentialKeys) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string" || !candidate) {
      throw new Error(`Invalid ${key} for Spark daemon server profile ${serverUrl} in ${file}.`);
    }
    result[key] = candidate;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
