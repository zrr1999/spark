import { randomUUID } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  RoleRegistry,
  createRoleSpec,
  defaultProjectRoleStore,
  defaultUserRoleModelBindingStore,
  defaultUserRoleStore,
  hydrateDefaultRoleRegistry,
  normalizeRoleRunMode,
  runRole,
  saveValidatedRoleModelBinding,
  type RoleRunMode,
  type RoleRunRef,
  type RoleSource,
  type RoleSpec,
  type RoleSpecProposal,
} from "./index.ts";

export interface PiRolesExtensionApi {
  registerTool(config: PiRolesToolConfig): void;
}

interface PiRolesToolConfig {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: {
      cwd?: string;
      ui?: {
        notify?: (message: string, level?: string) => void;
        input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
      };
    },
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export interface CallRoleToolParams {
  role: string;
  instruction: string;
  mode?: RoleRunMode;
  piCommand?: string;
  cwd?: string;
  sessionDir?: string;
  forkFromSession?: string;
  timeoutMs?: number;
  includeUser?: boolean;
  model?: string;
}

export function registerPiRolesTools(pi: PiRolesExtensionApi): void {
  pi.registerTool({
    name: "list_roles",
    label: "List Roles",
    description: "List builtin, project, and optionally user Pi role specs.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.String({ description: "builtin | project | user. Omit to list all loaded roles." }),
      ),
      includeUser: Type.Optional(
        Type.Boolean({
          description: "Also load user roles from ~/.agents/roles. Defaults to false.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum roles to show. Default: 50." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "list_roles",
        [
          formatStringArg(args.source, { fallback: "all" }),
          args.includeUser === true ? "include-user" : undefined,
          formatNumberArg(args.limit, { prefix: "limit=" }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "list_roles");
      const includeUser = normalizeOptionalBoolean(
        params.includeUser,
        false,
        "list_roles includeUser",
      );
      const source = normalizeRoleSource(params.source, "list_roles source");
      const limit = normalizeLimit(params.limit, 50, "list_roles limit");
      const registry = new RoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
      const roles = registry.list(source ? { source } : {}).slice(0, limit);
      const allCount = registry.list(source ? { source } : {}).length;
      const lines = roles.map(
        (role) => `- [${role.source}] ${role.id} (${role.ref}) — ${role.description}`,
      );
      if (allCount > roles.length) lines.push(`- … ${allCount - roles.length} more role(s)`);
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No matching roles." }],
        details: {
          count: allCount,
          shown: roles.length,
          roles: roles.map(compactRole),
        },
      };
    },
  });

  pi.registerTool({
    name: "get_role",
    label: "Get Role",
    description: "Inspect one builtin, project, or user Pi role spec.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. worker or role:builtin-worker.",
      }),
      includeUser: Type.Optional(
        Type.Boolean({
          description: "Also load user roles from ~/.agents/roles. Defaults to false.",
        }),
      ),
      includePrompt: Type.Optional(
        Type.Boolean({ description: "Include the full system prompt. Defaults to false." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "get_role",
        [
          formatStringArg(args.role),
          args.includePrompt === true ? "include-prompt" : undefined,
          args.includeUser === true ? "include-user" : undefined,
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "get_role");
      const registry = new RoleRegistry();
      const includeUser = normalizeOptionalBoolean(
        params.includeUser,
        false,
        "get_role includeUser",
      );
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
      const role = registry.select(normalizeRequiredString(params.role, "get_role role"));
      const includePrompt = normalizeOptionalBoolean(
        params.includePrompt,
        false,
        "get_role includePrompt",
      );
      const promptPreview = truncateInline(role.systemPrompt, 240);
      const modelBinding = await defaultUserRoleModelBindingStore().get(role.ref);
      const lines = [
        `${role.id} (${role.ref})`,
        `source: ${role.source}`,
        `description: ${role.description}`,
        `defaultModel: ${role.defaultModel ?? "none"}`,
        `modelBinding: ${modelBinding ? `${modelBinding.model} (validated ${modelBinding.validatedAt})` : "not set; first actual run will ask for a model"}`,
        `systemPrompt: ${role.systemPrompt.length} chars${includePrompt ? "" : `; preview=${JSON.stringify(promptPreview)}`}`,
      ];
      if (includePrompt) lines.push("", role.systemPrompt);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          role: includePrompt
            ? { ...compactRole(role), modelBinding, systemPrompt: role.systemPrompt }
            : { ...compactRole(role), modelBinding },
        },
      };
    },
  });

