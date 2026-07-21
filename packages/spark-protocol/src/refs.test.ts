import { describe, expect, it } from "vitest";

import {
  createId,
  optionalWireIdempotencyKey,
  prefixedIdSchema,
  wireIdempotencyKey,
} from "./refs.ts";

describe("protocol references", () => {
  it("creates valid IDs through the browser-safe Web Crypto boundary", () => {
    expect(prefixedIdSchema("sess").parse(createId("sess"))).toMatch(/^sess_[a-f0-9]{32}$/);
  });

  it("maps friendly idempotency seeds to wire-safe idem_ keys", () => {
    const wire = wireIdempotencyKey("approval:hreq_abc:approve");
    expect(wire).toMatch(/^idem_[a-f0-9]{32}$/);
    expect(wireIdempotencyKey(wire)).toBe(wire);
    expect(wireIdempotencyKey("approval:hreq_abc:approve")).toBe(wire);
    expect(optionalWireIdempotencyKey("  ")).toBeUndefined();
    expect(optionalWireIdempotencyKey(null)).toBeUndefined();
  });
});
