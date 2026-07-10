import { describe, expect, it } from "vitest";
import {
  isSparkCommandPayloadSource,
  sparkAgentsCockpitSource,
  sparkCommandPayloadSourceOptions,
} from "./command-sources.ts";

describe("Spark command payload sources", () => {
  it("owns the agents cockpit source vocabulary", () => {
    expect(sparkAgentsCockpitSource).toBe("agents-cockpit");
    expect(sparkCommandPayloadSourceOptions).toEqual(["agents-cockpit"]);
    expect(isSparkCommandPayloadSource("agents-cockpit")).toBe(true);
    expect(isSparkCommandPayloadSource("project-chat")).toBe(false);
  });
});
