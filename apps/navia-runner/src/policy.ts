import type { ServerCommandPayload } from "@zendev-lab/navia-protocol";

export interface CommandPolicyInput {
  command: ServerCommandPayload;
  workspaceBindingId?: string | undefined;
  knownWorkspaceBindingIds: Set<string>;
  allowMutation?: boolean | undefined;
}

export interface CommandPolicyDecision {
  accepted: boolean;
  tools: string[];
  reasonCode?: string;
  message?: string;
}

const readOnlyTools = ["read", "grep", "find", "ls"] as const;
const mutationTools = ["bash", "edit", "write"] as const;

export function decideCommandPolicy(input: CommandPolicyInput): CommandPolicyDecision {
  if (!input.workspaceBindingId || !input.knownWorkspaceBindingIds.has(input.workspaceBindingId)) {
    return {
      accepted: false,
      tools: [],
      reasonCode: "UNKNOWN_WORKSPACE_BINDING",
      message: "Command referenced a workspace binding this runner does not own.",
    };
  }

  if (input.command.kind === "invocation.cancel.request") {
    return { accepted: true, tools: [] };
  }

  const needsMutation = input.command.kind === "task.start.request";
  if (needsMutation && input.allowMutation === false) {
    return {
      accepted: false,
      tools: [...readOnlyTools],
      reasonCode: "MUTATION_NOT_ALLOWED",
      message: "This command needs mutating tools, but mutation is disabled for this runner.",
    };
  }

  return {
    accepted: true,
    tools: needsMutation ? [...readOnlyTools, ...mutationTools] : [...readOnlyTools],
  };
}
