import { timingSafeEqual } from "node:crypto";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";

export const remoteAccessTokenEnvNames = [
  "SPARK_COCKPIT_REMOTE_TOKEN",
  "SPARK_COCKPIT_TOKEN",
] as const;

export interface RemoteAccessDecision {
  required: boolean;
  publicPath: boolean;
  localRequest: boolean;
}

export interface RemoteAccessRequestInfo {
  url: URL;
  clientAddress: string | null | undefined;
}

export function remoteAccessDecision(input: RemoteAccessRequestInfo): RemoteAccessDecision {
  const publicPath = isPublicRemotePath(input.url.pathname);
  const localRequest = isLoopbackClientAddress(input.clientAddress);
  return {
    required: !localRequest && !publicPath,
    publicPath,
    localRequest,
  };
}

export function isRemoteAccessAllowed(
  input: RemoteAccessRequestInfo & {
    sessionUserId?: string | null;
    bearerToken?: string | null;
    env?: Record<string, string | undefined>;
  },
): boolean {
  const decision = remoteAccessDecision(input);
  return (
    !decision.required ||
    Boolean(input.sessionUserId) ||
    verifyRemoteAccessToken(input.bearerToken, input.env)
  );
}

export function isLoopbackClientAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = normalizeClientAddress(address);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizeClientAddress(address: string): string {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

export function isPublicRemotePath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/service-worker.js" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/_app/") ||
    pathname.startsWith("/api/v1/runtime/")
  );
}

export function configuredRemoteAccessToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const name of remoteAccessTokenEnvNames) {
    const token = env[name]?.trim();
    if (token) return token;
  }
  return null;
}

export function isRemoteAccessConfigured(env?: Record<string, string | undefined>): boolean {
  return Boolean(configuredRemoteAccessToken(env));
}

export function bearerRemoteAccessToken(request: Request): string | null {
  return bearerTokenFromAuthorization(request.headers.get("authorization") ?? undefined) ?? null;
}

export function verifyRemoteAccessToken(
  token: string | null | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  const configured = configuredRemoteAccessToken(env);
  if (!configured || !token) return false;
  const configuredBytes = Buffer.from(configured);
  const tokenBytes = Buffer.from(token);
  return (
    configuredBytes.length === tokenBytes.length && timingSafeEqual(configuredBytes, tokenBytes)
  );
}
