import { describe, expect, it } from "vitest";
import { resolveWorkspaceCreationState } from "./workspace-creation-state";

describe("workspace creation state", () => {
  it("keeps an invalid setup on the first step when no command was created", () => {
    expect(
      resolveWorkspaceCreationState({
        actionCommand: null,
        retainedCommand: null,
        pendingCommand: null,
        hasPendingSetup: false,
        hasWorkspaceBinding: false,
      }),
    ).toEqual({
      registrationCommand: null,
      currentStepIndex: 0,
      shouldPollForWorkspaceBinding: false,
    });
  });

  it("shows an action command immediately without waiting for the pending cookie", () => {
    const actionCommand = { enrollCommand: "spark daemon login" };
    expect(
      resolveWorkspaceCreationState({
        actionCommand,
        retainedCommand: null,
        pendingCommand: null,
        hasPendingSetup: false,
        hasWorkspaceBinding: false,
      }),
    ).toEqual({
      registrationCommand: actionCommand,
      currentStepIndex: 1,
      shouldPollForWorkspaceBinding: true,
    });
  });

  it("restores device and retained commands on later renders", () => {
    const pendingCommand = { enrollCommand: "restored device command" };
    expect(
      resolveWorkspaceCreationState({
        actionCommand: null,
        retainedCommand: null,
        pendingCommand,
        hasPendingSetup: true,
        hasWorkspaceBinding: false,
      }),
    ).toEqual({
      registrationCommand: pendingCommand,
      currentStepIndex: 1,
      shouldPollForWorkspaceBinding: true,
    });

    const retainedCommand = { enrollCommand: "retained one-time command" };
    expect(
      resolveWorkspaceCreationState({
        actionCommand: null,
        retainedCommand,
        pendingCommand: null,
        hasPendingSetup: true,
        hasWorkspaceBinding: false,
      }),
    ).toEqual({
      registrationCommand: retainedCommand,
      currentStepIndex: 1,
      shouldPollForWorkspaceBinding: true,
    });
  });

  it("returns to configuration when a one-time command cannot be restored", () => {
    expect(
      resolveWorkspaceCreationState({
        actionCommand: null,
        retainedCommand: null,
        pendingCommand: null,
        hasPendingSetup: true,
        hasWorkspaceBinding: false,
      }),
    ).toEqual({
      registrationCommand: null,
      currentStepIndex: 0,
      shouldPollForWorkspaceBinding: true,
    });
  });

  it("advances to workspace confirmation as soon as the directory binds", () => {
    expect(
      resolveWorkspaceCreationState({
        actionCommand: null,
        retainedCommand: null,
        pendingCommand: null,
        hasPendingSetup: true,
        hasWorkspaceBinding: true,
      }),
    ).toEqual({
      registrationCommand: null,
      currentStepIndex: 2,
      shouldPollForWorkspaceBinding: false,
    });
  });
});
