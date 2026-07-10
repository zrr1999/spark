import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  getOAuthProvider,
  getOAuthProviders,
  registerOAuthProvider,
  resetOAuthProviders,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";

import type { ProviderConfig } from "../provider-registry.ts";
import { withPathMutation } from "./path-mutation.ts";

export type SparkStoredCredential =
  | {
      type: "oauth";
      provider: string;
      credentials: OAuthCredentials;
      updatedAt: string;
    }
  | {
      type: "api_key";
      provider: string;
      apiKey: string;
      updatedAt: string;
    };

export interface SparkAuthFile {
  version: 1;
  credentials: Record<string, SparkStoredCredential>;
}

export interface SparkAuthStoreOptions {
  path?: string;
  sparkHome?: string;
  now?: () => Date;
}

export interface SparkProviderAuthStatus {
  provider: string;
  kind: "none" | "env" | "literal" | "oauth";
  configured: boolean;
  ref?: string;
}

export interface SparkProviderAuthResolverOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const AUTH_FILE_VERSION = 1;
const oauthRefreshes = new Map<string, Promise<string | undefined>>();

export const registerSparkOAuthProvider = registerOAuthProvider;
export const resetSparkOAuthProviders = resetOAuthProviders;
export type SparkOAuthProviderInterface = OAuthProviderInterface;

export function defaultSparkAuthPath(sparkHome?: string): string {
  const root = sparkHome ?? process.env.SPARK_HOME ?? join(homedir(), ".spark");
  return join(root, "auth.json");
}

export class SparkAuthStore {
  readonly path: string;
  readonly #now: () => Date;
  #credentials: Record<string, SparkStoredCredential> = {};
  #loadError: Error | undefined;

  constructor(options: SparkAuthStoreOptions = {}) {
    this.path = resolve(options.path ?? defaultSparkAuthPath(options.sparkHome));
    this.#now = options.now ?? (() => new Date());
  }

  get loadError(): Error | undefined {
    return this.#loadError;
  }

