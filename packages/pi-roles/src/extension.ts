import { randomUUID } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  RoleRegistry,
  hydrateDefaultRoleRegistry,
  runRole,
  buildRoleRunArgs,
  type RoleRunMode,
  type RoleRunRef,
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

export interface RunRoleToolParams {
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
    name: "run_role",
    label: "Run Role",
    description:
      "Run one reusable Pi role with an explicit instruction. Defaults to dry-run and returns the Pi CLI args; set dryRun=false to launch a fresh or explicitly forked child Pi run.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. worker or role:builtin-worker.",
      }),
      instruction: Type.String({ description: "Concrete instruction for this one role run." }),
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
        "run_role",
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
      const p = normalizeRunRoleToolParams(params);
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
                `Role dry-run: ${role.id} (${role.ref})`,
                `mode: ${mode}`,
                `cwd: ${cwd}`,
                `piCommand: ${commandInput.piCommand}`,
                `args: ${JSON.stringify(args)}`,
              ].join("\n"),
            },
          ],
          details: {
            dryRun: true,
            role,
            mode,
            runRef,
            cwd,
            piCommand: commandInput.piCommand,
            args,
          },
        };
      }

      const result = await runRole(commandInput);
      const summary = [
        `Role run ${result.record.status}: ${role.id} (${role.ref})`,
        `runRef: ${result.record.ref}`,
        `mode: ${result.record.mode}`,
        result.record.errorMessage ? `error: ${result.record.errorMessage}` : undefined,
        result.stdout ? `stdout:\n${tailText(result.stdout, 12_000)}` : undefined,
        result.stderr ? `stderr:\n${tailText(result.stderr, 8_000)}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: {
          dryRun: false,
          role,
          mode,
          runRef,
          cwd,
          result: result as unknown as Record<string, unknown>,
        },
      };
    },
  });
}

function normalizeRunRoleToolParams(params: Record<string, unknown>): RunRoleToolParams {
  const role = typeof params.role === "string" ? params.role.trim() : "";
  const instruction = typeof params.instruction === "string" ? params.instruction.trim() : "";
  if (!role) throw new Error("run_role role is required");
  if (!instruction) throw new Error("run_role instruction is required");
  const mode = params.mode === "forked" ? "forked" : "fresh";
  const forkFromSession =
    typeof params.forkFromSession === "string" ? params.forkFromSession.trim() : undefined;
  if (mode === "forked" && !forkFromSession)
    throw new Error("run_role forked mode requires forkFromSession");
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
