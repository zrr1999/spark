/**
 * Canonical Spark protocol version surface.
 *
 * View-model and interaction payloads use `SPARK_PROTOCOL_VERSION` (numeric).
 * Runtime WebSocket envelopes use `runtimeProtocolVersion` (string semver tag).
 */

import { runtimeProtocolVersion } from "./runtime-v1/envelope.ts";

/** Numeric schema version for view-model / daemon event payloads. */
export const SPARK_PROTOCOL_VERSION = 1 as const;

/** Runtime WebSocket control-plane protocol identifier. */
export const SPARK_RUNTIME_PROTOCOL_VERSION = runtimeProtocolVersion;

export type SparkProtocolVersion = typeof SPARK_PROTOCOL_VERSION;
export type SparkRuntimeProtocolVersion = typeof SPARK_RUNTIME_PROTOCOL_VERSION;

export interface SparkProtocolVersionInfo {
  viewModelVersion: SparkProtocolVersion;
  runtimeVersion: SparkRuntimeProtocolVersion;
}

export function currentSparkProtocolVersions(): SparkProtocolVersionInfo {
  return {
    viewModelVersion: SPARK_PROTOCOL_VERSION,
    runtimeVersion: SPARK_RUNTIME_PROTOCOL_VERSION,
  };
}

export function assertSparkProtocolVersion(
  version: unknown,
  options: { label?: string } = {},
): asserts version is SparkProtocolVersion {
  if (version !== SPARK_PROTOCOL_VERSION) {
    const label = options.label ? `${options.label}: ` : "";
    throw new Error(
      `${label}unsupported Spark protocol version ${String(version)}; expected ${SPARK_PROTOCOL_VERSION}`,
    );
  }
}

export function assertSparkRuntimeProtocolVersion(
  version: unknown,
  options: { label?: string } = {},
): asserts version is SparkRuntimeProtocolVersion {
  if (version !== SPARK_RUNTIME_PROTOCOL_VERSION) {
    const label = options.label ? `${options.label}: ` : "";
    throw new Error(
      `${label}unsupported Spark runtime protocol version ${String(version)}; expected ${SPARK_RUNTIME_PROTOCOL_VERSION}`,
    );
  }
}

export function isSparkRuntimeProtocolVersion(
  version: unknown,
): version is SparkRuntimeProtocolVersion {
  return version === SPARK_RUNTIME_PROTOCOL_VERSION;
}
