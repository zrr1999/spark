import { Type } from "typebox";
import {
  defaultArtifactStore,
  type ArtifactFormat,
  type JsonValue,
} from "@zendev-lab/pi-artifacts";
import { type RoleRef } from "@zendev-lab/pi-extension-api";
import {
  readSavedWorkflow,
  runWorkflowScript,
  type WorkflowAgentRunner,
  type WorkflowArtifactRecordInput,
  type WorkflowRunResult,
} from "@zendev-lab/pi-workflows";
import {
  createSparkWorkflowRoleRunAdapter,
  runRoleInstructionOnly,
  type SparkRoleRunResult,
  type SparkWorkflowRoleRunRequest,
  type SparkWorkflowModelRunRequest,
} from "@zendev-lab/spark-runtime";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import { sessionModelName } from "./session-model.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

const DEFAULT_WORKFLOW_ROLE_REF = "role:builtin-worker" as RoleRef;

interface SparkWorkflowRunParams {
  selector?: unknown;
  script?: unknown;
  args?: unknown;
  concurrency?: unknown;
  maxAgents?: unknown;
  tokenBudget?: unknown;
}

export interface SparkWorkflowRunToolDeps {
  runWorkflow?: typeof runWorkflowScript;
  resolveScript?: (input: {
    cwd: string;
    selector: string;
  }) => Promise<{ script: string; label: string }>;
  createAgentRunner?: (input: {
    cwd: string;
    ctx: SparkToolContext;
    signal: AbortSignal;
  }) => Promise<WorkflowAgentRunner> | WorkflowAgentRunner;
  artifactRecord?: (input: {
    cwd: string;
    record: WorkflowArtifactRecordInput;
  }) => Promise<{ ref: string }> | { ref: string };
}

export function registerSparkWorkflowRunTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkWorkflowRunToolDeps = {},
): void {
  registerSparkTool({
    name: "workflow_run",
    label: "Workflow Run",
    description:
      "Execute a generated or saved JavaScript workflow through Spark workflow runtime primitives. Use for explicit dynamic workflow/fan-out requests after the script has metadata and clear phases.",
    promptGuidelines: [
      "Use workflow_run only when the user explicitly asks for workflow, workflows, ultracode, fan-out, or multi-agent orchestration; do not use it for a single quick tool call.",
      "workflow_run accepts either selector (builtin:<id>, workspace:<id>, user:<id>) or raw script, never both. Raw scripts must be trusted/generated for this request and must start with export const meta = { name, description, phases? }.",
      "For workflow_run scripts, available globals include agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(name,args), phase(title,{budget?}), budget, verify, judgePanel, loopUntilDry, completenessCheck, retry, gate, artifactRecord, and args.",
      "Every agent() prompt must include enough context; intermediate values stay in workflow variables and only the compact final result returns to the conversation.",
      "Prefer quality helpers: verify for adversarial checks, judgePanel for best-of-N, loopUntilDry for exhaustive discovery, and completenessCheck before final synthesis.",
      "Use tokenBudget/maxAgents/concurrency when the user asks for spend/time bounds or the fan-out is large.",
    ],
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "Saved workflow selector: builtin:<id>, workspace:<id>, or user:<id>.",
        }),
      ),
      script: Type.Optional(
        Type.String({
          description: "Raw JavaScript workflow script. Must start with export const meta.",
        }),
      ),
      args: Type.Optional(
        Type.Any({ description: "JSON value exposed inside the workflow as args." }),
      ),
      concurrency: Type.Optional(
        Type.Number({ description: "Maximum concurrent workflow agents." }),
      ),
      maxAgents: Type.Optional(Type.Number({ description: "Maximum total workflow agent calls." })),
      tokenBudget: Type.Optional(
        Type.Number({ description: "Estimated token ceiling for the workflow." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as SparkWorkflowRunParams;
      const cwd = ctx.cwd;
      const scriptInput = normalizeOptionalWorkflowString(p.script, "script");
      const selector = normalizeOptionalWorkflowString(p.selector, "selector");
      if (scriptInput && selector)
        throw new Error("workflow_run accepts selector or script, not both");
      if (!scriptInput && !selector) throw new Error("workflow_run requires selector or script");
      const source = scriptInput
        ? { script: scriptInput, label: "inline workflow" }
        : await resolveWorkflowScriptSource(cwd, selector!, deps);
      const runWorkflow = deps.runWorkflow ?? runWorkflowScript;
      const agent = await (deps.createAgentRunner ?? createSparkWorkflowAgentRunner)({
        cwd,
        ctx,
        signal,
      });
      const result = await runWorkflow(source.script, {
        args: p.args,
        agent,
        concurrency: normalizeOptionalPositiveInteger(p.concurrency, "concurrency"),
        maxAgents: normalizeOptionalPositiveInteger(p.maxAgents, "maxAgents"),
        tokenBudget: normalizeOptionalPositiveInteger(p.tokenBudget, "tokenBudget"),
        artifactRecord: (record) => recordWorkflowArtifact(cwd, record, deps),
      });
      const text = renderWorkflowRunResultText(source.label, result);
      return {
        content: [{ type: "text", text }],
        details: {
          workflow: {
            source: source.label,
            meta: result.meta,
            phases: result.phases,
            agentCount: result.agentCount,
            result: jsonSafe(result.result),
          },
        },
      };
    },
  });
}

