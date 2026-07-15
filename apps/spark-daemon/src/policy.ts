import type { ServerCommandPayload, SparkCommand } from "@zendev-lab/spark-protocol";
import {
  decideSparkDaemonCommandPolicy,
  sparkCommandFromServerCommandPayload,
  type SparkDaemonCommandPolicyDecision,
} from "./command-dispatcher.ts";

export interface CommandPolicyInput {
  command: ServerCommandPayload | SparkCommand;
  runtimeId?: string | undefined;
  expectedRuntimeId?: string | undefined;
  workspaceBindingId?: string | undefined;
  knownWorkspaceBindingIds: Set<string>;
  allowMutation?: boolean | undefined;
  workspaceAccess?:
    | {
        detached?: boolean | undefined;
        borrowed?: boolean | undefined;
      }
    | undefined;
}

export type CommandPolicyDecision = SparkDaemonCommandPolicyDecision;

export function decideCommandPolicy(input: CommandPolicyInput): CommandPolicyDecision {
  const command = isSparkCommand(input.command)
    ? input.command
    : sparkCommandFromServerCommandPayload(input.command, {
        workspaceBindingId: input.workspaceBindingId,
      });
  return decideSparkDaemonCommandPolicy({
    command,
    runtimeId: input.runtimeId,
    expectedRuntimeId: input.expectedRuntimeId,
    workspaceBindingId: input.workspaceBindingId,
    knownWorkspaceBindingIds: input.knownWorkspaceBindingIds,
    allowMutation: input.allowMutation,
    workspaceAccess: input.workspaceAccess,
  });
}

function isSparkCommand(command: ServerCommandPayload | SparkCommand): command is SparkCommand {
  return "schemaVersion" in command && command.schemaVersion === "spark.command.v1";
}
