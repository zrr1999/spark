import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetVersionCheckForTests,
  checkCuedVersionAndWarn,
  classifyDaemonVersion,
  compareSemver,
  renderCuedVersionWarning,
} from "../packages/pi-cue/src/index.ts";
import type { CueClient } from "../packages/pi-cue/src/index.ts";

interface FakeClient {
  pingForVersion: () => Promise<string | null>;
}

function asClient(fake: FakeClient): CueClient {
  return fake as unknown as CueClient;
}

void test("compareSemver orders dotted release tags numerically", () => {
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
  assert.equal(compareSemver("0.0.9", "0.1.0"), -1);
  assert.equal(compareSemver("0.1.0", "0.0.9"), 1);
  assert.equal(compareSemver("0.10.0", "0.9.0"), 1, "numeric, not lexicographic");
  assert.equal(compareSemver("v0.1.0", "0.1.0"), 0, "tolerates leading 'v'");
});

void test("compareSemver handles uneven part counts", () => {
  assert.equal(compareSemver("0.1", "0.1.0"), -1);
  assert.equal(compareSemver("0.1.0", "0.1"), 1);
});

void test("classifyDaemonVersion is silent when latest is unknown and daemon reports", () => {
  const verdict = classifyDaemonVersion({ kind: "reported", version: "0.1.0" }, null);
  assert.deepEqual(verdict, { kind: "match" });
});

void test("classifyDaemonVersion stays silent for unknown daemon when latest is also unknown", () => {
  // Without an upstream reference we cannot make an actionable claim.
  const verdict = classifyDaemonVersion({ kind: "unknown" }, null);
  assert.deepEqual(verdict, { kind: "no-latest", daemon: { kind: "unknown" } });
  assert.equal(renderCuedVersionWarning(verdict), null);
});

void test("classifyDaemonVersion flags reported daemons older than latest", () => {
  const verdict = classifyDaemonVersion({ kind: "reported", version: "0.0.9" }, "0.1.0");
  assert.deepEqual(verdict, {
    kind: "outdated",
    daemon: { kind: "reported", version: "0.0.9" },
    latest: "0.1.0",
  });
});

void test("classifyDaemonVersion stays silent when daemon is at or above latest", () => {
  assert.deepEqual(classifyDaemonVersion({ kind: "reported", version: "0.1.0" }, "0.1.0"), {
    kind: "match",
  });
  // Local dev builds can be ahead of the last published release; do not
  // nag developers in that case.
  assert.deepEqual(classifyDaemonVersion({ kind: "reported", version: "0.2.0" }, "0.1.0"), {
    kind: "match",
  });
});

void test("classifyDaemonVersion flags unknown daemon when latest is known", () => {
  const verdict = classifyDaemonVersion({ kind: "unknown" }, "0.1.0");
  assert.deepEqual(verdict, { kind: "unknown-running", latest: "0.1.0" });
});

void test("renderCuedVersionWarning returns null for match and no-latest", () => {
  assert.equal(renderCuedVersionWarning({ kind: "match" }), null);
  assert.equal(renderCuedVersionWarning({ kind: "no-latest", daemon: { kind: "unknown" } }), null);
});

void test("renderCuedVersionWarning explains outdated daemons", () => {
  const text = renderCuedVersionWarning({
    kind: "outdated",
    daemon: { kind: "reported", version: "0.0.9" },
    latest: "0.1.0",
  });
  assert.ok(text);
  assert.match(text, /cued 0\.0\.9 is older than latest cue-shell release 0\.1\.0/);
  assert.match(text, /cued upgrade/);
  assert.match(text, /cued restart/);
  assert.match(text, /PI_CUE_NO_VERSION_CHECK/);
});

void test("renderCuedVersionWarning explains unknown-running with known latest", () => {
  const text = renderCuedVersionWarning({ kind: "unknown-running", latest: "0.1.0" });
  assert.ok(text);
  assert.match(text, /does not report its version/);
  assert.match(text, /latest cue-shell release is 0\.1\.0/);
});

void test("checkCuedVersionAndWarn warns once when daemon is older than upstream", async () => {
  __resetVersionCheckForTests();
  const messages: Array<{ message: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        messages.push({ message, level });
      },
    },
  };
  const fake = asClient({
    async pingForVersion() {
      return "0.0.9";
    },
  });

  const first = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });
  const second = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });

  assert.equal(first?.kind, "outdated");
  assert.equal(second, null, "second call should be a no-op");
  assert.equal(messages.length, 1, "warning should fire exactly once per process");
  assert.equal(messages[0]?.level, "warning");
  assert.match(messages[0]?.message ?? "", /0\.0\.9.*0\.1\.0/);
});

void test("checkCuedVersionAndWarn warns when daemon hides version and upstream is known", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      return null;
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });
  assert.deepEqual(verdict, { kind: "unknown-running", latest: "0.1.0" });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /does not report its version/);
});

void test("checkCuedVersionAndWarn stays silent when upstream lookup fails and daemon reports", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      return "0.0.9";
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: null });
  assert.deepEqual(verdict, { kind: "match" });
  assert.deepEqual(messages, []);
});

void test("checkCuedVersionAndWarn stays silent when both daemon and upstream are unknown", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      return null;
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: null });
  assert.equal(verdict?.kind, "no-latest");
  assert.deepEqual(messages, []);
});

void test("checkCuedVersionAndWarn stays silent when daemon is at the latest release", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      return "0.1.0";
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });
  assert.deepEqual(verdict, { kind: "match" });
  assert.deepEqual(messages, []);
});

void test("checkCuedVersionAndWarn falls back to console.warn without ui.notify", async () => {
  __resetVersionCheckForTests();
  const fake = asClient({
    async pingForVersion() {
      return "0.0.9";
    },
  });
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => {
    captured.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await checkCuedVersionAndWarn(fake, undefined, { latest: "0.1.0" });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0] ?? "", /older than latest cue-shell release/);
});

void test("checkCuedVersionAndWarn swallows transport errors", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      throw new Error("boom");
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });
  assert.equal(verdict, null);
  assert.deepEqual(messages, []);
});

void test("checkCuedVersionAndWarn swallows latest-lookup errors", async () => {
  __resetVersionCheckForTests();
  const messages: string[] = [];
  const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
  const fake = asClient({
    async pingForVersion() {
      return "0.0.9";
    },
  });
  const verdict = await checkCuedVersionAndWarn(fake, ctx, {
    latest: async () => {
      throw new Error("network down");
    },
  });
  // Lookup failed → treat as unknown latest → silent for a reporting daemon.
  assert.deepEqual(verdict, { kind: "match" });
  assert.deepEqual(messages, []);
});

void test("PI_CUE_NO_VERSION_CHECK disables the check entirely", async () => {
  __resetVersionCheckForTests();
  const previous = process.env.PI_CUE_NO_VERSION_CHECK;
  process.env.PI_CUE_NO_VERSION_CHECK = "1";
  try {
    const messages: string[] = [];
    const ctx = { ui: { notify: (msg: string) => messages.push(msg) } };
    const fake = asClient({
      async pingForVersion() {
        return "0.0.9";
      },
    });
    const verdict = await checkCuedVersionAndWarn(fake, ctx, { latest: "0.1.0" });
    assert.equal(verdict, null);
    assert.deepEqual(messages, []);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CUE_NO_VERSION_CHECK;
    } else {
      process.env.PI_CUE_NO_VERSION_CHECK = previous;
    }
    __resetVersionCheckForTests();
  }
});
