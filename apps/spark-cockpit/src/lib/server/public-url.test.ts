import { describe, expect, it } from "vitest";
import { configureCockpitPublicUrl, normalizePublicUrl } from "./public-url.js";

describe("Cockpit public URL configuration", () => {
  it("uses a local origin by default", () => {
    const env: Record<string, string | undefined> = {};

    expect(configureCockpitPublicUrl(env, { host: "0.0.0.0", port: 5173 })).toEqual({
      mode: "local",
      publicUrl: "http://127.0.0.1:5173",
      trustedProxy: false,
    });
    expect(env.ORIGIN).toBe("http://127.0.0.1:5173");
  });

  it("normalizes an explicit public domain and preserves ORIGIN compatibility", () => {
    const env: Record<string, string | undefined> = {
      SPARK_COCKPIT_PUBLIC_URL: "https://spark.example.test/",
      SPARK_COCKPIT_TRUST_PROXY: "loopback",
      ORIGIN: "https://spark.example.test",
    };

    expect(configureCockpitPublicUrl(env, { host: "127.0.0.1", port: 5173 })).toEqual({
      mode: "fixed",
      publicUrl: "https://spark.example.test",
      trustedProxy: true,
    });
    expect(env.ORIGIN).toBe("https://spark.example.test");
    expect(env.ADDRESS_HEADER).toBe("x-forwarded-for");
  });

  it("configures a loopback proxy for automatic public URL discovery", () => {
    const env: Record<string, string | undefined> = {
      SPARK_COCKPIT_PUBLIC_URL: "auto",
      SPARK_COCKPIT_TRUST_PROXY: "loopback",
      SPARK_COCKPIT_PROXY_HOPS: "2",
    };

    expect(configureCockpitPublicUrl(env, { host: "127.0.0.1", port: 5173 })).toEqual({
      mode: "proxy",
      publicUrl: null,
      trustedProxy: true,
    });
    expect(env.ORIGIN).toBeUndefined();
    expect(env.ADDRESS_HEADER).toBe("x-forwarded-for");
    expect(env.PROTOCOL_HEADER).toBe("x-forwarded-proto");
    expect(env.XFF_DEPTH).toBe("2");
  });

  it("requires an explicit trusted loopback proxy for remote domains", () => {
    expect(() =>
      configureCockpitPublicUrl(
        { SPARK_COCKPIT_PUBLIC_URL: "https://spark.example.test" },
        { host: "127.0.0.1", port: 5173 },
      ),
    ).toThrow(/SPARK_COCKPIT_TRUST_PROXY=loopback/);
    expect(() =>
      configureCockpitPublicUrl(
        {
          SPARK_COCKPIT_PUBLIC_URL: "auto",
          SPARK_COCKPIT_TRUST_PROXY: "loopback",
        },
        { host: "0.0.0.0", port: 5173 },
      ),
    ).toThrow(/requires HOST to be localhost/);
    expect(() =>
      configureCockpitPublicUrl(
        { SPARK_COCKPIT_PUBLIC_URL: "https://spark.example.test" },
        { host: "0.0.0.0", port: 5173 },
      ),
    ).toThrow(/explicit proxy boundary/);
    expect(() =>
      configureCockpitPublicUrl(
        { SPARK_COCKPIT_PUBLIC_URL: "http://spark.lan:5173" },
        { host: "0.0.0.0", port: 5173 },
      ),
    ).toThrow(/explicit proxy boundary/);
  });

  it("rejects invalid proxy hop counts", () => {
    for (const hops of ["0", "11", "1.5", "many"]) {
      expect(() =>
        configureCockpitPublicUrl(
          {
            SPARK_COCKPIT_PUBLIC_URL: "auto",
            SPARK_COCKPIT_TRUST_PROXY: "loopback",
            SPARK_COCKPIT_PROXY_HOPS: hops,
          },
          { host: "127.0.0.1", port: 5173 },
        ),
      ).toThrow(/integer between 1 and 10/);
    }
  });

  it("rejects ambiguous or unsafe public URL values", () => {
    for (const value of [
      "ftp://spark.example.test",
      "https://user:secret@spark.example.test",
      "https://spark.example.test/cockpit",
      "https://spark.example.test/?token=secret",
      "https://spark.example.test/#fragment",
    ]) {
      expect(() => normalizePublicUrl(value)).toThrow();
    }

    expect(() =>
      configureCockpitPublicUrl(
        {
          SPARK_COCKPIT_PUBLIC_URL: "https://spark.example.test",
          ORIGIN: "https://other.example.test",
        },
        { host: "0.0.0.0", port: 5173 },
      ),
    ).toThrow(/conflicts with ORIGIN/);
  });
});