  snapshot(): SparkAuthFile {
    return {
      version: AUTH_FILE_VERSION,
      credentials: cloneCredentials(this.#credentials),
    };
  }

  async reload(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = parseAuthFile(JSON.parse(raw));
      this.#credentials = parsed.credentials;
      this.#loadError = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#credentials = {};
        this.#loadError = undefined;
        return;
      }
      this.#loadError = error instanceof Error ? error : new Error(String(error));
      this.#credentials = {};
    }
  }

  get(provider: string): SparkStoredCredential | undefined {
    const credential = this.#credentials[provider];
    return credential ? cloneCredential(credential) : undefined;
  }

  has(provider: string): boolean {
    return this.#credentials[provider] !== undefined;
  }

  listProviders(): string[] {
    return Object.keys(this.#credentials).sort();
  }

  async setOAuth(provider: string, credentials: OAuthCredentials): Promise<void> {
    await this.set(provider, {
      type: "oauth",
      provider,
      credentials: cloneOAuthCredentials(credentials),
      updatedAt: this.#now().toISOString(),
    });
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    await this.set(provider, {
      type: "api_key",
      provider,
      apiKey,
      updatedAt: this.#now().toISOString(),
    });
  }

  async set(provider: string, credential: SparkStoredCredential): Promise<void> {
    validateCredentialKey(provider);
    await withPathMutation(this.path, async () => {
      await this.#reloadForMutation();
      this.#credentials = {
        ...this.#credentials,
        [provider]: cloneCredential({ ...credential, provider }),
      };
      await this.#persist();
    });
  }

  async remove(provider: string): Promise<boolean> {
    return (await this.removeMany([provider])).length > 0;
  }

  async removeMany(providers: readonly string[]): Promise<string[]> {
    const requested = [...new Set(providers.filter(Boolean))];
    if (requested.length === 0) return [];
    return withPathMutation(this.path, async () => {
      await this.#reloadForMutation();
      const removed = requested.filter((provider) => this.#credentials[provider] !== undefined);
      if (removed.length === 0) return [];
      const next = { ...this.#credentials };
      for (const provider of removed) delete next[provider];
      this.#credentials = next;
      await this.#persist();
      return removed;
    });
  }

  async loginOAuth(
    providerId: string,
    callbacks: OAuthLoginCallbacks,
    provider: OAuthProviderInterface | undefined = getOAuthProvider(providerId),
  ): Promise<void> {
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    if (callbacks.signal?.aborted) {
      const error = new Error("OAuth login cancelled");
      error.name = "AbortError";
      throw error;
    }
    await this.setOAuth(provider.id, credentials);
  }

  async #reloadForMutation(): Promise<void> {
    await this.reload();
    if (this.#loadError) {
      throw new Error(
        `Refusing to overwrite unreadable Spark auth store: ${this.#loadError.message}`,
      );
    }
  }

  async #persist(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

export class SparkProviderAuthResolver {
  readonly #store: SparkAuthStore;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(store: SparkAuthStore, options: SparkProviderAuthResolverOptions = {}) {
    this.#store = store;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? Date.now;
  }

  status(provider: ProviderConfig): SparkProviderAuthStatus {
    const ref = normalizeProviderAuthRef(provider.apiKey);
    if (ref.kind === "none") {
      return { provider: provider.name, kind: "none", configured: true };
    }
    if (ref.kind === "env") {
      return {
        provider: provider.name,
        kind: "env",
        ref: ref.name,
        configured: Boolean(this.#storedApiKey(provider, ref.name) ?? this.#env[ref.name]),
      };
    }
    if (ref.kind === "oauth") {
      return {
        provider: provider.name,
        kind: "oauth",
        ref: ref.provider,
        configured: this.#store.has(ref.provider),
      };
    }
    return { provider: provider.name, kind: "literal", configured: true };
  }

  hasConfiguredAuth(provider: ProviderConfig): boolean {
    return this.status(provider).configured;
  }

  /** Compatibility path for synchronous stream adapters. It does not refresh tokens. */
  resolveApiKey(provider: ProviderConfig): string | undefined {
    const ref = normalizeProviderAuthRef(provider.apiKey);
    if (ref.kind === "none") return undefined;
    if (ref.kind === "env") return this.#storedApiKey(provider, ref.name) ?? this.#env[ref.name];
    if (ref.kind === "literal") return ref.value;
    const credential = this.#store.get(ref.provider);
    if (credential?.type !== "oauth") return undefined;
    return getOAuthProvider(ref.provider)?.getApiKey(credential.credentials);
  }

  /** Resolve and durably persist a refreshed OAuth credential when it is expired. */
  async resolveApiKeyAsync(provider: ProviderConfig): Promise<string | undefined> {
    await this.#store.reload();
    if (this.#store.loadError) throw this.#store.loadError;
    const immediate = this.resolveApiKeyWithoutExpiredOAuth(provider);
    if (immediate.done) return immediate.value;

    const ref = normalizeProviderAuthRef(provider.apiKey);
    if (ref.kind !== "oauth") return undefined;
    const refreshKey = `${this.#store.path}\0${ref.provider}`;
    const pending = oauthRefreshes.get(refreshKey);
    if (pending) return pending;
    const refresh = this.#refreshOAuth(ref.provider).finally(() => {
      if (oauthRefreshes.get(refreshKey) === refresh) oauthRefreshes.delete(refreshKey);
    });
    oauthRefreshes.set(refreshKey, refresh);
    return refresh;
  }

  #resolveStoredOAuth(providerId: string): SparkStoredCredential | undefined {
    return this.#store.get(providerId);
  }

  resolveApiKeyWithoutExpiredOAuth(provider: ProviderConfig): {
    done: boolean;
    value?: string;
  } {
    const ref = normalizeProviderAuthRef(provider.apiKey);
    if (ref.kind === "none") return { done: true };
    if (ref.kind === "env") {
      const value = this.#storedApiKey(provider, ref.name) ?? this.#env[ref.name];
      return value === undefined ? { done: true } : { done: true, value };
    }
    if (ref.kind === "literal") return { done: true, value: ref.value };
    const credential = this.#resolveStoredOAuth(ref.provider);
    if (credential?.type !== "oauth") return { done: true };
    if (this.#now() >= credential.credentials.expires) return { done: false };
    const value = getOAuthProvider(ref.provider)?.getApiKey(credential.credentials);
    return value === undefined ? { done: true } : { done: true, value };
  }

  async #refreshOAuth(providerId: string): Promise<string | undefined> {
    // Re-read after joining the refresh queue: another store instance may have
    // completed a refresh before this task started.
    await this.#store.reload();
    if (this.#store.loadError) throw this.#store.loadError;
    const credential = this.#resolveStoredOAuth(providerId);
    if (credential?.type !== "oauth") return undefined;
    const oauthProvider = getOAuthProvider(providerId);
    if (!oauthProvider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    if (this.#now() < credential.credentials.expires) {
      return oauthProvider.getApiKey(credential.credentials);
    }
    const refreshed = await oauthProvider.refreshToken(credential.credentials);
    await this.#store.setOAuth(providerId, refreshed);
    return oauthProvider.getApiKey(refreshed);
  }

  #storedApiKey(provider: ProviderConfig, alternateKey?: string): string | undefined {
    for (const key of [provider.name, alternateKey]) {
      if (!key) continue;
      const credential = this.#store.get(key);
      if (credential?.type === "api_key") return credential.apiKey;
    }
    return undefined;
  }
}