  pi.registerTool({
    name: "create_role",
    label: "Create Role",
    description: "Create and persist a project or explicitly requested user Pi role spec.",
    parameters: Type.Object({
      id: Type.String({ description: "Stable role spec id." }),
      description: Type.String({ description: "What this role spec is for." }),
      systemPrompt: Type.String({ description: "Fixed system prompt for the role spec." }),
      rationale: Type.String({ description: "Why this role spec should exist." }),
      expectedUses: Type.Array(Type.String()),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      allowedTools: Type.Optional(Type.Array(Type.String())),
      defaultModel: Type.Optional(Type.String()),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "create_role",
        [
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.source, { fallback: "project" }),
          formatStringArg(args.description, { maxLength: 80 }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "create_role");
      const source = normalizeWritableRoleSource(params.source);
      const proposal: RoleSpecProposal = {
        id: normalizeRequiredString(params.id, "create_role id"),
        source,
        description: normalizeRequiredString(params.description, "create_role description"),
        systemPrompt: normalizeRequiredString(params.systemPrompt, "create_role systemPrompt"),
        rationale: normalizeRequiredString(params.rationale, "create_role rationale"),
        expectedUses: normalizeRequiredStringArray(params.expectedUses, "create_role expectedUses"),
        allowedTools: normalizeOptionalStringArray(params.allowedTools, "create_role allowedTools"),
        defaultModel: normalizeOptionalString(params.defaultModel, "create_role defaultModel"),
        origin: { kind: "manual" },
      };
      const role = createRoleSpec(proposal);
      const store = source === "user" ? defaultUserRoleStore() : defaultProjectRoleStore(cwd);
      await store.save(role);
      return {
        content: [
          { type: "text", text: `Role created: ${role.id} (${role.ref}) source=${role.source}` },
        ],
        details: { role: compactRole(role) },
      };
    },
  });

  pi.registerTool({
    name: "call_role",
    label: "Call Role",
    description:
      "Call one reusable Pi role directly with an explicit instruction. This is a one-off role invocation and is not attached to Spark tasks or DAG runs. Launches a fresh child Pi run by default, or an explicitly forked child run when mode=forked.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. worker or role:builtin-worker.",
      }),
      instruction: Type.String({ description: "Concrete instruction for this one role call." }),
      mode: Type.Optional(
        Type.Union([Type.Literal("fresh"), Type.Literal("forked")], {
          description: "fresh | forked. Defaults to fresh; forked requires forkFromSession.",
        }),
      ),
      piCommand: Type.Optional(
        Type.String({ description: "Pi executable to launch. Defaults to pi." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child run." })),
      sessionDir: Type.Optional(Type.String({ description: "Explicit Pi session directory." })),
      forkFromSession: Type.Optional(
        Type.String({
          description: "Parent session/context for forked mode. Required when mode=forked.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Child run timeout in milliseconds." })),
      model: Type.Optional(
        Type.String({
          description:
            "Concrete Pi model to validate and bind on first actual run when no user binding exists.",
        }),
      ),
      includeUser: Type.Optional(
        Type.Boolean({
          description: "Also load user roles from ~/.agents/roles. Defaults to false.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "call_role",
        [
          formatStringArg(args.role),
          formatStringArg(args.mode, { fallback: "fresh" }),
          formatNumberArg(args.timeoutMs, { prefix: "timeout=" }),
          formatStringArg(args.cwd, { prefix: "cwd=" }),
          formatStringArg(args.model, { prefix: "model=" }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = normalizeCallRoleToolParams(params);
      const cwd = p.cwd ?? requiredPiRolesCwd(ctx, "call_role");
      const registry = new RoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser: p.includeUser });
      const role = registry.select(p.role);
      const mode = p.mode ?? "fresh";
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const model = await resolveRoleModelForCall({
        role,
        explicitModel: p.model,
        piCommand: p.piCommand ?? "pi",
        cwd,
        actualRun: true,
        ui: ctx.ui,
      });
      const commandInput = {
        runRef,
        roleRef: role.ref,
        mode,
        systemPrompt: role.systemPrompt,
        model,
        instruction: p.instruction,
        sessionDir: p.sessionDir,
        forkFromSession: p.forkFromSession,
        piCommand: p.piCommand ?? "pi",
        cwd,
        timeoutMs: p.timeoutMs,
        signal,
      };

      const result = await runRole(commandInput);
      const stdoutTail = result.stdout ? tailText(result.stdout, 12_000) : undefined;
      const stderrTail = result.stderr ? tailText(result.stderr, 8_000) : undefined;
      const stdoutNonJsonTail = nonJsonStdoutTail(result.stdout, 12_000);
      const finalAssistantText = extractFinalAssistantText(result.jsonEvents);
      const summary = [
        `Role call ${result.record.status}: ${role.id} (${role.ref})`,
        formatRoleRunIdentity({
          runRef: result.record.ref,
          mode: result.record.mode,
          model: result.record.model,
          sessionDir: result.record.sessionDir,
          forkFromSession: result.record.forkFromSession,
        }),
        result.record.errorMessage ? `error: ${result.record.errorMessage}` : undefined,
        finalAssistantText
          ? `result:\n${truncateBlock(finalAssistantText, 12_000)}`
          : stdoutNonJsonTail
            ? `output:\n${stdoutNonJsonTail}`
            : result.jsonEvents.length > 0
              ? `No final assistant message found (${result.jsonEvents.length} JSON events captured).`
              : undefined,
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
          role: compactRole(role),
          mode,
          runRef,
          cwd,
          model,
          record: result.record,
          jsonEventCount: result.jsonEvents.length,
          stdoutTail,
          stderrTail,
        },
      };
    },
  });
}

function requiredPiRolesCwd(ctx: { cwd?: string }, toolName: string): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd;
  throw new Error(`${toolName} requires ctx.cwd or an explicit cwd parameter.`);
}

async function resolveRoleModelForCall(input: {
  role: RoleSpec;
  explicitModel?: string;
  piCommand: string;
  cwd: string;
  actualRun: boolean;
  ui?: {
    notify?: (message: string, level?: string) => void;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  };
}): Promise<string | undefined> {
  const store = defaultUserRoleModelBindingStore();
  const existing = await store.get(input.role.ref);
  if (existing) return existing.model;
  if (!input.actualRun) return input.explicitModel?.trim() || undefined;

  const selected =
    input.explicitModel?.trim() ||
    (await input.ui?.input?.(`Choose Pi model for role ${input.role.id}`, input.role.defaultModel));
  const model = selected?.trim();
  if (!model) {
    throw new Error(
      `role model binding required for ${input.role.id} (${input.role.ref}); provide model or rerun with an interactive UI`,
    );
  }
  const binding = await saveValidatedRoleModelBinding({
    store,
    roleRef: input.role.ref,
    model,
    piCommand: input.piCommand,
    cwd: input.cwd,
  });
  input.ui?.notify?.(`Saved model binding for role ${input.role.id}: ${binding.model}`, "success");
  return binding.model;
}

function normalizeCallRoleToolParams(params: Record<string, unknown>): CallRoleToolParams {
  const role = normalizeRequiredString(params.role, "call_role role");
  const instruction = normalizeRequiredString(params.instruction, "call_role instruction");
  const mode = normalizeRoleRunMode(params.mode);
  if (Object.hasOwn(params, "dryRun"))
    throw new Error(
      "call_role dryRun is no longer supported; call_role always launches a child run",
    );
  const forkFromSession = normalizeOptionalString(
    params.forkFromSession,
    "call_role forkFromSession",
  );
  if (mode === "forked" && !forkFromSession)
    throw new Error("call_role forked mode requires forkFromSession");
  return {
    role,
    instruction,
    mode,
    piCommand: normalizeOptionalString(params.piCommand, "call_role piCommand"),
    cwd: normalizeOptionalString(params.cwd, "call_role cwd"),
    sessionDir: normalizeOptionalString(params.sessionDir, "call_role sessionDir"),
    forkFromSession,
    timeoutMs: normalizeOptionalPositiveInteger(params.timeoutMs, "call_role timeoutMs"),
    includeUser: normalizeOptionalBoolean(params.includeUser, false, "call_role includeUser"),
    model: normalizeOptionalString(params.model, "call_role model"),
  };
}

function normalizeRoleSource(value: unknown, field: string): RoleSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "builtin" || value === "project" || value === "user") return value;
  throw new Error(`${field} must be builtin, project, or user`);
}

