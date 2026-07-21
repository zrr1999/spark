import { describe, expect, it } from "vitest";

import { createId, prefixedIdSchema } from "./refs.ts";

describe("protocol references", () => {
  it("creates valid IDs through the browser-safe Web Crypto boundary", () => {
    expect(prefixedIdSchema("sess").parse(createId("sess"))).toMatch(/^sess_[a-f0-9]{32}$/);
  });
});
