export type WorkspaceCreationStep = 0 | 1 | 2;

export interface WorkspaceCreationStateInput<TCommand> {
  actionCommand?: TCommand | null;
  retainedCommand?: TCommand | null;
  pendingCommand?: TCommand | null;
  hasPendingSetup: boolean;
  hasWorkspaceBinding: boolean;
}

export function resolveWorkspaceCreationState<TCommand>({
  actionCommand,
  retainedCommand,
  pendingCommand,
  hasPendingSetup,
  hasWorkspaceBinding,
}: WorkspaceCreationStateInput<TCommand>) {
  const registrationCommand = actionCommand ?? retainedCommand ?? pendingCommand ?? null;
  const currentStepIndex: WorkspaceCreationStep = hasWorkspaceBinding
    ? 2
    : registrationCommand
      ? 1
      : 0;

  return {
    registrationCommand,
    currentStepIndex,
    shouldPollForWorkspaceBinding:
      !hasWorkspaceBinding && (hasPendingSetup || registrationCommand !== null),
  };
}
