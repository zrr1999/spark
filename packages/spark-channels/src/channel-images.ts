import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

export const CHANNEL_IMAGE_MAX_COUNT = 4;
export const CHANNEL_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
export const CHANNEL_IMAGE_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Provider-ready image bytes. URLs remain transport-local and are never persisted. */
export interface ChannelImage {
  data: string;
  mediaType: string;
  name?: string;
}

/** Ephemeral platform media source used only while normalizing one inbound event. */
export interface ChannelImageSource {
  url?: string;
  data?: string;
  mediaType?: string;
  name?: string;
  size?: number;
}

export interface MaterializeChannelImagesOptions {
  /** Trusted test seam; production downloads use a DNS-pinned HTTPS request. */
  fetchImpl?: typeof fetch;
  /** Test seam for DNS policy; every returned address must be publicly routable. */
  lookupHostname?: ChannelImageHostnameLookup;
  maxCount?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  onError?: (error: Error, source: ChannelImageSource) => void;
}

export type ChannelImageHostnameLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

/**
 * Download and validate platform-issued image attachments before durable ingress.
 * Failed individual attachments are omitted so one malformed image cannot poison
 * the platform cursor forever; callers still retain the display-safe descriptor.
 */
export async function materializeChannelImages(
  sources: readonly ChannelImageSource[],
  options: MaterializeChannelImagesOptions = {},
): Promise<ChannelImage[]> {
  const maxCount = positiveLimit(options.maxCount, CHANNEL_IMAGE_MAX_COUNT);
  const maxBytes = positiveLimit(options.maxBytes, CHANNEL_IMAGE_MAX_BYTES);
  const maxTotalBytes = positiveLimit(options.maxTotalBytes, CHANNEL_IMAGE_MAX_TOTAL_BYTES);
  const images: ChannelImage[] = [];
  let totalBytes = 0;

  for (const source of sources.slice(0, maxCount)) {
    try {
      const image = await materializeChannelImage(source, {
        fetchImpl: options.fetchImpl,
        lookupHostname: options.lookupHostname,
        maxBytes: Math.min(maxBytes, maxTotalBytes - totalBytes),
      });
      const bytes = decodedBase64Bytes(image.data);
      if (totalBytes + bytes > maxTotalBytes) {
        throw new Error(`channel image total exceeds ${maxTotalBytes} bytes`);
      }
      totalBytes += bytes;
      images.push(image);
    } catch (error) {
      options.onError?.(toError(error), source);
    }
    if (totalBytes >= maxTotalBytes) break;
  }
  return images;
}

