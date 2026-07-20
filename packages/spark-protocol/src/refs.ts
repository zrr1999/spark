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

export const isoDateTimeSchema = z.string().datetime({ offset: true });
