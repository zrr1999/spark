import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const pagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/workspaces/new/+page.svelte",
);
const pageServerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/workspaces/new/+page.server.ts",
);

describe("workspace creation page contract", () => {
  it("compiles as a Svelte page", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(() => compile(source, { filename: pagePath, generate: "server" })).not.toThrow();
  });

  it("only completes configuration when a displayable command exists", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("actionRegistrationCommand = $derived.by(");
    expect(source).toContain("resolveWorkspaceCreationState<RegistrationCommand>");
    expect(source).toContain("actionCommand: actionRegistrationCommand");
    expect(source).toContain("hasWorkspaceBinding: hasTargetWorkspaceBinding");
    expect(source).toContain("visibleRegistrationCommand");
    expect(source).toContain("{#if visibleRegistrationCommand}");
    expect(source).toContain("<pre>{currentCommand.enrollCommand}</pre>");
    expect(source).not.toContain("hasConfirmedWorkspaceSetup");
  });

  it("keeps failures and one-time command recovery on the configuration step", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain('form?.intent === "workspaceRegistration"');
    expect(source).toContain("t.emptyWorkspace.stepActions.commandUnavailable");
    expect(source).toContain('<p class="form-message" role="alert">{form.message}</p>');
    expect(source).toContain(
      "{#if data.pendingWorkspaceSetup?.enrollmentTokenId && !visibleRegistrationCommand}",
    );
    expect(source).toContain("void invalidateAll()");
    expect(source).toContain('action="?/createWorkspace"');
  });

  it("only exposes one-time token registration in the current UI", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("t.emptyWorkspace.stepActions.createToken");
    expect(source).not.toContain("registrationMethod");
    expect(source).not.toContain('"device" | "token"');
    expect(source).not.toContain("t.emptyWorkspace.stepActions.createDeviceCommand");
    expect(source).not.toContain("t.emptyWorkspace.stepActions.createTokenFallback");
    expect(source).not.toContain("pendingDeviceRegistrationCommand");
    expect(source).toContain('form.registrationMode !== "token"');
  });

  it("surfaces a registered-but-offline runtime instead of silently polling", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("pendingRuntimeConnection = $derived(data.pendingRuntimeConnection)");
    expect(source).toContain("{:else if pendingRuntimeConnection}");
    expect(source).toContain("t.emptyWorkspace.stepActions.runtimeRegisteredOfflineTitle");
    expect(source).toContain("pending.runtimeStatus");
  });

  it("hard-cuts the tokenless device registration backend", () => {
    const source = readFileSync(pageServerPath, "utf8");

    expect(source).toContain('registrationMode: "token"');
    expect(source).toContain("createRuntimeEnrollmentToken(db");
    expect(source).not.toContain("registrationMethod");
    expect(source).not.toContain('registrationMode: "device"');
    expect(source).not.toContain("buildDeviceRegistrationCommand");
    expect(source).not.toContain("buildDaemonLoginCommand");
  });
});
