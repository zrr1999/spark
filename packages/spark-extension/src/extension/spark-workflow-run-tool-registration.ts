import { Type } from "typebox";
import {
  defaultArtifactStore,
  type ArtifactFormat,
  type JsonValue,
} from "@zendev-lab/pi-artifacts";
import { type RoleRef, type RunRef } from "@zendev-lab/pi-extension-api";
import {
  parseWorkflowScript,
  readSavedWorkflow,
  runWorkflowScript,
  type WorkflowAgentReportedTelemetry,
  type WorkflowAgentRunner,
  type WorkflowArtifactRecordInput,
  type WorkflowFetchContentInput,
  type WorkflowRunResult,
  type WorkflowWebSearchInput,
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
import {
  captureSparkWorkflowBaseMetadata,
  defaultSparkDynamicWorkflowRunStore,
  hashWorkflowScript,
  type SparkDynamicWorkflowRunApproval,
  type SparkDynamicWorkflowRunBaseMetadata,
  type SparkDynamicWorkflowRunRecord,
  type SparkDynamicWorkflowRunSource,
  type SparkDynamicWorkflowRunStore,
} from "./spark-dynamic-workflow-run-store.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";

const DEFAULT_WORKFLOW_ROLE_REF = "role:builtin-worker" as RoleRef;
const WORKFLOW_WEB_TOOL_TIMEOUT_MS = 120_000;

export interface SparkWorkflowRunApprovalSummary {
  required: boolean;
  scriptHash: string;
  source: string;
  workflowName: string;
  riskFlags: string[];
  reasons: string[];
  resources: {
    concurrency?: number;
    maxAgents?: number;
    tokenBudget?: number;
    phaseCount: number;
    agentCallSites: number;
    timeoutMs: number[];
  };
  tools: string[];
  isolation: string[];
  base?: SparkDynamicWorkflowRunBaseMetadata;
}

export interface SparkWorkflowRunApprovalDecision {
  approved: boolean;
  method?: "dependency" | "reviewer" | "ui";
  reason?: string;
}

interface SparkWorkflowRunParams {
  selector?: unknown;
  script?: unknown;
  args?: unknown;
  concurrency?: unknown;
  maxAgents?: unknown;
  tokenBudget?: unknown;
  runRef?: unknown;
  resumeRunRef?: unknown;
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
    base?: SparkDynamicWorkflowRunBaseMetadata;
  }) => Promise<WorkflowAgentRunner> | WorkflowAgentRunner;
  artifactRecord?: (input: {
    cwd: string;
    record: WorkflowArtifactRecordInput;
  }) => Promise<{ ref: string }> | { ref: string };
  webSearch?: (input: { cwd: string; request: WorkflowWebSearchInput }) => unknown;
  fetchContent?: (input: { cwd: string; request: WorkflowFetchContentInput }) => unknown;
  approveRun?: (input: {
    cwd: string;
    ctx: SparkToolContext;
    summary: SparkWorkflowRunApprovalSummary;
  }) => Promise<SparkWorkflowRunApprovalDecision> | SparkWorkflowRunApprovalDecision;
  dynamicRunStore?: (cwd: string) => SparkDynamicWorkflowRunStore;
  captureBase?: (input: {
    cwd: string;
  }) =>
    | Promise<SparkDynamicWorkflowRunBaseMetadata | undefined>
    | SparkDynamicWorkflowRunBaseMetadata
    | undefined;
  now?: () => string;
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
      "Generated/risky workflows require scoped approval before execution; Spark summarizes fan-out, web/fetch, write/isolation, shell, long-running, resource, and base metadata risks before any child agents run.",
      "For workflow_run scripts, available globals include agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), workflow(name,args), phase(title,{budget?}), budget, verify, judgePanel, loopUntilDry, completenessCheck, retry, gate, artifactRecord, webSearch, fetchContent, and args.",
      "Every agent() prompt must include enough context; intermediate values stay in workflow variables and only the compact final result returns to the conversation.",
      "Prefer quality helpers: verify for adversarial checks, judgePanel for best-of-N, loopUntilDry for exhaustive discovery, and completenessCheck before final synthesis.",
      "Use tokenBudget/maxAgents/concurrency when the user asks for spend/time bounds or the fan-out is large.",
      "Use agent(prompt, { isolation: 'graft' }) only for code-editing agents that should work through Graft scratch/candidate tools; Spark injects GRAFT_BASE_REF from persisted workflow base metadata and narrows tools to Graft operations.",
      "workflow_run persists script body/hash, args, phases, journal, result/error, and base metadata; use runRef/resumeRunRef to resume a prior dynamic workflow run.",
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
      runRef: Type.Optional(
        Type.String({ description: "Existing dynamic workflow run ref to resume." }),
      ),
      resumeRunRef: Type.Optional(
        Type.String({ description: "Alias for runRef when resuming a dynamic workflow run." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = params as SparkWorkflowRunParams;
      const cwd = ctx.cwd;
      const scriptInput = normalizeOptionalWorkflowString(p.script, "script");
      const selector = normalizeOptionalWorkflowString(p.selector, "selector");
      const resumeRunRef = normalizeOptionalRunRef(p.resumeRunRef ?? p.runRef, "runRef");
      if (scriptInput && selector)
        throw new Error("workflow_run accepts selector or script, not both");
      if (!scriptInput && !selector && !resumeRunRef)
        throw new Error("workflow_run requires selector, script, or runRef");

      const dynamicStore = (deps.dynamicRunStore ?? defaultSparkDynamicWorkflowRunStore)(cwd);
      await dynamicStore.reconcileStale({ now: deps.now?.() });
      const existingRun = resumeRunRef ? await dynamicStore.get(resumeRunRef) : undefined;
      if (resumeRunRef && !existingRun)
        throw new Error(`dynamic workflow run not found: ${resumeRunRef}`);
      const source = await resolveDynamicWorkflowRunSource({
        cwd,
        scriptInput,
        selector,
        existingRun,
        deps,
      });
      const args = p.args === undefined ? existingRun?.args : p.args;
      const options = {
        concurrency: normalizeOptionalPositiveInteger(p.concurrency, "concurrency"),
        maxAgents: normalizeOptionalPositiveInteger(p.maxAgents, "maxAgents"),
        tokenBudget: normalizeOptionalPositiveInteger(p.tokenBudget, "tokenBudget"),
      };
      const meta = parseWorkflowScript(source.script).meta;
      const base =
        existingRun?.base ??
        (await (deps.captureBase ?? ((input) => captureSparkWorkflowBaseMetadata(input.cwd)))({
          cwd,
        }));
      const approval = await ensureWorkflowRunApproval({
        cwd,
        ctx,
        signal,
        deps,
        sourceLabel: source.label,
        script: source.script,
        meta,
        options,
        base,
        existingRun,
        now: deps.now,
      });
      const dynamicRun = await dynamicStore.start({
        source: source.source,
        script: source.script,
        args,
        meta,
        options,
        base,
        approval,
        resumeRunRef,
        now: deps.now?.(),
      });
      const runWorkflow = deps.runWorkflow ?? runWorkflowScript;
      const agent = await (deps.createAgentRunner ?? createSparkWorkflowAgentRunner)({
        cwd,
        ctx,
        signal,
        base,
      });
      const webSearchAdapter =
        deps.webSearch ?? (await createSparkWorkflowWebSearchAdapter({ cwd, ctx, signal }));
      const fetchContentAdapter =
        deps.fetchContent ?? (await createSparkWorkflowFetchContentAdapter({ cwd, ctx, signal }));
      try {
        const result = await runWorkflow(source.script, {
          args,
          agent,
          concurrency: options.concurrency,
          maxAgents: options.maxAgents,
          tokenBudget: options.tokenBudget,
          resumeJournal: new Map(dynamicRun.journal.map((entry) => [entry.index, entry])),
          artifactRecord: (record) => recordWorkflowArtifact(cwd, record, deps),
          webSearch: (request) => webSearchAdapter({ cwd, request }),
          fetchContent: (request) => fetchContentAdapter({ cwd, request }),
          loadWorkflowScript: (selector) => resolveNestedWorkflowScript(cwd, selector),
          onAgentJournal: (entry) => dynamicStore.recordJournal(dynamicRun.ref, entry),
          onPhase: (phase) => void dynamicStore.recordPhase(dynamicRun.ref, phase),
          onTokenUsage: (usage) => dynamicStore.recordTokenUsage(dynamicRun.ref, usage.spent),
          onAgentTelemetry: (telemetry) =>
            dynamicStore.recordAgentTelemetry(dynamicRun.ref, telemetry),
        });
        const finishedRun = await dynamicStore.finish(dynamicRun.ref, result);
        const text = renderWorkflowRunResultText(source.label, result, finishedRun ?? dynamicRun);
        return {
          content: [{ type: "text", text }],
          details: {
            workflow: {
              runRef: dynamicRun.ref,
              status: finishedRun?.status ?? "succeeded",
              source: source.label,
              scriptHash: finishedRun?.scriptHash ?? dynamicRun.scriptHash,
              base: finishedRun?.base ?? dynamicRun.base,
              approval: finishedRun?.approval ?? dynamicRun.approval,
              meta: result.meta,
              phases: result.phases,
              agentCount: result.agentCount,
              journalEntries: result.journal.length,
              result: jsonSafe(result.result),
            },
          },
        };
      } catch (error) {
        await dynamicStore.fail(dynamicRun.ref, error);
        throw error;
      }
    },
  });
}

