import type { RoleRef } from "@zendev-lab/pi-extension-api";
import type {
  WorkflowAgentOptions,
  WorkflowAgentReportedTelemetry,
  WorkflowAgentRunner,
} from "@zendev-lab/pi-workflows";

export const SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS = [
  "graft_help",
  "graft_status",
  "graft_scratch_open",
  "graft_read",
  "graft_write",
  "graft_edit",
  "graft_delete",
  "graft_scratch_diff",
  "graft_scratch_pin",
  "graft_scratch_unpin",
  "graft_candidate_from_scratch",
  "graft_validate",
  "graft_admit",
  "graft_show",
  "graft_evidence",
  "graft_materialize",
] as const;

export interface SparkWorkflowGraftRefs {
  scratchRefs: string[];
  candidateRefs: string[];
  patchRefs: string[];
}

export interface SparkWorkflowGraftAgentResult {
  text: string;
  structured?: unknown;
  graftRefs: SparkWorkflowGraftRefs;
}

export interface SparkWorkflowRoleRunRequest {
  roleRef: RoleRef;
  instruction: string;
  label: string;
  stage?: string;
  /** @deprecated Use stage. */
  phase?: string;
  model?: string;
  metadata: {
    workflowAgent: true;
    label: string;
    stage?: string;
    /** @deprecated Use stage. */
    phase?: string;
    model?: string;
    agentType?: string;
    isolation?: "graft";
    timeoutMs?: number;
    artifactRef?: string;
    envKeys?: string[];
    allowedTools?: string[];
    index: number;
  };
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
}

export interface SparkWorkflowRoleRunResponse {
  text: string;
  structured?: unknown;
  metadata?: Record<string, unknown>;
  telemetry?: WorkflowAgentReportedTelemetry;
}

export interface SparkWorkflowModelRunRequest {
  prompt: string;
  label: string;
  stage?: string;
  /** @deprecated Use stage. */
  phase?: string;
  model?: string;
  metadata: {
    workflowAgent: true;
    label: string;
    stage?: string;
    /** @deprecated Use stage. */
    phase?: string;
    model?: string;
    agentType: "model";
    isolation?: "graft";
    timeoutMs?: number;
    artifactRef?: string;
    envKeys?: string[];
    allowedTools?: string[];
    index: number;
  };
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
}

export interface SparkWorkflowRoleRunAdapterDeps {
  roleRef: RoleRef;
  graftBaseRef?: string;
  graftIsolationAllowedTools?: string[];
  runRoleInstruction: (
    request: SparkWorkflowRoleRunRequest,
  ) => Promise<SparkWorkflowRoleRunResponse>;
  runModelInstruction?: (
    request: SparkWorkflowModelRunRequest,
  ) => Promise<SparkWorkflowRoleRunResponse>;
}