export function normalizeChannelImage(value: unknown): ChannelImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.data !== "string" || typeof record.mediaType !== "string") return undefined;
  try {
    const normalized = normalizeBase64(record.data, CHANNEL_IMAGE_MAX_BYTES);
    const mediaType = normalizeImageMediaType(record.mediaType);
    return {
      data: normalized.data,
      mediaType,
      ...(typeof record.name === "string" && record.name.trim()
        ? { name: record.name.trim().slice(0, 240) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

async function materializeChannelImage(
  source: ChannelImageSource,
  options: {
    fetchImpl?: typeof fetch;
    lookupHostname?: ChannelImageHostnameLookup;
    maxBytes: number;
  },
): Promise<ChannelImage> {
  if (options.maxBytes <= 0) throw new Error("channel image total size limit reached");
  const hasUrl = typeof source.url === "string" && source.url.trim().length > 0;
  const hasData = typeof source.data === "string" && source.data.trim().length > 0;
  if (hasUrl === hasData) {
    throw new Error("channel image requires exactly one of url or data");
  }

  if (hasData) {
    const normalized = normalizeBase64(source.data!, options.maxBytes);
    const mediaType = normalizeImageMediaType(source.mediaType ?? normalized.mediaType);
    return imageResult(normalized.data, mediaType, source.name);
  }

  const response = await fetchImageWithRedirects(
    source.url!,
    options.fetchImpl,
    options.lookupHostname ?? defaultHostnameLookup,
  );
  if (!response.ok) {
    throw new Error(`channel image download failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new Error(`channel image exceeds ${options.maxBytes} bytes`);
  }
  const responseMediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const mediaType = normalizeImageMediaType(responseMediaType || source.mediaType);
  const bytes = await readResponseBytes(response, options.maxBytes);
  return imageResult(Buffer.from(bytes).toString("base64"), mediaType, source.name);
}

async function fetchImageWithRedirects(
  rawUrl: string,
  fetchImpl: typeof fetch | undefined,
  lookupHostname: ChannelImageHostnameLookup,
): Promise<Response> {
  let url = validateRemoteImageUrl(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const resolved = await resolveRemoteImageAddresses(url, lookupHostname);
    const response = fetchImpl
      ? await fetchImpl(url.toString(), { method: "GET", redirect: "manual" })
      : await fetchPinnedHttps(url, resolved);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new Error("channel image redirect limit exceeded");
    url = validateRemoteImageUrl(new URL(location, url).toString());
  }
  throw new Error("channel image redirect limit exceeded");
}

function validateRemoteImageUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("channel image URL must use HTTPS");
  if (url.username || url.password)
    throw new Error("channel image URL must not contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isReservedIp(hostname)
  ) {
    throw new Error("channel image URL must not target a local or private address");
  }
  return url;
}

async function resolveRemoteImageAddresses(
  url: URL,
  lookupHostname: ChannelImageHostnameLookup,
): Promise<readonly LookupAddress[]> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupHostname(hostname);
  if (resolved.length === 0) {
    throw new Error("channel image hostname did not resolve to an address");
  }

  const addresses: LookupAddress[] = [];
  const seen = new Set<string>();
  for (const record of resolved) {
    const family = isIP(record.address);
    if ((family !== 4 && family !== 6) || isReservedIp(record.address)) {
      throw new Error("channel image URL must not target a local or private address");
    }
    const key = `${family}:${record.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ address: record.address, family });
  }
  return addresses;
}

async function defaultHostnameLookup(hostname: string): Promise<readonly LookupAddress[]> {
  return await dnsLookup(hostname, { all: true, order: "verbatim" });
}

/**
 * Pin each production connection to the addresses accepted above. A second DNS
 * lookup inside `fetch` would reopen a check/use window to DNS rebinding.
 */
function fetchPinnedHttps(url: URL, addresses: readonly LookupAddress[]): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent: false,
        method: "GET",
        lookup: pinnedLookup(addresses),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : (Readable.toWeb(incoming) as unknown as BodyInit);
        try {
          resolve(
            new Response(body, {
              headers: incoming.headers as HeadersInit,
              status,
              statusText: incoming.statusMessage,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const matching = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (matching.length === 0) {
      const error = new Error("channel image hostname has no address for the requested family");
      Object.assign(error, { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, [...matching]);
      return;
    }
    callback(null, matching[0]!.address, matching[0]!.family);
  };
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel("channel image size limit exceeded").catch(() => undefined);
      throw new Error(`channel image exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizeBase64(raw: string, maxBytes: number): { data: string; mediaType?: string } {
  const trimmed = raw.trim();
  const dataUrl = /^data:([^;,]+);base64,(.+)$/isu.exec(trimmed);
  const mediaType = dataUrl?.[1]?.trim();
  const data = (dataUrl?.[2] ?? trimmed).replace(/\s+/gu, "");
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 === 1) {
    throw new Error("channel image contains invalid base64 data");
  }
  const bytes = decodedBase64Bytes(data);
  if (bytes <= 0 || bytes > maxBytes) {
    throw new Error(`channel image must contain 1-${maxBytes} bytes`);
  }
  return { data, ...(mediaType ? { mediaType } : {}) };
}

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function normalizeImageMediaType(value: string | undefined): string {
  const normalized =
    value?.trim().toLowerCase() === "image/jpg" ? "image/jpeg" : value?.trim().toLowerCase();
  if (!normalized || !SUPPORTED_IMAGE_MEDIA_TYPES.has(normalized)) {
    throw new Error(`unsupported channel image media type: ${value ?? "missing"}`);
  }
  return normalized;
}

function imageResult(data: string, mediaType: string, name: string | undefined): ChannelImage {
  return {
    data,
    mediaType,
    ...(name?.trim() ? { name: name.trim().slice(0, 240) } : {}),
  };
}

function isReservedIp(hostname: string): boolean {
  const family = isIP(hostname);
  return family === 4
    ? RESERVED_IMAGE_ADDRESSES.check(hostname, "ipv4")
    : family === 6
      ? RESERVED_IMAGE_ADDRESSES.check(hostname, "ipv6")
      : false;
}

const RESERVED_IMAGE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  RESERVED_IMAGE_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  RESERVED_IMAGE_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
