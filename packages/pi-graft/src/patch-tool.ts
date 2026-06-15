import { randomUUID } from "node:crypto";

import {
  builtinRoleRef,
  createDefaultRoleRegistry,
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  hydrateDefaultRoleRegistry,
  normalizeRoleRunMode,
  resolveRoleModelSetting,
  runRole,
  validateRoleModel,
  type RoleRunMode,
  type RoleRunRef,
  type RoleSpec,
} from "pi-roles";
import { Type } from "typebox";

import type {
  PiGraftExtensionApi,
  PiGraftToolCallComponent,
  PiGraftToolContext,
  PiGraftToolRenderTheme,
} from "./extension.ts";

export const GRAFT_PATCH_PRESET_ID = "graft_patch";

export const GRAFT_PATCH_ALLOWED_TOOLS = [
  "graft_help",
  "graft_init",
  "graft_status",
  "graft_ps",
  "graft_doctor",
  "graft_read",
  "graft_write",
  "graft_edit",
  "graft_delete",
  "graft_candidate_from_scratch",
  "graft_validate",
  "graft_admit",
  "graft_show",
  "graft_evidence",
  "graft_candidates",
  "graft_search",
  "graft_materialize",
  "graft_repo",
] as const;

interface GraftPatchParams {
  instruction: string;
  mode?: RoleRunMode;
  piCommand?: string;
  cwd?: string;
  sessionDir?: string;
  forkFromSession?: string;
  timeoutMs?: number;
  model?: string;
}

interface RoleCallDeliverySummary {
  status: "delivered" | "error" | "non_json_output" | "empty";
  finalAssistantText?: string;
  errorMessage?: string;
  stdoutNonJsonTail?: string;
  jsonEventCount: number;
}

class GraftPatchToolCallText implements PiGraftToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    const maxWidth = Math.max(1, width);
    return [this.text.length > maxWidth ? `${this.text.slice(0, maxWidth - 1)}…` : this.text];
  }
}

