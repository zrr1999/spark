export function asciiSlug(
  value: string,
  options: { fallback?: string; maxLength?: number } = {},
): string {
  const fallback = options.fallback ?? "";
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const result: string[] = [];
  let pendingDash = false;

  for (const char of value.trim().toLowerCase()) {
    if (isAsciiSlugChar(char)) {
      if (pendingDash && result.length > 0 && result.length < maxLength) {
        result.push("-");
      }
      pendingDash = false;
      if (result.length < maxLength) {
        result.push(char);
      }
      continue;
    }

    pendingDash = result.length > 0;
  }

  return result.join("") || fallback;
}

export function bearerTokenFromAuthorization(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const trimmed = authorization.trim();
  const separatorIndex = trimmed.indexOf(" ");
  if (separatorIndex <= 0) {
    return null;
  }

  const scheme = trimmed.slice(0, separatorIndex).toLowerCase();
  if (scheme !== "bearer") {
    return null;
  }

  const token = trimmed.slice(separatorIndex + 1).trim();
  return token || null;
}

function isAsciiSlugChar(char: string): boolean {
  if (char.length !== 1) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}
