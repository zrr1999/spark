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

void test("compareSemver orders release tags numerically", () => {
  const cases: Array<[left: string, right: string, expected: number, message?: string]> = [
    ["0.1.0", "0.1.0", 0],
    ["0.0.9", "0.1.0", -1],
    ["0.1.0", "0.0.9", 1],
    ["0.10.0", "0.9.0", 1, "numeric, not lexicographic"],
    ["v0.1.0", "0.1.0", 0, "tolerates leading 'v'"],
    ["0.1", "0.1.0", -1],
    ["0.1.0", "0.1", 1],
  ];

  for (const [left, right, expected, message] of cases) {
    if (message) assert.equal(compareSemver(left, right), expected, message);
    else assert.equal(compareSemver(left, right), expected);
  }
});

void test("classifyDaemonVersion handles match, no-latest, outdated, and unknown cases", () => {
  const cases = [
    {
      name: "reported daemon with unknown latest is silent",
      daemon: { kind: "reported" as const, version: "0.1.0" },
      latest: null,
      expected: { kind: "match" },
    },
    {
      name: "unknown daemon and unknown latest is no-latest",
      daemon: { kind: "unknown" as const },
      latest: null,
      expected: { kind: "no-latest", daemon: { kind: "unknown" } },
      renderedWarning: null,
    },
    {
      name: "reported daemon older than latest is outdated",
      daemon: { kind: "reported" as const, version: "0.0.9" },
      latest: "0.1.0",
      expected: {
        kind: "outdated",
        daemon: { kind: "reported", version: "0.0.9" },
        latest: "0.1.0",
      },
    },
    {
      name: "reported daemon at latest is a match",
      daemon: { kind: "reported" as const, version: "0.1.0" },
      latest: "0.1.0",
      expected: { kind: "match" },
    },
    {
      name: "reported daemon ahead of latest is a match",
      daemon: { kind: "reported" as const, version: "0.2.0" },
      latest: "0.1.0",
      expected: { kind: "match" },
    },
    {
      name: "unknown daemon with known latest is actionable",
      daemon: { kind: "unknown" as const },
      latest: "0.1.0",
      expected: { kind: "unknown-running", latest: "0.1.0" },
    },
  ];

  for (const { name, daemon, latest, expected, renderedWarning } of cases) {
    const verdict = classifyDaemonVersion(daemon, latest);
    assert.deepEqual(verdict, expected, name);
    if (renderedWarning !== undefined) {
      assert.equal(renderCuedVersionWarning(verdict), renderedWarning, name);
    }
  }
});

void test("renderCuedVersionWarning renders only actionable warnings", () => {
  assert.equal(renderCuedVersionWarning({ kind: "match" }), null);
  assert.equal(renderCuedVersionWarning({ kind: "no-latest", daemon: { kind: "unknown" } }), null);

  const outdated = renderCuedVersionWarning({
    kind: "outdated",
    daemon: { kind: "reported", version: "0.0.9" },
    latest: "0.1.0",
  });
  assert.ok(outdated);
  for (const pattern of [
    /cued 0\.0\.9 is older than latest cue-shell release 0\.1\.0/,
    /cued upgrade/,
    /cued restart/,
    /PI_CUE_NO_VERSION_CHECK/,
  ]) {
    assert.match(outdated, pattern);
  }

  const unknownRunning = renderCuedVersionWarning({ kind: "unknown-running", latest: "0.1.0" });
  assert.ok(unknownRunning);
  assert.match(unknownRunning, /does not report its version/);
  assert.match(unknownRunning, /latest cue-shell release is 0\.1\.0/);
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
