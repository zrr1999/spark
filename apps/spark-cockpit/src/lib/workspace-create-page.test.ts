import type { Cookies } from "@sveltejs/kit";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import { getDictionary } from "$lib/i18n";
import Page from "../routes/(console)/workspaces/new/+page.svelte";
import type { ActionData, PageData } from "../routes/(console)/workspaces/new/$types";

const mocks = vi.hoisted(() => ({
  createRuntimeEnrollmentToken: vi.fn(() => ({
    id: "token-test",
    refreshToken: "refresh-test",
    expiresAt: "2026-07-23T12:00:00.000Z",
  })),
  ensureCurrentOwnerSession: vi.fn(() => "owner-test"),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock("$lib/server/auth", () => ({
  ensureCurrentOwnerSession: mocks.ensureCurrentOwnerSession,
}));
vi.mock("$lib/server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@zendev-lab/spark-cockpit-coordination/runtime-registration", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@zendev-lab/spark-cockpit-coordination/runtime-registration")
    >();
  return {
    ...actual,
    createRuntimeEnrollmentToken: mocks.createRuntimeEnrollmentToken,
  };
});

const profile = {
  profileSource: "builtin:fresh" as const,
  profileUrl: "",
  name: "Spark Test",
  slug: "spark-test",
  description: "Behavioral page contract",
  enrollmentTokenId: "token-test",
};

function pageData(overrides: Partial<PageData> = {}): PageData {
  return {
    locale: "en",
    messages: getDictionary("en"),
    activeWorkspace: {
      id: "workspace-active",
      slug: "active",
      name: "Active Workspace",
      localPath: null,
    },
    workspaces: [],
    sessions: [],
    sessionsAvailable: true,
    isGlobalConsole: true,
    serverOrigin: "https://spark.test",
    loopbackServerOrigin: false,
    insecureRemoteServerOrigin: false,
    runnerBindings: [],
    ownerBindings: [],
    pendingWorkspaceSetup: null,
    targetRunnerBinding: null,
    pendingRuntimeConnection: null,
    ...overrides,
  };
}

function renderPage(data: PageData, form: ActionData = null): string {
  return render(Page, { props: { data, form } }).body;
}

describe("workspace creation page behavior", () => {
  it("stays on profile setup until a displayable one-time command exists", () => {
    const initial = renderPage(pageData());
    expect(initial).toContain("Generate connection command");
    expect(initial).not.toContain("spark daemon workspace register");

    const failed = renderPage(pageData(), {
      intent: "workspaceRegistration",
      message: "Registration failed safely",
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Registration failed safely");
    expect(failed).toContain("Generate connection command");

    const unrecoverable = renderPage(
      pageData({
        pendingWorkspaceSetup: profile,
      }),
    );
    expect(unrecoverable).toContain("The previous one-time command cannot be shown again");
    expect(unrecoverable).not.toContain("spark daemon workspace register");
  });

  it("shows the returned command, then advances only after the runtime binding exists", () => {
    const command = "spark daemon workspace register https://spark.test --token refresh-test";
    const commandVisible = renderPage(pageData({ pendingWorkspaceSetup: profile }), {
      intent: "workspaceRegistration",
      registrationMode: "token",
      message: "Command created",
      enrollmentTokenId: "token-test",
      enrollmentToken: "refresh-test",
      enrollCommand: command,
      enrollmentExpiresAt: "2026-07-23T12:00:00.000Z",
      profileSetup: profile,
    });

    expect(commandVisible).toContain(command);
    expect(commandVisible).toContain("Copy and run this one-time command");
    expect(commandVisible).not.toContain('action="?/createWorkspace"');

    const bindingVisible = renderPage(
      pageData({
        pendingWorkspaceSetup: profile,
        targetRunnerBinding: {
          id: "binding-test",
          runtimeId: "runtime-test",
          displayName: "Spark Runtime",
          runtimeName: "Spark",
          runtimeStatus: "online",
          localWorkspaceKey: "spark-test",
          localPath: "/workspace/spark-test",
          status: "available",
          lastSnapshotAt: null,
          updatedAt: "2026-07-23T12:00:00.000Z",
        },
      }),
    );
    expect(bindingVisible).toContain('action="?/createWorkspace"');
    expect(bindingVisible).toContain("Spark Runtime");
    expect(bindingVisible).toContain("spark-test");
  });

  it("renders the registered-but-offline runtime instead of claiming setup is complete", () => {
    const body = renderPage(
      pageData({
        pendingWorkspaceSetup: profile,
        pendingRuntimeConnection: {
          bindingDisplayName: "Spark Runtime",
          runtimeName: "Spark",
          runtimeStatus: "offline",
          bindingStatus: "available",
        },
      }),
    );

    expect(body).toContain("Registered, but not connected yet");
    expect(body).toMatch(/<code[^>]*>offline<\/code>/u);
    expect(body).not.toContain('action="?/createWorkspace"');
  });
});

describe("workspace registration action behavior", () => {
  it("uses token enrollment even when a caller submits a retired device mode", async () => {
    const { actions } = await import("../routes/(console)/workspaces/new/+page.server.ts");
    const cookies = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as Cookies;
    const request = new Request("https://spark.test/workspaces/new", {
      method: "POST",
      body: new URLSearchParams({
        profileSource: "builtin:fresh",
        profileUrl: "",
        name: "Spark Test",
        slug: "spark-test",
        description: "Behavioral page contract",
        registrationMode: "device",
      }),
    });

    const result = (await actions.prepareRegistration?.({
      cookies,
      locals: { sessionToken: "session-test" },
      request,
      url: new URL(request.url),
    } as never)) as Record<string, unknown>;

    expect(result.registrationMode).toBe("token");
    expect(result.enrollmentToken).toBe("refresh-test");
    expect(result.enrollCommand).toContain("spark daemon workspace register");
    expect(mocks.createRuntimeEnrollmentToken).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceName: "Spark Test",
        workspaceSlug: "spark-test",
      }),
    );
    expect(cookies.set).toHaveBeenCalled();
  });
});
