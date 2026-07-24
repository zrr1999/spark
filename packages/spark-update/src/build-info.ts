import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

import type { SparkBuildInfo } from "./types.ts";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function readSparkBuildInfo(
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): SparkBuildInfo {
  const env = options.env ?? process.env;
  for (const candidate of buildInfoCandidates(env, options.cwd)) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
    if (isSparkBuildInfo(parsed)) return parsed;
  }
  const manifestPath = join(SOURCE_ROOT, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
    engines?: { node?: unknown };
  };
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const minimumNodeVersion =
    typeof manifest.engines?.node === "string" ? manifest.engines.node : ">=26.0.0 <27";
  return {
    schemaVersion: 1,
    packageName: "@zendev-lab/spark",
    version,
    gitSha: env.SPARK_BUILD_GIT_SHA?.trim() || "source-checkout",
    protocolVersion: SPARK_PROTOCOL_VERSION,
    minimumNodeVersion,
    migrationHead: "source-checkout",
    migrationMode: "expand-only",
    fingerprint: createBuildFingerprint({
      version,
      gitSha: env.SPARK_BUILD_GIT_SHA?.trim() || "source-checkout",
      protocolVersion: SPARK_PROTOCOL_VERSION,
      migrationHead: "source-checkout",
    }),
  };
}

export function createBuildFingerprint(input: {
  version: string;
  gitSha: string;
  protocolVersion: number;
  migrationHead: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      [input.version, input.gitSha, String(input.protocolVersion), input.migrationHead].join("\n"),
    )
    .digest("hex")}`;
}

export function isSparkBuildInfo(value: unknown): value is SparkBuildInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SparkBuildInfo>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.packageName === "@zendev-lab/spark" &&
    typeof candidate.version === "string" &&
    typeof candidate.gitSha === "string" &&
    typeof candidate.protocolVersion === "number" &&
    typeof candidate.minimumNodeVersion === "string" &&
    typeof candidate.migrationHead === "string" &&
    (candidate.migrationMode === "expand-only" || candidate.migrationMode === "manual") &&
    typeof candidate.fingerprint === "string"
  );
}

function buildInfoCandidates(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): string[] {
  return [
    env.SPARK_BUILD_INFO_PATH,
    env.SPARK_PRODUCT_DIST ? join(env.SPARK_PRODUCT_DIST, "build-info.json") : undefined,
    join(cwd, "dist", "build-info.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}