export function createSparkWorkflowRoleRunAdapter(
  deps: SparkWorkflowRoleRunAdapterDeps,
): WorkflowAgentRunner {
  return async (prompt, options) => {
    const label = normalizedWorkflowAgentLabel(options);
    const isolationPolicy = workflowIsolationPolicy(options, deps);
    const effectiveOptions = applyWorkflowIsolationPolicy(options, isolationPolicy);
    if (effectiveOptions.agentType === "model") {
      if (!deps.runModelInstruction) {
        throw new Error("workflow model agent runner is not configured");
      }
      const stage = effectiveOptions.stage ?? effectiveOptions.phase;
      const response = await deps.runModelInstruction({
        prompt,
        label,
        stage,
        phase: stage,
        model: effectiveOptions.model,
        metadata: {
          workflowAgent: true,
          label,
          stage,
          phase: stage,
          model: effectiveOptions.model,
          agentType: "model",
          isolation: effectiveOptions.isolation,
          timeoutMs: effectiveOptions.timeoutMs,
          artifactRef: effectiveOptions.artifactRef,
          envKeys: workflowEnvKeys(effectiveOptions.env),
          allowedTools: effectiveOptions.allowedTools,
          index: effectiveOptions.index,
        },
        env: effectiveOptions.env,
        allowedTools: effectiveOptions.allowedTools,
      });
      const result = workflowAgentResult(response, Boolean(isolationPolicy));
      reportWorkflowAgentTelemetry(options, response, graftRefsFromResult(result));
      return result;
    }
    const stage = effectiveOptions.stage ?? effectiveOptions.phase;
    const request: SparkWorkflowRoleRunRequest = {
      roleRef: deps.roleRef,
      instruction: renderSparkWorkflowAgentInstruction(prompt, effectiveOptions, label),
      label,
      stage,
      phase: stage,
      model: effectiveOptions.model,
      metadata: {
        workflowAgent: true,
        label,
        stage,
        phase: stage,
        model: effectiveOptions.model,
        agentType: effectiveOptions.agentType,
        isolation: effectiveOptions.isolation,
        timeoutMs: effectiveOptions.timeoutMs,
        artifactRef: effectiveOptions.artifactRef,
        envKeys: workflowEnvKeys(effectiveOptions.env),
        allowedTools: effectiveOptions.allowedTools,
        index: effectiveOptions.index,
      },
      env: effectiveOptions.env,
      allowedTools: effectiveOptions.allowedTools,
    };
    const response = await deps.runRoleInstruction(request);
    const result = workflowAgentResult(response, Boolean(isolationPolicy));
    reportWorkflowAgentTelemetry(options, response, graftRefsFromResult(result));
    return result;
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
  options: WorkflowAgentOptions & { index: number; stage?: string; phase?: string },
  label = normalizedWorkflowAgentLabel(options),
): string {
  const lines = [
    "You are a Spark workflow child run. Execute exactly the workflow agent request below and return the requested result.",
    "",
    "Workflow metadata:",
    "- Agent index: " + options.index,
    "- Label: " + label,
  ];
  const stage = options.stage ?? options.phase;
  if (stage) lines.push("- Stage: " + stage);
  if (options.model) lines.push("- Requested model: " + options.model);
  if (options.agentType) lines.push("- Agent type: " + options.agentType);
  if (options.isolation) lines.push("- Isolation: " + options.isolation);
  if (options.timeoutMs) lines.push("- Timeout ms: " + options.timeoutMs);
  if (options.artifactRef) lines.push("- Briefing artifact: " + options.artifactRef);
  const envKeys = workflowEnvKeys(options.env);
  if (envKeys?.length) lines.push("- Environment keys: " + envKeys.join(","));
  if (options.allowedTools?.length)
    lines.push("- Allowed tools: " + options.allowedTools.join(","));
  if (options.isolation === "graft") appendGraftIsolationInstruction(lines);
  if (options.schema)
    lines.push(
      "- Structured schema is attached in workflow options; satisfy it when the host provides structured-output support.",
    );
  lines.push("", "Agent prompt:", prompt);
  return lines.join("\n");
}

interface SparkWorkflowIsolationPolicy {
  env: NodeJS.ProcessEnv;
  allowedTools: string[];
}

function workflowIsolationPolicy(
  options: WorkflowAgentOptions,
  deps: SparkWorkflowRoleRunAdapterDeps,
): SparkWorkflowIsolationPolicy | undefined {
  if (options.isolation !== "graft") return undefined;
  if (!deps.graftBaseRef?.trim()) {
    throw new Error("workflow graft isolation requires persisted workflow base metadata");
  }
  return {
    env: { ...options.env, GRAFT_BASE_REF: deps.graftBaseRef.trim() },
    allowedTools: deps.graftIsolationAllowedTools ?? [...SPARK_WORKFLOW_GRAFT_ISOLATION_TOOLS],
  };
}

function applyWorkflowIsolationPolicy(
  options: WorkflowAgentOptions & { index: number },
  policy: SparkWorkflowIsolationPolicy | undefined,
): WorkflowAgentOptions & { index: number } {
  if (!policy) return options;
  return {
    ...options,
    env: policy.env,
    allowedTools: policy.allowedTools,
  };
}

function appendGraftIsolationInstruction(lines: string[]): void {
  lines.push(
    "- Graft isolation is active: use graft_read/graft_write/graft_edit/graft_delete for file reads and edits; do not use direct read/write/edit shell file operations.",
    "- GRAFT_BASE_REF is already set for the first Graft scratch operation; omit base unless the task explicitly requires a different base, and pass returned scratch ids through from for subsequent edits.",
    "- Create a Graft candidate with graft_candidate_from_scratch before reporting editable results; include scratch:, candidate:, and patch: refs that you created or validated.",
  );
}

function reportWorkflowAgentTelemetry(
  options: { reportTelemetry?: (telemetry: WorkflowAgentReportedTelemetry) => void },
  response: SparkWorkflowRoleRunResponse,
  graftRefs?: SparkWorkflowGraftRefs,
): void {
  const hasGraftRefs = Boolean(
    graftRefs &&
    (graftRefs.scratchRefs.length > 0 ||
      graftRefs.candidateRefs.length > 0 ||
      graftRefs.patchRefs.length > 0),
  );
  if (!response.telemetry && !hasGraftRefs) return;
  options.reportTelemetry?.({
    ...response.telemetry,
    metadata: {
      ...response.telemetry?.metadata,
      ...(hasGraftRefs ? { graftRefs } : {}),
    },
  });
}

function workflowAgentResult(response: SparkWorkflowRoleRunResponse, isolated: boolean): unknown {
  if (!isolated) return response.structured ?? response.text;
  const graftRefs = extractGraftRefs(response);
  const result: SparkWorkflowGraftAgentResult = { text: response.text, graftRefs };
  if (response.structured !== undefined) result.structured = response.structured;
  return result;
}

function graftRefsFromResult(result: unknown): SparkWorkflowGraftRefs | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const graftRefs = (result as { graftRefs?: unknown }).graftRefs;
  if (!graftRefs || typeof graftRefs !== "object" || Array.isArray(graftRefs)) return undefined;
  return {
    scratchRefs: stringArray((graftRefs as { scratchRefs?: unknown }).scratchRefs),
    candidateRefs: stringArray((graftRefs as { candidateRefs?: unknown }).candidateRefs),
    patchRefs: stringArray((graftRefs as { patchRefs?: unknown }).patchRefs),
  };
}

function extractGraftRefs(response: SparkWorkflowRoleRunResponse): SparkWorkflowGraftRefs {
  const refs = new Set<string>();
  collectRefs(response.text, refs);
  collectRefs(response.structured, refs);
  collectRefs(response.metadata, refs);
  return {
    scratchRefs: [...refs].filter((ref) => ref.startsWith("scratch:")),
    candidateRefs: [...refs].filter((ref) => ref.startsWith("candidate:")),
    patchRefs: [...refs].filter((ref) => ref.startsWith("patch:")),
  };
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(/\b(?:scratch|candidate|patch):[A-Za-z0-9._-]+\b/gu)) {
      refs.add(match[0]!);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectRefs(item, refs);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function workflowEnvKeys(env: NodeJS.ProcessEnv | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .sort();
}
