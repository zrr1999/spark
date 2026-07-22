import { describe, expect, it } from "vitest";
import {
  SPARK_AGENT_LOOP_EVENT_TYPES,
  SPARK_HOST_BUILTIN_EVENT_NAMES,
  SPARK_RUN_OUTCOME_STATUSES,
  SPARK_SESSION_ACTIVITY_PHASES,
  sparkViewModelStatusSchema,
} from "./index.ts";

describe("host / turn / view event vocabularies", () => {
  it("keeps session activity phases inside view-model status", () => {
    const viewStatuses = new Set(sparkViewModelStatusSchema.options);
    for (const phase of SPARK_SESSION_ACTIVITY_PHASES) {
      expect(viewStatuses.has(phase)).toBe(true);
    }
  });

  it("exports non-empty stable host and turn event vocabularies", () => {
    expect(SPARK_HOST_BUILTIN_EVENT_NAMES.length).toBeGreaterThan(0);
    expect(SPARK_AGENT_LOOP_EVENT_TYPES).toContain("view_event");
    expect(SPARK_AGENT_LOOP_EVENT_TYPES).toContain("run_outcome");
    expect(SPARK_RUN_OUTCOME_STATUSES).toEqual(["completed", "aborted", "failed"]);
  });
});
