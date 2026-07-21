import { z } from "zod";

export const idPrefixSchema = z.enum([
  "usr",
  "sess",
  "ws",
  "watok",
  "catok",
  "proj",
  "res",
  "agent",
  "rt",
  "rtetok",
  "rtda",
  "rttok",
  "rtsn",
  "rtwb",
  "wob",
  "wpsrc",
  "wpga",
  "cmd",
  "deliv",
  "hreq",
  "hres",
  "inbox",
  "ask",
  "review",
  "tgs",
  "tgt",
  "task",
  "dep",
  "inv",
  "evt",
  "log",
  "art",
  "link",
  "blob",
  "msg",
  "idem",
  "eph",
  "asn",
]);

export type IdPrefix = z.infer<typeof idPrefixSchema>;

const idBodyPattern = "[a-f0-9]{32}";

export function prefixedIdSchema(prefix: IdPrefix) {
  return z.string().regex(new RegExp(`^${prefix}_${idBodyPattern}$`));
}

export const anyPrefixedIdSchema = z.string().regex(/^[a-z]+_[a-f0-9]{32}$/);

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Normalize an idempotency seed to the wire-safe `idem_<32 hex>` form.
 * Already-valid keys pass through unchanged; other seeds hash deterministically.
 */
export function wireIdempotencyKey(seed: string): string {
  const trimmed = seed.trim();
  if (prefixedIdSchema("idem").safeParse(trimmed).success) return trimmed;
  return `idem_${digest32Hex(trimmed)}`;
}

export function optionalWireIdempotencyKey(seed?: string | null): string | undefined {
  if (seed == null) return undefined;
  const trimmed = seed.trim();
  if (!trimmed) return undefined;
  return wireIdempotencyKey(trimmed);
}

function digest32Hex(seed: string): string {
  const bytes = new TextEncoder().encode(seed);
  let out = "";
  for (let lane = 0; lane < 4; lane += 1) {
    let hash = 0x811c9dc5 ^ lane;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export const isoDateTimeSchema = z.string().datetime({ offset: true });