async function resolveDynamicWorkflowRunSource(input: {
  cwd: string;
  scriptInput: string | undefined;
  selector: string | undefined;
  existingRun: SparkDynamicWorkflowRunRecord | undefined;
  deps: SparkWorkflowRunToolDeps;
}): Promise<{ script: string; label: string; source: SparkDynamicWorkflowRunSource }> {
  if (input.scriptInput) {
    return {
      script: input.scriptInput,
      label: "inline workflow",
      source: { kind: "inline", label: "inline workflow" },
    };
  }
  if (input.selector) {
    const source = await resolveWorkflowScriptSource(input.cwd, input.selector, input.deps);
    return {
      ...source,
      source: { kind: "selector", label: source.label, selector: input.selector },
    };
  }
  if (input.existingRun) {
    return {
      script: input.existingRun.script,
      label: input.existingRun.source.label,
      source: input.existingRun.source,
    };
  }
  throw new Error("workflow_run requires selector, script, or runRef");
}

async function ensureWorkflowRunApproval(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
  deps: SparkWorkflowRunToolDeps;
  sourceLabel: string;
  script: string;
  meta: ReturnType<typeof parseWorkflowScript>["meta"];
  options: {
    concurrency?: number;
    maxAgents?: number;
    tokenBudget?: number;
  };
  base?: SparkDynamicWorkflowRunBaseMetadata;
  existingRun?: SparkDynamicWorkflowRunRecord;
  now?: () => string;
}): Promise<SparkDynamicWorkflowRunApproval | undefined> {
  const summary = buildWorkflowApprovalSummary(input);
  if (!summary.required) return undefined;
  if (
    input.existingRun?.approval?.status === "approved" &&
    input.existingRun.approval.summary.scriptHash === summary.scriptHash
  )
    return input.existingRun.approval;
  const requestedAt = input.now?.() ?? new Date().toISOString();
  const decision = await requestWorkflowRunApproval({
    cwd: input.cwd,
    ctx: input.ctx,
    signal: input.signal,
    deps: input.deps,
    summary,
  });
  if (!decision.approved)
    throw new Error(
      `workflow_run approval denied: ${decision.reason ?? formatWorkflowApprovalSummaryLine(summary)}`,
    );
  const approvedAt = input.now?.() ?? new Date().toISOString();
  return {
    status: "approved",
    method: decision.method ?? "dependency",
    requestedAt,
    approvedAt,
    ...(decision.reason ? { reason: decision.reason } : {}),
    summary: approvalRecordSummary(summary),
  };
}

