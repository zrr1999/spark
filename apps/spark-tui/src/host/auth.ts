import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getOAuthProvider,
  getOAuthProviders,
  registerOAuthProvider,
  resetOAuthProviders,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";

import type { ProviderConfig } from "./provider-registry.ts";

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
}

const AUTH_FILE_VERSION = 1;

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
    this.path = options.path ?? defaultSparkAuthPath(options.sparkHome);
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

  async set(provider: string, credential: SparkStoredCredential): Promise<void> {
    this.#credentials = {
      ...this.#credentials,
      [provider]: cloneCredential({ ...credential, provider }),
    };
    await this.#persist();
  }

  async remove(provider: string): Promise<boolean> {
    if (!this.#credentials[provider]) return false;
    const next = { ...this.#credentials };
    delete next[provider];
    this.#credentials = next;
    await this.#persist();
    return true;
  }

  async loginOAuth(
    providerId: string,
    callbacks: OAuthLoginCallbacks,
    provider: OAuthProviderInterface | undefined = getOAuthProvider(providerId),
  ): Promise<void> {
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    await this.setOAuth(provider.id, credentials);
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700).catch(() => undefined);
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

  constructor(store: SparkAuthStore, options: SparkProviderAuthResolverOptions = {}) {
    this.#store = store;
    this.#env = options.env ?? process.env;
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
        configured: Boolean(this.#env[ref.name]),
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

  resolveApiKey(provider: ProviderConfig): string | undefined {
    const ref = normalizeProviderAuthRef(provider.apiKey);
    if (ref.kind === "none") return undefined;
    if (ref.kind === "env") return this.#env[ref.name];
    if (ref.kind === "literal") return ref.value;
    const credential = this.#store.get(ref.provider);
    if (credential?.type !== "oauth") return undefined;
    return getOAuthProvider(ref.provider)?.getApiKey(credential.credentials);
  }
}

export function listOAuthProviderSummaries(): Array<{ id: string; name: string }> {
  return getOAuthProviders()
    .map((provider) => ({ id: provider.id, name: provider.name }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

type ProviderAuthRef =
  | { kind: "none" }
  | { kind: "env"; name: string }
  | { kind: "literal"; value: string }
  | { kind: "oauth"; provider: string };

function normalizeProviderAuthRef(value: string | undefined): ProviderAuthRef {
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
