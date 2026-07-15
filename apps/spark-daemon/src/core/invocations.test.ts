import { describe, expect, it } from "vitest";
import { SparkDaemonInvocationRegistry } from "./invocations.ts";

describe("SparkDaemonInvocationRegistry", () => {
  it("drains existing direct invocations and rejects new ones", async () => {
    const registry = new SparkDaemonInvocationRegistry();
    const active = registry.start({ invocationId: "inv-active", kind: "task.start.request" });

    expect(registry.beginDrain()).toBe(1);
    expect(registry.draining).toBe(true);
    expect(() => registry.start({ invocationId: "inv-new", kind: "task.start.request" })).toThrow(
      /draining/u,
    );

    let idle = false;
    const waiting = registry.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    active.finish();
    await waiting;
    expect(idle).toBe(true);
  });

  it("cancels direct invocations during an explicit daemon stop", async () => {
    const registry = new SparkDaemonInvocationRegistry();
    const active = registry.start({ invocationId: "inv-stop", kind: "task.start.request" });

    expect(registry.stop("operator stop")).toBe(1);
    expect(active.signal.aborted).toBe(true);
    expect(active.signal.reason).toBe("operator stop");

    const idle = registry.waitForIdle();
    active.finish();
    await idle;
    expect(registry.snapshot()).toEqual([]);
  });
});