function buildWorkflowApprovalSummary(input: {
  sourceLabel: string;
  script: string;
  meta: ReturnType<typeof parseWorkflowScript>["meta"];
  options: {
    concurrency?: number;
    maxAgents?: number;
    tokenBudget?: number;
  };
  base?: SparkDynamicWorkflowRunBaseMetadata;
}): SparkWorkflowRunApprovalSummary {
  const scriptHash = hashWorkflowScript(input.script);
  const allowedTools = extractWorkflowAllowedTools(input.script);
  const timeoutMs = extractWorkflowTimeoutMs(input.script);
  const isolation = extractWorkflowIsolationModes(input.script);
  const agentCallSites = countRegexMatches(input.script, /\bagent\s*\(/gu);
  const riskFlags: string[] = [];
  const reasons: string[] = [];
  const hasFanOut =
    /\b(?:parallel|verify|judgePanel|loopUntilDry|pipeline)\s*\(/u.test(input.script) ||
    (input.options.concurrency ?? 0) > 4 ||
    (input.options.maxAgents ?? 0) > 8;
  if (hasFanOut) {
    riskFlags.push("fan_out");
    reasons.push("script can fan out multiple agents or work items");
  }
  const hasWeb = /\b(?:webSearch|fetchContent)\s*\(/u.test(input.script);
  if (hasWeb) {
    riskFlags.push("web_or_fetch");
    reasons.push("script can call workflow webSearch/fetchContent adapters");
  }
  if (isolation.length > 0) {
    riskFlags.push("isolation");
    reasons.push(`script requests isolation mode(s): ${isolation.join(", ")}`);
  }
  const shellTools = allowedTools.filter(isWorkflowShellTool);
  if (shellTools.length > 0) {
    riskFlags.push("shell_tools");
    reasons.push(`agent tool policy includes shell-like tool(s): ${shellTools.join(", ")}`);
  }
  const writeTools = allowedTools.filter(isWorkflowWriteTool);
  const writesArtifacts = /\bartifactRecord\s*\(/u.test(input.script);
  if (writeTools.length > 0 || writesArtifacts) {
    riskFlags.push("write_tools");
    reasons.push(
      writeTools.length > 0
        ? `agent tool policy includes write-capable tool(s): ${writeTools.join(", ")}`
        : "script can write workflow artifacts",
    );
  }
  const longTimeouts = timeoutMs.filter((value) => value > 300_000);
  if (longTimeouts.length > 0) {
    riskFlags.push("long_running");
    reasons.push(`script declares long timeoutMs value(s): ${longTimeouts.join(", ")}`);
  }
  if ((input.options.tokenBudget ?? 0) > 100_000) {
    riskFlags.push("high_token_budget");
    reasons.push(`workflow_run tokenBudget=${input.options.tokenBudget}`);
  }
  return {
    required: riskFlags.length > 0,
    scriptHash,
    source: input.sourceLabel,
    workflowName: input.meta.name,
    riskFlags: uniqueStrings(riskFlags),
    reasons: uniqueStrings(reasons),
    resources: {
      ...(input.options.concurrency ? { concurrency: input.options.concurrency } : {}),
      ...(input.options.maxAgents ? { maxAgents: input.options.maxAgents } : {}),
      ...(input.options.tokenBudget ? { tokenBudget: input.options.tokenBudget } : {}),
      phaseCount: input.meta.phases?.length ?? 0,
      agentCallSites,
      timeoutMs,
    },
    tools: allowedTools,
    isolation,
    ...(input.base ? { base: input.base } : {}),
  };
}

async function requestWorkflowRunApproval(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
  deps: SparkWorkflowRunToolDeps;
  summary: SparkWorkflowRunApprovalSummary;
}): Promise<SparkWorkflowRunApprovalDecision> {
  if (input.deps.approveRun) {
    const decision = await input.deps.approveRun({
      cwd: input.cwd,
      ctx: input.ctx,
      summary: input.summary,
    });
    return { method: "dependency", ...decision };
  }
  if (input.ctx.askAutoAnswer === "reviewer" && input.ctx.askAutoAnswerResolver) {
    const answered = await input.ctx.askAutoAnswerResolver(
      workflowApprovalAskRequest(input.summary),
      input.ctx,
    );
    const answer = isRecord(answered) ? answered : {};
    if (answer.blocked === true)
      return {
        approved: false,
        method: "reviewer",
        reason: typeof answer.reason === "string" ? answer.reason : "reviewer blocked approval",
      };
    const values = approvalAnswerValues(answer.answers);
    return {
      approved: values.includes("approve"),
      method: "reviewer",
      reason: typeof answer.reason === "string" ? answer.reason : undefined,
    };
  }
  if (input.ctx.ui?.confirm) {
    const approved = await input.ctx.ui.confirm(
      "Approve dynamic workflow run?",
      formatWorkflowApprovalSummary(input.summary),
    );
    return { approved, method: "ui", reason: approved ? "confirmed in UI" : "cancelled in UI" };
  }
  throw new Error(
    `workflow_run approval required but no approval UI/reviewer is available: ${formatWorkflowApprovalSummaryLine(input.summary)}`,
  );
}

function workflowApprovalAskRequest(
  summary: SparkWorkflowRunApprovalSummary,
): Record<string, unknown> {
  return {
    mode: "approval",
    title: "Approve dynamic workflow run",
    context: formatWorkflowApprovalSummary(summary),
    questions: [
      {
        id: "approval",
        prompt: "Approve this dynamic workflow run?",
        type: "single",
        required: true,
        defaultValues: ["deny"],
        options: [
          {
            value: "approve",
            label: "Approve",
            description:
              "Run this workflow once with the displayed risk, resource, tool, isolation, and base metadata.",
          },
          {
            value: "deny",
            label: "Deny",
            description: "Do not run child agents or web/fetch/tool adapters for this workflow.",
          },
        ],
      },
    ],
  };
}

function approvalAnswerValues(answers: unknown): string[] {
  if (!isRecord(answers)) return [];
  const approval = answers.approval;
  if (!isRecord(approval) || !Array.isArray(approval.values)) return [];
  return approval.values.filter((value): value is string => typeof value === "string");
}

function approvalRecordSummary(
  summary: SparkWorkflowRunApprovalSummary,
): SparkDynamicWorkflowRunApproval["summary"] {
  return {
    required: true,
    scriptHash: summary.scriptHash,
    source: summary.source,
    workflowName: summary.workflowName,
    riskFlags: summary.riskFlags,
    resources: summary.resources,
    tools: summary.tools,
    isolation: summary.isolation,
    ...(summary.base ? { base: summary.base } : {}),
  };
}

function formatWorkflowApprovalSummary(summary: SparkWorkflowRunApprovalSummary): string {
  const lines = [
    `Workflow: ${summary.workflowName}`,
    `Source: ${summary.source}`,
    `Script hash: ${summary.scriptHash.slice(0, 12)}`,
    `Risks: ${summary.riskFlags.join(", ")}`,
    summary.reasons.length ? `Reasons: ${summary.reasons.join("; ")}` : undefined,
    `Resources: phases=${summary.resources.phaseCount}, agentCallSites=${summary.resources.agentCallSites}${summary.resources.concurrency ? `, concurrency=${summary.resources.concurrency}` : ""}${summary.resources.maxAgents ? `, maxAgents=${summary.resources.maxAgents}` : ""}${summary.resources.tokenBudget ? `, tokenBudget=${summary.resources.tokenBudget}` : ""}`,
    summary.resources.timeoutMs.length
      ? `Timeouts: ${summary.resources.timeoutMs.join(", ")}ms`
      : undefined,
    summary.tools.length ? `Allowed tools: ${summary.tools.join(", ")}` : undefined,
    summary.isolation.length ? `Isolation: ${summary.isolation.join(", ")}` : undefined,
    summary.base?.baseRef
      ? `Base: ref=${summary.base.baseRef} state=${summary.base.baseState ?? "unknown"} tree=${summary.base.baseTree ?? "unknown"}`
      : undefined,
    "Approval is scoped to this workflow run only and does not grant direct filesystem or shell access beyond the displayed workflow agent tool policy.",
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatWorkflowApprovalSummaryLine(summary: SparkWorkflowRunApprovalSummary): string {
  return `${summary.workflowName} ${summary.scriptHash.slice(0, 12)} risks=${summary.riskFlags.join(",") || "none"}`;
}

function extractWorkflowAllowedTools(script: string): string[] {
  const tools: string[] = [];
  for (const match of script.matchAll(/\ballowedTools\s*:\s*\[([\s\S]*?)\]/gu)) {
    const body = match[1] ?? "";
    for (const tool of body.matchAll(/["']([^"']+)["']/gu)) tools.push(tool[1] ?? "");
  }
  if (/\bwebSearch\s*\(/u.test(script)) tools.push("web_search");
  if (/\bfetchContent\s*\(/u.test(script)) tools.push("fetch_content");
  if (/\bartifactRecord\s*\(/u.test(script)) tools.push("artifactRecord");
  return uniqueStrings(tools.filter((tool) => tool.trim().length > 0));
}

function extractWorkflowTimeoutMs(script: string): number[] {
  return Array.from(script.matchAll(/\btimeoutMs\s*:\s*(\d+)/gu), (match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
}

function extractWorkflowIsolationModes(script: string): string[] {
  return uniqueStrings(
    Array.from(
      script.matchAll(/\bisolation\s*:\s*["']([^"']+)["']/gu),
      (match) => match[1] ?? "",
    ).filter((mode) => mode.trim().length > 0),
  );
}

function isWorkflowShellTool(tool: string): boolean {
  return /^(cue_exec|cue_run|cue_script|script_run|script_eval|bash|shell|terminal)$/u.test(tool);
}

function isWorkflowWriteTool(tool: string): boolean {
  return /^(edit|write|apply_patch|graft_write|graft_edit|graft_delete|artifact|artifactRecord)$/u.test(
    tool,
  );
}

function countRegexMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
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

function normalizeNestedWorkflowSelector(selector: string): string {
  const trimmed = selector.trim();
  if (/^(builtin|workspace|user):/.test(trimmed)) return trimmed;
  return `workspace:${trimmed}`;
}

async function resolveNestedWorkflowScript(
  cwd: string,
  selector: string,
): Promise<string | undefined> {
  const normalized = normalizeNestedWorkflowSelector(selector);
  const { script } = await readSavedWorkflow({ cwd, selector: normalized, includeUser: true });
  return script;
}

async function createSparkWorkflowAgentRunner(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
  base?: SparkDynamicWorkflowRunBaseMetadata;
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
        env: request.env,
        allowedTools: request.allowedTools,
      },
    );
    return {
      text: roleRunText(roleResult),
      metadata: { runRef: roleResult.record.ref },
      telemetry: workflowAgentTelemetryFromRoleRun(roleResult),
    };
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
        env: request.env,
        allowedTools: request.allowedTools,
      },
    );
    return {
      text: roleRunText(roleResult),
      metadata: { runRef: roleResult.record.ref },
      telemetry: workflowAgentTelemetryFromRoleRun(roleResult),
    };
  };
  return createSparkWorkflowRoleRunAdapter({
    roleRef: DEFAULT_WORKFLOW_ROLE_REF,
    graftBaseRef: workflowGraftBaseRef(input.base),
    runRoleInstruction: runRole,
    runModelInstruction: runModel,
  });
}

async function createSparkWorkflowWebSearchAdapter(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
}): Promise<(requestInput: { cwd: string; request: WorkflowWebSearchInput }) => Promise<unknown>> {
  const registry = await createSparkRoleRegistry(input.cwd);
  return async ({ request }) => {
    const roleResult = await runRoleInstructionOnly(
      registry,
      { roleRef: DEFAULT_WORKFLOW_ROLE_REF, instruction: workflowWebSearchInstruction(request) },
      {
        cwd: input.cwd,
        dryRun: false,
        timeoutMs: WORKFLOW_WEB_TOOL_TIMEOUT_MS,
        signal: input.signal,
        runName: "workflow-web-search",
        sessionModel: sessionModelName(input.ctx.model),
        allowedTools: ["web_search"],
      },
    );
    return {
      adapter: "webSearch",
      request,
      runRef: roleResult.record.ref,
      output: roleRunText(roleResult),
    };
  };
}

async function createSparkWorkflowFetchContentAdapter(input: {
  cwd: string;
  ctx: SparkToolContext;
  signal: AbortSignal;
}): Promise<
  (requestInput: { cwd: string; request: WorkflowFetchContentInput }) => Promise<unknown>
> {
  const registry = await createSparkRoleRegistry(input.cwd);
  return async ({ request }) => {
    const roleResult = await runRoleInstructionOnly(
      registry,
      { roleRef: DEFAULT_WORKFLOW_ROLE_REF, instruction: workflowFetchContentInstruction(request) },
      {
        cwd: input.cwd,
        dryRun: false,
        timeoutMs: WORKFLOW_WEB_TOOL_TIMEOUT_MS,
        signal: input.signal,
        runName: "workflow-fetch-content",
        sessionModel: sessionModelName(input.ctx.model),
        allowedTools: ["fetch_content"],
      },
    );
    return {
      adapter: "fetchContent",
      request,
      runRef: roleResult.record.ref,
      output: roleRunText(roleResult),
    };
  };
}

function workflowWebSearchInstruction(request: WorkflowWebSearchInput): string {
  return [
    "Use the web_search tool for this Spark workflow research step.",
    "Return a compact source-focused summary with URLs. Do not invent citations.",
    "Request JSON:",
    JSON.stringify(request, null, 2),
  ].join("\n");
}

function workflowFetchContentInstruction(request: WorkflowFetchContentInput): string {
  return [
    "Use the fetch_content tool for this Spark workflow source-fetch step.",
    "Return compact extracted facts relevant to the prompt and include the source URL.",
    "Request JSON:",
    JSON.stringify(request, null, 2),
  ].join("\n");
}

function workflowGraftBaseRef(
  base: SparkDynamicWorkflowRunBaseMetadata | undefined,
): string | undefined {
  if (!base) return undefined;
  if (base.baseTree?.trim()) return `tree:${base.baseTree.trim()}`;
  if (base.baseState?.trim()) return base.baseState.trim();
  return base.baseRef?.trim() || undefined;
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

function renderWorkflowRunResultText(
  source: string,
  result: WorkflowRunResult,
  run: Pick<
    SparkDynamicWorkflowRunRecord,
    "ref" | "scriptHash" | "base" | "usageTotals" | "spentTokens"
  >,
): string {
  const body = result.result === undefined ? "undefined" : JSON.stringify(result.result, null, 2);
  return [
    `Workflow run completed: ${source}`,
    `Run: ${run.ref}`,
    `Name: ${result.meta.name}`,
    `Script hash: ${run.scriptHash.slice(0, 12)}`,
    run.base?.baseRef ? `Base: ${run.base.baseRef}` : undefined,
    `Agents: ${result.agentCount}`,
    workflowRunUsageText(run),
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

function workflowRunUsageText(
  run: Pick<SparkDynamicWorkflowRunRecord, "usageTotals" | "spentTokens">,
): string | undefined {
  if (run.usageTotals) {
    const parts = [`tokens=${run.usageTotals.totalTokens}`];
    if (run.usageTotals.actualTokens > 0) parts.push(`actual=${run.usageTotals.actualTokens}`);
    if (run.usageTotals.estimatedTokens > 0)
      parts.push(`estimated=${run.usageTotals.estimatedTokens}`);
    if (run.usageTotals.costUsd !== undefined)
      parts.push(`cost=$${run.usageTotals.costUsd.toFixed(4)}`);
    return `Usage: ${parts.join(" · ")}`;
  }
  return run.spentTokens !== undefined ? `Usage: tokens=${run.spentTokens}` : undefined;
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

export function workflowAgentTelemetryFromRoleRun(
  result: SparkRoleRunResult,
): WorkflowAgentReportedTelemetry {
  const message = finalAssistantMessageWithUsage(result.jsonEvents);
  const telemetry: WorkflowAgentReportedTelemetry = {
    runRef: result.record.ref,
    lastActivityAt: assistantTimestampIso(message) ?? result.record.finishedAt,
    metadata: {
      runRef: result.record.ref,
      roleStatus: result.record.status,
    },
  };
  const usage = workflowUsageFromAssistantMessage(message, result.record.model);
  if (usage) telemetry.usage = usage;
  return telemetry;
}

function finalAssistantMessageWithUsage(events: unknown[]): Record<string, unknown> | undefined {
  for (const event of [...events].reverse()) {
    for (const candidate of assistantMessageCandidates(event).reverse()) {
      if (isRecord(candidate) && isRecord(candidate.usage)) return candidate;
    }
  }
  return undefined;
}

function assistantMessageCandidates(event: unknown): unknown[] {
  if (!isRecord(event)) return [];
  const candidates = [event.message, event.error, event.partial].filter(
    (candidate) => candidate !== undefined,
  );
  const messages = Array.isArray(event.messages) ? event.messages : [];
  return [...candidates, ...messages].filter(
    (candidate) => isRecord(candidate) && candidate.role === "assistant",
  );
}

function workflowUsageFromAssistantMessage(
  message: Record<string, unknown> | undefined,
  fallbackModel: string | undefined,
): WorkflowAgentReportedTelemetry["usage"] {
  if (!message || !isRecord(message.usage)) return undefined;
  const usage = message.usage;
  const inputTokens = numberField(usage, "input") ?? numberField(usage, "inputTokens");
  const outputTokens = numberField(usage, "output") ?? numberField(usage, "outputTokens");
  const cacheReadTokens = numberField(usage, "cacheRead") ?? numberField(usage, "cacheReadTokens");
  const cacheWriteTokens =
    numberField(usage, "cacheWrite") ?? numberField(usage, "cacheWriteTokens");
  const totalTokens = numberField(usage, "totalTokens") ?? numberField(usage, "total");
  const costUsd = usageCostUsd(usage);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    totalTokens === undefined &&
    costUsd === undefined
  )
    return undefined;
  return removeUndefinedFields({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    model: stringField(message, "model") ?? fallbackModel,
    provider: stringField(message, "provider"),
  });
}

function usageCostUsd(usage: Record<string, unknown>): number | undefined {
  const direct = numberField(usage, "costUsd");
  if (direct !== undefined) return direct;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0)
    return usage.cost;
  if (isRecord(usage.cost)) return numberField(usage.cost, "total");
  return undefined;
}

function assistantTimestampIso(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  if (typeof message.timestamp === "string" && message.timestamp.trim()) return message.timestamp;
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp))
    return undefined;
  const millis = message.timestamp < 10_000_000_000 ? message.timestamp * 1000 : message.timestamp;
  return new Date(millis).toISOString();
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function removeUndefinedFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function normalizeOptionalRunRef(value: unknown, field: string): RunRef | undefined {
  const normalized = normalizeOptionalWorkflowString(value, field);
  return normalized as RunRef | undefined;
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