function normalizeWritableRoleSource(value: unknown): Exclude<RoleSource, "builtin"> {
  if (value === undefined || value === null) return "project";
  if (value === "user") return "user";
  if (value === "project") return "project";
  throw new Error("create_role source must be project or user");
}

function normalizeLimit(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function normalizeOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${field} must be a positive integer`);
  return value;
}

function normalizeOptionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean`);
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (value === undefined || value === null) throw new Error(`${field} is required`);
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

function normalizeRequiredStringArray(value: unknown, field: string): string[] {
  const items = normalizeOptionalStringArray(value, field) ?? [];
  if (items.length === 0) throw new Error(`${field} must be a non-empty array of strings`);
  return items;
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  return text || undefined;
}

function normalizeOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const items = value.map((item) => {
    if (typeof item !== "string") throw new Error(`${field} must be an array of strings`);
    return item.trim();
  });
  if (items.some((item) => !item))
    throw new Error(`${field} must be an array of non-empty strings`);
  return items.length > 0 ? items : undefined;
}

function compactRole(role: RoleSpec) {
  return {
    ref: role.ref,
    id: role.id,
    source: role.source,
    description: role.description,
    systemPromptChars: role.systemPrompt.length,
    allowedTools: role.allowedTools,
    defaultModel: role.defaultModel,
  };
}

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = /\s|["'`]/.test(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? 80)}`;
}

