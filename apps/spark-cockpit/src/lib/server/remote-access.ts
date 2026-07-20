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
  if (
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/service-worker.js" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/_app/") ||
    pathname.startsWith("/api/v1/runtime/")
  ) {
    return true;
  }
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2 && segments[1] === "login";
}
