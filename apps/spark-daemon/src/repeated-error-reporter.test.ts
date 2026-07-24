import { describe, expect, it } from "vitest";
import { createRepeatedErrorReporter } from "./repeated-error-reporter.ts";

describe("createRepeatedErrorReporter", () => {
  it("reports first and changed failures while bounding identical repeats", () => {
    let now = 0;
    const logs: Array<{ message: string; error?: unknown }> = [];
    const reporter = createRepeatedErrorReporter("reconcile failed", {
      intervalMs: 10_000,
      now: () => now,
      log: (message, error) => logs.push({ message, error }),
    });
    const repeated = new Error("poison mailbox");

    reporter.report(repeated);
    reporter.report(repeated);
    reporter.report(new Error("poison mailbox"));
    expect(logs).toHaveLength(1);

    now = 10_000;
    reporter.report(repeated);
    expect(logs.map((entry) => entry.message)).toEqual([
      "reconcile failed",
      "reconcile failed; suppressed 2 repeated failures during the previous interval",
      "reconcile failed",
    ]);

    reporter.report(new Error("gateway unavailable"));
    expect(logs.at(-1)?.message).toBe("reconcile failed");
    reporter.report(new Error("gateway unavailable"));
    reporter.recovered();
    expect(logs.at(-1)?.message).toBe(
      "reconcile failed; suppressed 1 repeated failures before recovery",
    );
  });

  it("flushes a bounded summary during shutdown", () => {
    const messages: string[] = [];
    const reporter = createRepeatedErrorReporter("worker failed", {
      log: (message) => messages.push(message),
    });
    reporter.report("offline");
    reporter.report("offline");
    reporter.flush();
    reporter.flush();
    expect(messages).toEqual([
      "worker failed",
      "worker failed; suppressed 1 repeated failures before shutdown",
    ]);
  });
});
