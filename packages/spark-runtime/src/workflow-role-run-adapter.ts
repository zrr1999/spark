import type { RoleRef } from "@zendev-lab/pi-extension-api";
import type { WorkflowAgentOptions, WorkflowAgentRunner } from "@zendev-lab/pi-workflows";

export interface SparkWorkflowRoleRunRequest {
  roleRef: RoleRef;
  instruction: string;
  label: string;
  phase?: string;
  model?: string;
  metadata: {
    workflowAgent: true;
    label: string;
    phase?: string;
    model?: string;
    agentType?: string;
    isolation?: "worktree";
    timeoutMs?: number;
    artifactRef?: string;
    index: number;
  };
}

export interface SparkWorkflowRoleRunResponse {
  text: string;
  structured?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SparkWorkflowRoleRunAdapterDeps {
  roleRef: RoleRef;
  runRoleInstruction: (
    request: SparkWorkflowRoleRunRequest,
  ) => Promise<SparkWorkflowRoleRunResponse>;
}

export function createSparkWorkflowRoleRunAdapter(
  deps: SparkWorkflowRoleRunAdapterDeps,
): WorkflowAgentRunner {
  return async (prompt, options) => {
    const label = normalizedWorkflowAgentLabel(options);
    const request: SparkWorkflowRoleRunRequest = {
      roleRef: deps.roleRef,
      instruction: renderSparkWorkflowAgentInstruction(prompt, options, label),
      label,
      phase: options.phase,
      model: options.model,
      metadata: {
        workflowAgent: true,
        label,
        phase: options.phase,
        model: options.model,
        agentType: options.agentType,
        isolation: options.isolation,
        timeoutMs: options.timeoutMs,
        artifactRef: options.artifactRef,
        index: options.index,
      },
    };
    const response = await deps.runRoleInstruction(request);
    return response.structured ?? response.text;
  };
}

export function normalizedWorkflowAgentLabel(
  options: WorkflowAgentOptions & { index: number },
): string {
  const explicit = options.label?.trim();
  return explicit || "workflow-agent-" + (options.index + 1);
}

export function renderSparkWorkflowAgentInstruction(
  prompt: string,
  options: WorkflowAgentOptions & { index: number; phase?: string },
  label = normalizedWorkflowAgentLabel(options),
): string {
  const lines = [
    "You are a Spark workflow child run. Execute exactly the workflow agent request below and return the requested result.",
    "",
    "Workflow metadata:",
    "- Agent index: " + options.index,
    "- Label: " + label,
  ];
  if (options.phase) lines.push("- Phase: " + options.phase);
  if (options.model) lines.push("- Requested model: " + options.model);
  if (options.agentType) lines.push("- Agent type: " + options.agentType);
  if (options.isolation) lines.push("- Isolation: " + options.isolation);
  if (options.timeoutMs) lines.push("- Timeout ms: " + options.timeoutMs);
  if (options.artifactRef) lines.push("- Briefing artifact: " + options.artifactRef);
  if (options.schema)
    lines.push(
      "- Structured schema is attached in workflow options; satisfy it when the host provides structured-output support.",
    );
  lines.push("", "Agent prompt:", prompt);
  return lines.join("\n");
}
