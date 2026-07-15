import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createId, prefixedIdSchema } from "./refs.ts";

describe("protocol references", () => {
  it("creates valid IDs through the browser-safe Web Crypto boundary", () => {
    expect(prefixedIdSchema("sess").parse(createId("sess"))).toMatch(/^sess_[a-f0-9]{32}$/);
  });

  it("keeps the shared reference module free of Node-only runtime imports", () => {
    const source = readFileSync(new URL("./refs.ts", import.meta.url), "utf8");
    expect(source).not.toContain('from "node:crypto"');
  });
});
