import { parseSparkAssignment, type SparkAssignment } from "@zendev-lab/spark-protocol";
import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-system";

export interface SubmitCockpitConversationTurnInput {
  workspaceId?: string;
  sessionId: string;
  prompt: string;
  title: string;
}

export interface SubmittedCockpitConversationTurn {
  turnId: string;
}

export interface CockpitConversationControlClient {
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
  }): Promise<unknown>;
}

const daemonConversationControlClient: CockpitConversationControlClient = {
  submit: async (input) => await requestSparkDaemonLocalRpc<unknown>("turn.submit", input),
};

/**
 * Submit every Cockpit message through the daemon conversation control plane.
 * Channel ingress and the Web UI therefore append to the same native session
 * transcript instead of executing through separate Web-only task machinery.
 */
export async function submitConversationTurnForCockpit(
  input: SubmitCockpitConversationTurnInput,
  client: CockpitConversationControlClient = daemonConversationControlClient,
): Promise<SubmittedCockpitConversationTurn> {
  const assignment = parseSparkAssignment({
    goal: input.prompt,
    title: input.title,
    target: {
      sessionId: input.sessionId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    constraints: [],
    evidence: [],
    source: { kind: "cockpit" },
  });
  const result = await client.submit({
    sessionId: input.sessionId,
    prompt: input.prompt,
    assignment,
  });
  if (!isRecord(result) || typeof result.fileName !== "string" || !result.fileName.trim()) {
    throw new Error("Spark daemon returned an invalid conversation turn receipt.");
  }
  return { turnId: result.fileName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