export function registerPiGraftPatchTool(pi: PiGraftExtensionApi): void {
  pi.registerTool({
    name: "graft_patch",
    label: "Graft Patch",
    description: [
      "Run a Graft-owned patcher child run.",
      "The child receives only Graft scratch, candidate, validation, evidence, repository, and materialization tools.",
      "If the patch request is unclear, the child must request clarification upward instead of editing or creating a candidate.",
    ].join(" "),
    parameters: Type.Object({
      instruction: Type.String({
        description:
          "Concrete patch request for the child patcher run. If unclear, the child should request clarification upward.",
      }),
      mode: Type.Optional(
        Type.String({
          description: [
            "fresh | forked.",
            "Defaults to forked when the current session file is available; otherwise fresh.",
          ].join(" "),
        }),
      ),
      piCommand: Type.Optional(
        Type.String({ description: "Pi executable to launch. Defaults to pi." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child run." })),
      sessionDir: Type.Optional(Type.String({ description: "Explicit Pi session directory." })),
      forkFromSession: Type.Optional(
        Type.String({
          description: "Parent session/context for forked mode. Defaults to the current session.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Child run timeout in milliseconds." })),
      model: Type.Optional(
        Type.String({
          description:
            "Concrete Pi model to validate for this run. Saved defaults live in role model settings.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderGraftPatchCall(
        [
          formatPatchStringArg(args.instruction, { maxLength: 80 }),
          formatPatchStringArg(args.mode, { prefix: "mode=" }),
          formatPatchStringArg(args.model, { prefix: "model=", maxLength: 40 }),
          formatPatchNumberArg(args.timeoutMs, { prefix: "timeout=" }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = normalizePatchParams(params);
      const cwd = p.cwd ?? ctx?.cwd;
      if (!cwd) throw new Error("graft_patch requires cwd or ctx.cwd");

      const registry = createDefaultRoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd);
      const role = registry.get(builtinRoleRef("worker"));
      const forkFromSession = p.forkFromSession ?? currentSessionFile(ctx);
      const mode = resolvePatchMode(p.mode, forkFromSession);
      if (mode === "forked" && !forkFromSession)
        throw new Error(
          "graft_patch forked mode requires forkFromSession or a current session file",
        );
      const piCommand = p.piCommand ?? "pi";
      const model = await resolvePatchRoleModel({
        role,
        explicitModel: p.model,
        piCommand,
        cwd,
        ui: ctx?.ui,
      });
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const result = await runRole({
        runRef,
        roleRef: role.ref,
        mode,
        systemPrompt: role.systemPrompt,
        model,
        allowedTools: [...GRAFT_PATCH_ALLOWED_TOOLS],
        instruction: p.instruction,
        runGuidance: graftPatchRunGuidance(),
        sessionDir: p.sessionDir,
        forkFromSession: mode === "forked" ? forkFromSession : undefined,
        piCommand,
        cwd,
        timeoutMs: p.timeoutMs,
        signal,
      });
      const stdoutTail = result.stdout ? tailText(result.stdout, 12_000) : undefined;
      const stderrTail = result.stderr ? tailText(result.stderr, 8_000) : undefined;
      const stdoutNonJsonTail = nonJsonStdoutTail(result.stdout, 12_000);
      const delivery = summarizeRoleCallDelivery({
        finalAssistantText: extractFinalAssistantText(result.jsonEvents),
        errorMessage: extractAssistantErrorText(result.jsonEvents),
        stdoutNonJsonTail,
        jsonEventCount: result.jsonEvents.length,
      });
      const displayStatus =
        result.record.status === "succeeded" && delivery.status === "error"
          ? "failed"
          : result.record.status;
      const summary = [
        `Graft patch run ${displayStatus}: ${GRAFT_PATCH_PRESET_ID} via ${role.id} (${role.ref})`,
        formatPatchRunIdentity({
          runRef: result.record.ref,
          mode: result.record.mode,
          model: result.record.model,
          sessionDir: result.record.sessionDir,
          forkFromSession: result.record.forkFromSession,
        }),
        `allowedTools: ${GRAFT_PATCH_ALLOWED_TOOLS.join(", ")}`,
        result.record.errorMessage ? `error: ${result.record.errorMessage}` : undefined,
        renderRoleCallDelivery(delivery),
        result.record.status !== "succeeded" && stdoutTail && !stdoutNonJsonTail
          ? `stdout:\n${stdoutTail}`
          : undefined,
        stderrTail ? `stderr:\n${stderrTail}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: {
          preset: {
            id: GRAFT_PATCH_PRESET_ID,
            kind: "function",
            baseRoleRef: role.ref,
            allowedTools: [...GRAFT_PATCH_ALLOWED_TOOLS],
            runGuidance: graftPatchRunGuidance(),
          },
          role: compactRole(role),
          mode,
          runRef,
          cwd,
          model,
          allowedTools: [...GRAFT_PATCH_ALLOWED_TOOLS],
          record: result.record,
          jsonEventCount: result.jsonEvents.length,
          delivery,
          stdoutTail,
          stderrTail,
        },
      };
    },
  });
}

function graftPatchRunGuidance(): string {
  return [
    "You are running Graft's patch tool on top of the worker role.",
    "Use only the Graft scratch, candidate, validation, evidence, repository, and materialization tools made available by this tool.",
    "Do not edit the working tree directly; create and validate a Graft candidate, then report the candidate or admitted patch with evidence.",
    "If the requested patch is ambiguous, underspecified, contradictory, or missing success criteria, stop and ask upward for clarification instead of changing files.",
  ].join("\n");
}

function normalizePatchParams(params: Record<string, unknown>): GraftPatchParams {
  return {
    instruction: normalizeRequiredString(params.instruction, "graft_patch instruction"),
    mode: normalizeOptionalMode(params.mode, "graft_patch mode"),
    piCommand: normalizeOptionalString(params.piCommand, "graft_patch piCommand"),
    cwd: normalizeOptionalString(params.cwd, "graft_patch cwd"),
    sessionDir: normalizeOptionalString(params.sessionDir, "graft_patch sessionDir"),
    forkFromSession: normalizeOptionalString(params.forkFromSession, "graft_patch forkFromSession"),
    timeoutMs: normalizeOptionalPositiveInteger(params.timeoutMs, "graft_patch timeoutMs"),
    model: normalizeOptionalString(params.model, "graft_patch model"),
  };
}

function resolvePatchMode(
  explicitMode: RoleRunMode | undefined,
  forkFromSession: string | undefined,
): RoleRunMode {
  if (explicitMode) return explicitMode;
  return forkFromSession ? "forked" : "fresh";
}

function currentSessionFile(ctx: PiGraftToolContext | undefined): string | undefined {
  const value = ctx?.sessionManager?.getSessionFile?.();
  return value?.trim() || undefined;
}

async function resolvePatchRoleModel(input: {
  role: RoleSpec;
  explicitModel?: string;
  piCommand: string;
  cwd: string;
  ui?: PiGraftToolContext["ui"];
}): Promise<string | undefined> {
  const resolved = await resolveRoleModelSetting({
    explicitModel: input.explicitModel,
    roleRef: input.role.ref,
    roleId: input.role.id,
    roleName: input.role.id,
    projectStore: defaultProjectRoleModelSettingsStore(input.cwd),
    userStore: defaultUserRoleModelSettingsStore(),
  });
  if (resolved) {
    if (resolved.source === "explicit")
      await validateRoleModel({
        piCommand: input.piCommand,
        model: resolved.model,
        cwd: input.cwd,
      });
    return resolved.model;
  }

  const selected = await input.ui?.input?.(`Choose Pi model for Graft patch role ${input.role.id}`);
  const model = selected?.trim();
  if (!model) {
    throw new Error(
      `graft_patch role model setting required for ${input.role.id} (${input.role.ref}); ` +
        'provide model or save one with role({ action: "model_set" })',
    );
  }
  await validateRoleModel({ piCommand: input.piCommand, model, cwd: input.cwd });
  const entry = await defaultUserRoleModelSettingsStore().save(input.role.ref, model);
  input.ui?.notify?.(
    `Saved model setting for Graft patch role ${input.role.id}: ${entry.model}`,
    "success",
  );
  return entry.model;
}

function normalizeOptionalMode(value: unknown, field: string): RoleRunMode | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return normalizeRoleRunMode(value);
  } catch {
    throw new Error(`${field} must be fresh or forked`);
  }
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (value === undefined || value === null) throw new Error(`${field} is required`);
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  return text || undefined;
}

function normalizeOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${field} must be a positive integer`);
  return value;
}

function compactRole(role: RoleSpec) {
  return {
    ref: role.ref,
    id: role.id,
    source: role.source,
    description: role.description,
    systemPromptChars: role.systemPrompt.length,
    allowedTools: role.allowedTools,
  };
}

function formatPatchRunIdentity(input: {
  runRef: string;
  mode: RoleRunMode;
  model?: string;
  sessionDir?: string;
  forkFromSession?: string;
}): string {
  return Object.entries({
    runRef: input.runRef,
    mode: input.mode,
    model: input.model,
    sessionDir: input.sessionDir,
    forkFromSession: input.forkFromSession,
  })
    .filter((item): item is [string, string] => item[1] !== undefined && item[1] !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

function summarizeRoleCallDelivery(input: {
  finalAssistantText?: string;
  errorMessage?: string;
  stdoutNonJsonTail?: string;
  jsonEventCount: number;
}): RoleCallDeliverySummary {
  if (input.errorMessage) {
    return {
      status: "error",
      errorMessage: input.errorMessage,
      stdoutNonJsonTail: input.stdoutNonJsonTail,
      jsonEventCount: input.jsonEventCount,
    };
  }
  if (input.finalAssistantText) {
    return {
      status: "delivered",
      finalAssistantText: input.finalAssistantText,
      stdoutNonJsonTail: input.stdoutNonJsonTail,
      jsonEventCount: input.jsonEventCount,
    };
  }
  if (input.stdoutNonJsonTail) {
    return {
      status: "non_json_output",
      stdoutNonJsonTail: input.stdoutNonJsonTail,
      jsonEventCount: input.jsonEventCount,
    };
  }
  return { status: "empty", jsonEventCount: input.jsonEventCount };
}

function renderRoleCallDelivery(delivery: RoleCallDeliverySummary): string | undefined {
  if (delivery.status === "delivered" && delivery.finalAssistantText) {
    return `result:\n${truncateBlock(delivery.finalAssistantText, 12_000)}`;
  }
  if (delivery.status === "error" && delivery.errorMessage) {
    return `delivery error:\n${truncateBlock(delivery.errorMessage, 12_000)}`;
  }
  if (delivery.status === "non_json_output" && delivery.stdoutNonJsonTail) {
    return `output:\n${delivery.stdoutNonJsonTail}`;
  }
  return delivery.jsonEventCount > 0
    ? `delivery: empty - no final assistant message found ` +
        `(${delivery.jsonEventCount} JSON events captured).`
    : "delivery: empty - child process exited without assistant output.";
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

function extractAssistantErrorText(events: unknown[]): string | undefined {
  for (const event of [...events].reverse()) {
    const direct = messageErrorText(eventMessage(event));
    if (direct) return direct;
    const eventError = messageErrorText(event);
    if (eventError) return eventError;

    const messages = eventMessages(event);
    for (const message of [...messages].reverse()) {
      const text = messageErrorText(message);
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

function messageErrorText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const item = message as { stopReason?: unknown; errorMessage?: unknown; diagnostics?: unknown };
  const direct = typeof item.errorMessage === "string" ? item.errorMessage.trim() : "";
  if (direct) return direct;
  if (Array.isArray(item.diagnostics)) {
    for (const diagnostic of item.diagnostics) {
      if (!diagnostic || typeof diagnostic !== "object") continue;
      const error = (diagnostic as { error?: unknown }).error;
      if (!error || typeof error !== "object") continue;
      const messageText = (error as { message?: unknown }).message;
      if (typeof messageText === "string" && messageText.trim()) return messageText.trim();
    }
  }
  if (item.stopReason === "error") return "assistant stopped with error";
  return undefined;
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

function nonJsonStdoutTail(value: string, maxLength: number): string | undefined {
  const text = value
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        JSON.parse(trimmed);
        return false;
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
  return text ? tailText(text, maxLength) : undefined;
}

function tailText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `…${value.slice(value.length - maxLength)}`;
}

function truncateBlock(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function renderGraftPatchCall(
  parts: Array<string | undefined>,
  theme: PiGraftToolRenderTheme,
): PiGraftToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.("graft_patch ") ?? "graft_patch ") ?? "graft_patch ";
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const renderedArgs = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new GraftPatchToolCallText(`${title}${renderedArgs}`.trimEnd());
}

function formatPatchStringArg(
  value: unknown,
  options: { prefix?: string; maxLength?: number } = {},
): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const maxLength = options.maxLength ?? 80;
  const normalized = raw.length <= maxLength ? raw : `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
  const rendered = /\s/u.test(normalized) ? JSON.stringify(normalized) : normalized;
  return `${options.prefix ?? ""}${rendered}`;
}

function formatPatchNumberArg(
  value: unknown,
  options: { prefix?: string } = {},
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}`;
}
