export async function fetchRegistrationEndpoint(
  url: URL,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Request to ${url.toString()} failed (Cockpit origin: ${url.origin}): ${detail}.${loopbackHint(url)}`,
      { cause: error },
    );
  }
}

function loopbackHint(url: URL): string {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    return "";
  }

  return ` ${url.hostname} is reachable from the daemon machine only; if Cockpit runs on another machine, use its reachable HTTPS URL (or explicitly acknowledge trusted-network HTTP with --allow-insecure-http)`;
}
