import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  CockpitAccessTokenError,
  consumeCockpitAccessToken,
  createCockpitAccessToken,
  hasActiveCockpitAccessTokens,
  listCockpitAccessTokens,
  revokeCockpitAccessToken,
} from "./cockpit-access";

const createdAt = "2026-07-20T00:00:00.000Z";

describe("cockpit browser access", () => {
  it("stores only a hash and consumes a key exactly once", () => {
    const db = createDatabase();
    const created = createCockpitAccessToken(db, {
      label: "Remote operator",
      createdAt,
      ttlMs: 60_000,
    });

    const stored = db
      .prepare("SELECT token_hash AS tokenHash FROM cockpit_access_tokens WHERE id = ?")
      .get(created.id) as { tokenHash: string };
    expect(created.token).toMatch(/^spark_cockpit_auth_/);
    expect(stored.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(listCockpitAccessTokens(db))).not.toContain(created.token);
    expect(hasActiveCockpitAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(true);

    expect(consumeCockpitAccessToken(db, created.token, "2026-07-20T00:00:30.000Z")).toMatchObject({
      tokenId: created.id,
    });
    expect(hasActiveCockpitAccessTokens(db, "2026-07-20T00:00:30.000Z")).toBe(false);
    expectCockpitAccessError(
      () => consumeCockpitAccessToken(db, created.token, "2026-07-20T00:00:31.000Z"),
      "COCKPIT_ACCESS_TOKEN_USED",
    );
    db.close();
  });

  it("rejects revoked and expired keys", () => {
    const db = createDatabase();
    const revoked = createCockpitAccessToken(db, {
      createdAt,
      ttlMs: 60_000,
    });
    expect(
      revokeCockpitAccessToken(db, {
        tokenId: revoked.id,
        revokedAt: "2026-07-20T00:00:10.000Z",
      }),
    ).toBe(true);
    expectCockpitAccessError(
      () => consumeCockpitAccessToken(db, revoked.token, "2026-07-20T00:00:20.000Z"),
      "COCKPIT_ACCESS_TOKEN_REVOKED",
    );

    const expired = createCockpitAccessToken(db, {
      createdAt,
      ttlMs: 1_000,
    });
    expectCockpitAccessError(
      () => consumeCockpitAccessToken(db, expired.token, "2026-07-20T00:00:01.000Z"),
      "COCKPIT_ACCESS_TOKEN_EXPIRED",
    );
    db.close();
  });
});

function createDatabase() {
  const db = openMemoryDatabase();
  migrate(db);
  return db;
}

function expectCockpitAccessError(action: () => unknown, reasonCode: string) {
  try {
    action();
    throw new Error("Expected cockpit access error.");
  } catch (error) {
    expect(error).toBeInstanceOf(CockpitAccessTokenError);
    expect(error).toMatchObject({ reasonCode });
  }
}
