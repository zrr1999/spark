import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SessionStatusBar from "./SessionStatusBar.svelte";
import type { SessionStatusBarLabels } from "./session-status";

const labels: SessionStatusBarLabels = {
  bar: "Session runtime status",
  workingDirectory: "Working directory",
  branch: "Git branch",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache read tokens",
  cacheWriteTokens: "Cache write tokens",
  cacheHit: "Latest cache hit",
  cost: "Cost",
  context: "Context usage",
};

describe("SessionStatusBar", () => {
  it("renders workspace and usage truth with localized accessible detail", () => {
    const { body } = render(SessionStatusBar, {
      props: {
        labels,
        cwd: "~/workspace/zrr1999/spark",
        gitBranch: "main",
        inputTokens: 19_000,
        outputTokens: 820,
        cacheReadTokens: 230_000,
        cacheWriteTokens: 1_500,
        latestCacheHitPercent: 99.3,
        costUsd: 0.0235,
        contextTokens: 129_000,
        contextWindow: 258_000,
      },
    });

    expect(body).toContain('aria-label="Session runtime status"');
    expect(body).toContain("~/workspace/zrr1999/spark");
    expect(body).toContain("(main)");
    expect(body).toContain("↑19k");
    expect(body).toContain("↓820");
    expect(body).toContain("R230k");
    expect(body).toContain("W1.5k");
    expect(body).toContain("CH99.3%");
    expect(body).toContain("$0.0235");
    expect(body).toContain("Context usage: 50%/258k");
  });

  it("keeps context usage visible without presenting automatic compaction mode", () => {
    const { body } = render(SessionStatusBar, {
      props: {
        labels,
        cwd: "~/workspace/zrr1999/spark",
        contextTokens: 258_000,
        contextWindow: 258_000,
      },
    });

    expect(body).toContain("100%/258k");
    expect(body).not.toContain("(auto)");
  });

  it("omits the usage region when no usage is available", () => {
    const { body } = render(SessionStatusBar, {
      props: {
        labels,
        cwd: "~/workspace/zrr1999/spark",
      },
    });

    expect(body).toContain("~/workspace/zrr1999/spark");
    expect(body).not.toContain("usage-context");
  });
});