function formatNumberArg(value: unknown, options: { prefix?: string } = {}): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}`;
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatRoleRunIdentity(input: {
  runRef: string;
  mode: RoleRunMode;
  model?: string;
  sessionDir?: string;
  forkFromSession?: string;
}): string {
  return compactKeyValues([
    ["runRef", input.runRef],
    ["mode", input.mode],
    ["model", input.model],
    ["sessionDir", input.sessionDir],
    ["forkFromSession", input.forkFromSession],
  ]);
}

function compactKeyValues(items: Array<[string, string | number | undefined]>): string {
  return items
    .filter((item): item is [string, string | number] => item[1] !== undefined && item[1] !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

function truncateBlock(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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

function nonJsonStdoutTail(value: string, maxLength: number): string | undefined {
  const text = value
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (looksLikePiJsonProtocolFragment(trimmed)) return false;
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    })
    .join("\n");
  return text ? tailText(text, maxLength) : undefined;
}

function looksLikePiJsonProtocolFragment(value: string): boolean {
  if (value.startsWith('{"type":"') || value.startsWith('{"type": "')) return true;
  if (value.startsWith('"type":"') || value.startsWith('"type": "')) return true;
  return (
    value.includes('"assistantMessageEvent"') ||
    value.includes('"toolCallId"') ||
    value.includes('"toolName"') ||
    value.includes('"message_update"') ||
    value.includes('"message_end"') ||
    value.includes('"turn_end"')
  );
}

function tailText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(value.length - maxLength)}`;
}

export default function piRolesExtension(pi: PiRolesExtensionApi): void {
  registerPiRolesTools(pi);
}
