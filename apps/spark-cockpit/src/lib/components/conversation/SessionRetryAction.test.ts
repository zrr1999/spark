import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import SessionRetryAction from "./SessionRetryAction.svelte";

describe("SessionRetryAction", () => {
  it("renders one conversation-level retry control", () => {
    const { body } = render(SessionRetryAction, {
      props: {
        label: "Retry last turn",
        submittingLabel: "Retrying",
        unavailableLabel: "Retry unavailable",
        onRetry: vi.fn(),
      },
    });

    expect(body.match(/data-session-retry-action/g)).toHaveLength(1);
    expect(body).toMatch(/<button\b[^>]*type="button"/);
    expect(body).toContain("Retry last turn");
  });

  it("disables the same control while submitting or unavailable", () => {
    const submitting = render(SessionRetryAction, {
      props: {
        label: "Retry last turn",
        submittingLabel: "Retrying",
        unavailableLabel: "Retry unavailable",
        submitting: true,
        onRetry: vi.fn(),
      },
    }).body;
    const unavailable = render(SessionRetryAction, {
      props: {
        label: "Retry last turn",
        submittingLabel: "Retrying",
        unavailableLabel: "Retry unavailable",
        disabled: true,
        onRetry: vi.fn(),
      },
    }).body;

    expect(submitting).toMatch(/<button\b[^>]*disabled/);
    expect(submitting).toContain("Retrying");
    expect(unavailable).toMatch(/<button\b[^>]*disabled/);
    expect(unavailable).toContain('title="Retry unavailable"');
  });
});