export function listOAuthProviderSummaries(): Array<{ id: string; name: string }> {
  return getOAuthProviders()
    .map((provider) => ({ id: provider.id, name: provider.name }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export type ProviderAuthRef =
  | { kind: "none" }
  | { kind: "env"; name: string }
  | { kind: "literal"; value: string }
  | { kind: "oauth"; provider: string };

export function normalizeProviderAuthRef(value: string | undefined): ProviderAuthRef {
  if (value === undefined || value.length === 0) return { kind: "none" };
  if (value.startsWith("oauth:")) return { kind: "oauth", provider: value.slice("oauth:".length) };
  if (/^[A-Z0-9_]+$/u.test(value)) return { kind: "env", name: value };
  return { kind: "literal", value };
}

function parseAuthFile(value: unknown): SparkAuthFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyAuthFile();
  const record = value as { version?: unknown; credentials?: unknown };
  if (record.version !== AUTH_FILE_VERSION || !isRecord(record.credentials)) {
    return emptyAuthFile();
  }
  const credentials: Record<string, SparkStoredCredential> = {};
  for (const [provider, credential] of Object.entries(record.credentials)) {
    const parsed = parseCredential(provider, credential);
    if (parsed) credentials[provider] = parsed;
  }
  return { version: AUTH_FILE_VERSION, credentials };
}

function parseCredential(provider: string, value: unknown): SparkStoredCredential | undefined {
  if (!isRecord(value)) return undefined;
  const updatedAt =
    typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString();
  if (value.type === "oauth" && isRecord(value.credentials)) {
    const credentials = value.credentials as Partial<OAuthCredentials>;
    if (
      typeof credentials.refresh === "string" &&
      typeof credentials.access === "string" &&
      typeof credentials.expires === "number"
    ) {
      return {
        type: "oauth",
        provider,
        credentials: cloneOAuthCredentials(credentials as OAuthCredentials),
        updatedAt,
      };
    }
  }
  if (value.type === "api_key" && typeof value.apiKey === "string") {
    return { type: "api_key", provider, apiKey: value.apiKey, updatedAt };
  }
  return undefined;
}

function emptyAuthFile(): SparkAuthFile {
  return { version: AUTH_FILE_VERSION, credentials: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneCredentials(
  credentials: Record<string, SparkStoredCredential>,
): Record<string, SparkStoredCredential> {
  return Object.fromEntries(
    Object.entries(credentials).map(([provider, credential]) => [
      provider,
      cloneCredential(credential),
    ]),
  );
}

function cloneCredential(credential: SparkStoredCredential): SparkStoredCredential {
  if (credential.type === "oauth") {
    return {
      type: "oauth",
      provider: credential.provider,
      credentials: cloneOAuthCredentials(credential.credentials),
      updatedAt: credential.updatedAt,
    };
  }
  return {
    type: "api_key",
    provider: credential.provider,
    apiKey: credential.apiKey,
    updatedAt: credential.updatedAt,
  };
}

function cloneOAuthCredentials(credentials: OAuthCredentials): OAuthCredentials {
  return { ...credentials };
}

function validateCredentialKey(provider: string): void {
  if (!provider.trim()) throw new Error("Spark credential provider must be non-empty");
}
