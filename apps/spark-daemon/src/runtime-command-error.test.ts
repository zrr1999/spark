import { describe, expect, it } from "vitest";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";

import { runtimeCommandFailure } from "./runtime-command-error.ts";

describe("runtime command failure projection", () => {
  it("preserves typed Side Thread errors for remote projections", () => {
    expect(
      runtimeCommandFailure(
        new SparkSessionRegistryError("side_thread_not_found", "no active child"),
      ),
    ).toEqual({ reasonCode: "side_thread_not_found", message: "no active child" });
  });

  it("does not expose arbitrary internal error codes", () => {
    expect(runtimeCommandFailure(new SparkSessionRegistryError("sqlite_busy", "busy"))).toEqual({
      reasonCode: "COMMAND_EXECUTION_FAILED",
      message: "busy",
    });
  });
});
