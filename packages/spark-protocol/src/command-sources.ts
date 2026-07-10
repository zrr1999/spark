export const sparkAgentsCockpitSource = "agents-cockpit" as const;

export const sparkCommandPayloadSourceOptions = [sparkAgentsCockpitSource] as const;

export type SparkCommandPayloadSource = (typeof sparkCommandPayloadSourceOptions)[number];

export function isSparkCommandPayloadSource(value: unknown): value is SparkCommandPayloadSource {
  return sparkCommandPayloadSourceOptions.includes(value as SparkCommandPayloadSource);
}
