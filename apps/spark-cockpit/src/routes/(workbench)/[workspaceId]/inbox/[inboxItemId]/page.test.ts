// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { getDictionary } from "$lib/i18n";
import Page from "./+page.svelte";

let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

describe("inbox response detail", () => {
  it("keeps a recorded JSON response inset from the panel edge", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(Page, {
      target,
      props: {
        data: {
          locale: "en",
          messages: getDictionary("en"),
          activeWorkspace: { id: "ws_spore", slug: "spore", name: "Spore" },
          workspaces: [{ id: "ws_spore", slug: "spore", name: "Spore" }],
          sessions: [],
          pendingAsk: null,
          sessionsAvailable: true,
          sessionControlAvailable: true,
          item: {
            id: "inbox_compact",
            workspaceId: "ws_spore",
            workspaceSlug: "spore",
            kind: "ask",
            title: "Compact strategy",
            summary: null,
            urgency: "normal",
            status: "answered",
            resolvedAs: "answered",
            prompt: "Choose the compaction behavior.",
            createdAt: "2026-07-17T00:00:00.000Z",
            updatedAt: "2026-07-17T00:01:00.000Z",
            humanRequestId: "hreq_compact",
            runtimeRequestId: "runtime_compact",
            requestKind: "ask_user",
            requestTitle: "Compact strategy",
            questionsJson: "[]",
            contextJson: "{}",
            requestStatus: "answered",
            projectId: null,
            projectName: null,
            runtimeWorkspaceBindingId: "binding_spore",
            runtimeWorkspaceName: "spore",
            runtimeName: "Spark",
            sessionId: null,
            questions: [],
            context: {},
            approval: {
              kind: "ask",
              title: "Ask blocker",
              summary: "Spark is blocked until an operator answers or cancels this ask.",
              riskSummary: [],
              approveLabel: "Answer / approve",
              rejectLabel: "Cancel / reject",
              actionable: true,
            },
          },
          latestResponses: [
            {
              id: "hres_compact",
              answerJson: "{}",
              status: "answered",
              ackedAt: "2026-07-17T00:01:00.000Z",
              deliveryAttemptCount: 1,
              lastDeliveryAt: "2026-07-17T00:01:00.000Z",
              createdAt: "2026-07-17T00:01:00.000Z",
              updatedAt: "2026-07-17T00:01:00.000Z",
              answer: { status: "answered", answers: { micro_pass_limit: "2" } },
            },
          ],
        },
        form: null,
      },
    });
    await tick();

    const output = document.querySelector<HTMLElement>(".response-output");
    expect(output).not.toBeNull();
    expect(output?.parentElement?.classList.contains("ui-panel-body")).toBe(true);
    expect(output?.previousElementSibling?.classList.contains("answered-state")).toBe(true);
    expect(output?.querySelector("pre")?.textContent).toContain('"micro_pass_limit": "2"');
  });
});
