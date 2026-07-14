const publicUrlEnvName = "SPARK_COCKPIT_PUBLIC_URL";
const trustProxyEnvName = "SPARK_COCKPIT_TRUST_PROXY";
const proxyHopsEnvName = "SPARK_COCKPIT_PROXY_HOPS";

export type CockpitPublicUrlMode = "local" | "fixed" | "proxy";

export interface CockpitPublicUrlConfig {
  mode: CockpitPublicUrlMode;
  publicUrl: string | null;
  trustedProxy: boolean;
}

export function configureCockpitPublicUrl(
  env: Record<string, string | undefined>,
  input: { host: string; port: number },
): CockpitPublicUrlConfig {
  const productValue = trimmed(env[publicUrlEnvName]);
  const adapterValue = trimmed(env.ORIGIN);
  const trustProxy = resolveTrustProxy(env[trustProxyEnvName], input.host);
  const requested = resolveRequestedPublicUrl(productValue, adapterValue);

  if (requested === "auto") {
    if (!trustProxy) {
      throw new Error(
        `${publicUrlEnvName}=auto requires ${trustProxyEnvName}=loopback so forwarded host and client headers are accepted only from a loopback proxy.`,
      );
    }
    delete env.ORIGIN;
    configureAdapterProxyHeaders(env);
    return { mode: "proxy", publicUrl: null, trustedProxy: true };
  }

  const publicUrl = requested
    ? normalizePublicUrl(requested, publicUrlEnvName)
    : localListenOrigin(input.host, input.port);
  const parsedPublicUrl = new URL(publicUrl);
  const isRemotePublicUrl = !isLoopbackHostname(parsedPublicUrl.hostname);

  if (requested && (isRemotePublicUrl || parsedPublicUrl.protocol === "https:") && !trustProxy) {
    throw new Error(
      `${publicUrlEnvName} requires an explicit proxy boundary for remote domains and HTTPS. Keep HOST on loopback, set ${trustProxyEnvName}=loopback, and terminate public traffic in that proxy.`,
    );
  }

  env.ORIGIN = publicUrl;
  if (trustProxy) configureAdapterProxyHeaders(env);

  return {
    mode: requested ? "fixed" : "local",
    publicUrl,
    trustedProxy: trustProxy,
  };
}

export function normalizePublicUrl(value: string, name = publicUrlEnvName): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new Error(`${name} must be a valid absolute http(s) URL.`, { cause });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http:// or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin without a path, query, or fragment.`);
  }

  return parsed.origin;
}

export function isLoopbackBindHost(host: string): boolean {
  return isLoopbackHostname(host.replace(/^\[|\]$/g, ""));
}

function resolveRequestedPublicUrl(
  productValue: string | undefined,
  adapterValue: string | undefined,
): string | undefined {
  if (!productValue) return adapterValue;
  if (!adapterValue) return productValue;

  if (productValue === "auto" || adapterValue === "auto") {
    if (productValue === adapterValue) return productValue;
    throw new Error(`${publicUrlEnvName} conflicts with ORIGIN; configure only one public URL.`);
  }

  if (
    normalizePublicUrl(productValue, publicUrlEnvName) !==
    normalizePublicUrl(adapterValue, "ORIGIN")
  ) {
    throw new Error(`${publicUrlEnvName} conflicts with ORIGIN; configure only one public URL.`);
  }
  return productValue;
}

function resolveTrustProxy(value: string | undefined, host: string): boolean {
  const configured = trimmed(value);
  if (!configured) return false;
  if (configured !== "loopback") {
    throw new Error(`${trustProxyEnvName} currently supports only the value 'loopback'.`);
  }
  if (!isLoopbackBindHost(host)) {
    throw new Error(
      `${trustProxyEnvName}=loopback requires HOST to be localhost, 127.0.0.1, or ::1.`,
    );
  }
  return true;
}

function configureAdapterProxyHeaders(env: Record<string, string | undefined>): void {
  const hops = parseProxyHops(env[proxyHopsEnvName]);
  env.ADDRESS_HEADER = "x-forwarded-for";
  env.PROTOCOL_HEADER = "x-forwarded-proto";
  env.XFF_DEPTH = String(hops);
}

function parseProxyHops(value: string | undefined): number {
  const configured = trimmed(value);
  if (!configured) return 1;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`${proxyHopsEnvName} must be an integer between 1 and 10.`);
  }
  return parsed;
}

function localListenOrigin(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
  const urlHost =
    publicHost.includes(":") && !publicHost.startsWith("[") ? `[${publicHost}]` : publicHost;
  return `http://${urlHost}:${port}`;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
