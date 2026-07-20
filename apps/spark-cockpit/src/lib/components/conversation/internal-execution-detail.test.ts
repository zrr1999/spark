import { describe, expect, it } from "vitest";

import { isInternalExecutionTransportFailure } from "./internal-execution-detail";

describe("internal execution detail classification", () => {
  it("hides only cue transport plumbing failures", () => {
    expect(
      isInternalExecutionTransportFailure(
        "cue-shell error [TRANSPORT_RESOLVE_FAILED]: failed to resolve cue-shell client transport",
        "cue_exec",
      ),
    ).toBe(true);
  });

  it("keeps user-relevant cue failures and unrelated transport failures visible", () => {
    expect(isInternalExecutionTransportFailure("command exited with status 1", "cue_exec")).toBe(
      false,
    );
    expect(
      isInternalExecutionTransportFailure(
        "TRANSPORT_RESOLVE_FAILED while connecting to the deployment API",
        "shell",
      ),
    ).toBe(false);
  });
});
