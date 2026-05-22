import { randomUUID } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  RoleRegistry,
  buildRoleRunArgs,
  createRoleSpec,
  defaultProjectRoleStore,
  defaultUserRoleStore,
  hydrateDefaultRoleRegistry,
  runRole,
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
    ctx: { cwd?: string; ui?: { notify?: (message: string, level?: string) => void } },
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
  dryRun?: boolean;
  piCommand?: string;
  cwd?: string;
  sessionDir?: string;
  forkFromSession?: string;
  timeoutMs?: number;
  includeUser?: boolean;
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
      const cwd = ctx.cwd ?? process.cwd();
      const includeUser = params.includeUser === true;
      const source = normalizeRoleSource(params.source);
      const limit = normalizeLimit(params.limit, 50);
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
      const cwd = ctx.cwd ?? process.cwd();
      const registry = new RoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser: params.includeUser === true });
      const role = registry.select(requiredString(params.role, "get_role role is required"));
      const includePrompt = params.includePrompt === true;
      const promptPreview = truncateInline(role.systemPrompt, 240);
      const lines = [
        `${role.id} (${role.ref})`,
        `source: ${role.source}`,
        `description: ${role.description}`,
        `systemPrompt: ${role.systemPrompt.length} chars${includePrompt ? "" : `; preview=${JSON.stringify(promptPreview)}`}`,
      ];
      if (includePrompt) lines.push("", role.systemPrompt);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          role: includePrompt
            ? { ...compactRole(role), systemPrompt: role.systemPrompt }
            : compactRole(role),
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
      const cwd = ctx.cwd ?? process.cwd();
      const source = normalizeWritableRoleSource(params.source);
      const proposal: RoleSpecProposal = {
        id: requiredString(params.id, "create_role id is required"),
        source,
        description: requiredString(params.description, "create_role description is required"),
        systemPrompt: requiredString(params.systemPrompt, "create_role systemPrompt is required"),
        rationale: requiredString(params.rationale, "create_role rationale is required"),
        expectedUses: normalizeStringArray(
          params.expectedUses,
          "create_role expectedUses are required",
        ),
        allowedTools: normalizeOptionalStringArray(params.allowedTools),
        defaultModel:
          typeof params.defaultModel === "string" && params.defaultModel.trim()
            ? params.defaultModel.trim()
            : undefined,
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
      "Call one reusable Pi role directly with an explicit instruction. This is a one-off role invocation and is not attached to Spark tasks or DAG runs. Defaults to dry-run and returns the Pi CLI args; set dryRun=false to launch a fresh or explicitly forked child Pi run.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. worker or role:builtin-worker.",
      }),
      instruction: Type.String({ description: "Concrete instruction for this one role call." }),
      mode: Type.Optional(
        Type.String({
          description: "fresh | forked. Defaults to fresh; forked requires forkFromSession.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "When true, only resolve the role and return the Pi CLI args.",
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
          args.dryRun === false ? "run" : "dry-run",
          formatNumberArg(args.timeoutMs, { prefix: "timeout=" }),
          formatStringArg(args.cwd, { prefix: "cwd=" }),
        ],
        theme,
      );
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const p = normalizeCallRoleToolParams(params);
      const cwd = p.cwd ?? ctx.cwd ?? process.cwd();
      const registry = new RoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser: p.includeUser });
      const role = registry.select(p.role);
      const mode = p.mode ?? "fresh";
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const commandInput = {
        runRef,
        roleRef: role.ref,
        mode,
        systemPrompt: role.systemPrompt,
        instruction: p.instruction,
        sessionDir: p.sessionDir,
        forkFromSession: p.forkFromSession,
        piCommand: p.piCommand ?? "pi",
        cwd,
        timeoutMs: p.timeoutMs,
        signal,
      };

      if (p.dryRun !== false) {
        const args = buildRoleRunArgs(commandInput);
        return {
          content: [
            {
              type: "text",
              text: [
                `Role call dry-run: ${role.id} (${role.ref})`,
                `mode: ${mode}`,
                `cwd: ${cwd}`,
                `piCommand: ${commandInput.piCommand}`,
                `args: ${JSON.stringify(args)}`,
              ].join("\n"),
            },
          ],
          details: {
            dryRun: true,
            role: compactRole(role),
            mode,
            runRef,
            cwd,
            piCommand: commandInput.piCommand,
            args,
          },
        };
      }

      const result = await runRole(commandInput);
      const stdoutTail = result.stdout ? tailText(result.stdout, 12_000) : undefined;
      const stderrTail = result.stderr ? tailText(result.stderr, 8_000) : undefined;
      const summary = [
        `Role call ${result.record.status}: ${role.id} (${role.ref})`,
        `runRef: ${result.record.ref}`,
        `mode: ${result.record.mode}`,
        result.record.errorMessage ? `error: ${result.record.errorMessage}` : undefined,
        stdoutTail ? `stdout:\n${stdoutTail}` : undefined,
        stderrTail ? `stderr:\n${stderrTail}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: {
          dryRun: false,
          role: compactRole(role),
          mode,
          runRef,
          cwd,
          record: result.record as unknown as Record<string, unknown>,
          jsonEventCount: result.jsonEvents.length,
          stdoutTail,
          stderrTail,
        },
      };
    },
  });
}

function normalizeCallRoleToolParams(params: Record<string, unknown>): CallRoleToolParams {
  const role = typeof params.role === "string" ? params.role.trim() : "";
  const instruction = typeof params.instruction === "string" ? params.instruction.trim() : "";
  if (!role) throw new Error("call_role role is required");
  if (!instruction) throw new Error("call_role instruction is required");
  const mode = params.mode === "forked" ? "forked" : "fresh";
  const forkFromSession =
    typeof params.forkFromSession === "string" ? params.forkFromSession.trim() : undefined;
  if (mode === "forked" && !forkFromSession)
    throw new Error("call_role forked mode requires forkFromSession");
  return {
    role,
    instruction,
    mode,
    dryRun: typeof params.dryRun === "boolean" ? params.dryRun : true,
    piCommand:
      typeof params.piCommand === "string" && params.piCommand.trim()
        ? params.piCommand.trim()
        : undefined,
    cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
    sessionDir:
      typeof params.sessionDir === "string" && params.sessionDir.trim()
        ? params.sessionDir.trim()
        : undefined,
    forkFromSession,
    timeoutMs:
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : undefined,
    includeUser: params.includeUser === true,
  };
}

function normalizeRoleSource(value: unknown): RoleSource | undefined {
  return value === "builtin" || value === "project" || value === "user" ? value : undefined;
}

function normalizeWritableRoleSource(value: unknown): Exclude<RoleSource, "builtin"> {
  if (value === "user") return "user";
  return "project";
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function requiredString(value: unknown, message: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(message);
  return text;
}

function normalizeStringArray(value: unknown, message: string): string[] {
  const items = normalizeOptionalStringArray(value) ?? [];
  if (items.length === 0) throw new Error(message);
  return items;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
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

function tailText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(value.length - maxLength)}`;
}

export default function piRolesExtension(pi: PiRolesExtensionApi): void {
  registerPiRolesTools(pi);
}
