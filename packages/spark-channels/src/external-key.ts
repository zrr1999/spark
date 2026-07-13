import {
  normalizeChannelExternalKey,
  type SparkChannelAdapter,
} from "@zendev-lab/spark-protocol/session-assignment";

const defaultScopes: Record<SparkChannelAdapter, string> = {
  feishu: "chat",
  infoflow: "user",
  qqbot: "c2c",
};

/** Build a protocol-normalized external key: `feishu:chat:<id>`, `infoflow:user:<id>`, … */
export function createChannelExternalKey(
  adapter: SparkChannelAdapter,
  scope: string,
  id: string,
): string {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw new Error("channel external id must be non-empty");
  }
  return normalizeChannelExternalKey(`${adapter}:${scope}:${trimmedId}`);
}

export function defaultChannelScope(adapter: SparkChannelAdapter): string {
  return defaultScopes[adapter];
}

export function createDefaultChannelExternalKey(adapter: SparkChannelAdapter, id: string): string {
  return createChannelExternalKey(adapter, defaultChannelScope(adapter), id);
}