async function resolveWorkflowScriptSource(
  cwd: string,
  selector: string,
  deps: SparkWorkflowRunToolDeps,
): Promise<{ script: string; label: string }> {
  if (deps.resolveScript) return deps.resolveScript({ cwd, selector });
  const { descriptor, script } = await readSavedWorkflow({ cwd, selector, includeUser: true });
  return { script, label: descriptor.selector };
}

async function createSparkWorkflowAgentRunner(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
}): Promise<WorkflowAgentRunner> {
  const registry = await createSparkRoleRegistry(input.cwd);
  const runRole = async (request: SparkWorkflowRoleRunRequest) => {
    const roleResult = await runRoleInstructionOnly(
      registry,
      { roleRef: request.roleRef, instruction: request.instruction },
      {
        cwd: input.cwd,
        dryRun: false,
        timeoutMs: request.metadata.timeoutMs,
        signal: input.signal,
        runName: request.label,
        sessionModel: request.model ?? sessionModelName(input.ctx.model),
      },
    );
    return { text: roleRunText(roleResult), metadata: { runRef: roleResult.record.ref } };
  };
  const runModel = async (request: SparkWorkflowModelRunRequest) => {
    const instruction = [
      "You are a Spark workflow model agent. Answer the workflow prompt directly.",
      request.phase ? `Workflow phase: ${request.phase}` : undefined,
      "",
      request.prompt,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const roleResult = await runRoleInstructionOnly(
      registry,
      { roleRef: DEFAULT_WORKFLOW_ROLE_REF, instruction },
      {
        cwd: input.cwd,
        dryRun: false,
        timeoutMs: request.metadata.timeoutMs,
        signal: input.signal,
        runName: request.label,
        sessionModel: request.model ?? sessionModelName(input.ctx.model),
      },
    );
    return { text: roleRunText(roleResult), metadata: { runRef: roleResult.record.ref } };
  };
  return createSparkWorkflowRoleRunAdapter({
    roleRef: DEFAULT_WORKFLOW_ROLE_REF,
    runRoleInstruction: runRole,
    runModelInstruction: runModel,
  });
}

async function recordWorkflowArtifact(
  cwd: string,
  record: WorkflowArtifactRecordInput,
  deps: SparkWorkflowRunToolDeps,
): Promise<{ ref: string }> {
  if (deps.artifactRecord) return deps.artifactRecord({ cwd, record });
  const artifact = await defaultArtifactStore(cwd).put({
    kind:
      record.kind === "record" || record.kind === "trace" || record.kind === "knowledge"
        ? record.kind
        : "document",
    title: record.title,
    format: normalizeWorkflowArtifactFormat(record.format),
    body: record.body as unknown as JsonValue,
    curation: { status: "raw", retention: "task" },
    provenance: { producer: "task", note: "workflow_run artifactRecord" },
  });
  return { ref: artifact.ref };
}

function renderWorkflowRunResultText(source: string, result: WorkflowRunResult): string {
  const body = result.result === undefined ? "undefined" : JSON.stringify(result.result, null, 2);
  return [
    `Workflow run completed: ${source}`,
    `Name: ${result.meta.name}`,
    `Agents: ${result.agentCount}`,
    result.phases.length
      ? `Phases: ${result.phases.map((phase) => `${phase.title}${phase.status ? `:${phase.status}` : ""}`).join(", ")}`
      : undefined,
    "",
    "Result:",
    body,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function roleRunText(result: SparkRoleRunResult): string {
  const text =
    extractFinalAssistantText(result.jsonEvents) ??
    nonJsonStdoutText(result.stdout) ??
    result.stderr.trim();
  return text || `role run finished with status ${result.record.status}`;
}

function extractFinalAssistantText(events: unknown[]): string | undefined {
  for (const event of [...events].reverse()) {
    const direct = extractAssistantText(eventMessage(event));
    if (direct) return direct;
    const messages = eventMessages(event);
    for (const message of [...messages].reverse()) {
      const text = extractAssistantText(message);
      if (text) return text;
    }
  }
  return undefined;
}

function eventMessage(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as { message?: unknown }).message;
}

function eventMessages(event: unknown): unknown[] {
  if (!event || typeof event !== "object") return [];
  const messages = (event as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role !== "assistant") return undefined;
  return messageContentText((message as { content?: unknown }).content);
}

function messageContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function nonJsonStdoutText(value: string): string | undefined {
  const text = value
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function normalizeWorkflowArtifactFormat(value: string | undefined): ArtifactFormat {
  if (value === "markdown" || value === "json" || value === "text") return value;
  return "markdown";
}

function normalizeOptionalWorkflowString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`workflow_run.${field} must be a non-empty string`);
  return value.trim();
}

function normalizeOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`workflow_run.${field} must be a positive number`);
  }
  return Math.trunc(value);
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
