export const SPARK_UPDATE_STATE_SCHEMA_VERSION = 1;

export type SparkUpdatePolicy = "manual" | "notify" | "auto";
export type SparkUpdateChannel = "latest" | "next";

export interface SparkBuildInfo {
  schemaVersion: 1;
  packageName: "@zendev-lab/spark";
  version: string;
  gitSha: string;
  protocolVersion: number;
  minimumNodeVersion: string;
  migrationHead: string;
  migrationMode: "expand-only" | "manual";
  fingerprint: string;
}

export interface SparkReleaseManifest {
  schemaVersion: 1;
  packageName: "@zendev-lab/spark";
  version: string;
  npmTag: SparkUpdateChannel;
  npmIntegrity: string;
  assetName: string;
  assetSha256: string;
  gitSha: string;
  buildFingerprint: string;
  minimumUpdaterVersion: string;
  rollbackCompatibility: string;
  migrationMode: "expand-only" | "manual";
}

export interface SparkUpdateConfig {
  policy: SparkUpdatePolicy;
  channel: SparkUpdateChannel;
  checkIntervalHours: number;
}

export interface SparkQuarantinedVersion {
  version: string;
  reason: string;
  quarantinedAt: string;
}

export interface SparkUpdateFailure {
  version?: string;
  code: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
  nextRetryAt: string;
  lastLoggedAt?: string;
  lastNotifiedAt?: string;
}

export interface SparkUpdateState {
  schemaVersion: 1;
  currentVersion?: string;
  currentFingerprint?: string;
  availableVersion?: string;
  pendingVersion?: string;
  pendingFingerprint?: string;
  lastGoodVersion?: string;
  lastGoodFingerprint?: string;
  rollbackVersion?: string;
  rollbackFingerprint?: string;
  lastCheckAt?: string;
  registryEtag?: string;
  lastAvailableNotifiedVersion?: string;
  lastAvailableNotifiedAt?: string;
  quarantined: SparkQuarantinedVersion[];
  failure?: SparkUpdateFailure;
}

export interface SparkUpdatePaths {
  versionsDir: string;
  currentLink: string;
  configFile: string;
  stateDir: string;
  stateFile: string;
  lockFile: string;
  cacheDir: string;
  stagingDir: string;
  launcherPath: string;
  updaterLaunchAgentPath: string;
}

export interface SparkUpdateStatus {
  managed: boolean;
  config: SparkUpdateConfig;
  state: SparkUpdateState;
  paths: SparkUpdatePaths;
  repairCommand?: string;
}
