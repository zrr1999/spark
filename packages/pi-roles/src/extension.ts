import { randomUUID } from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  createDefaultRoleRegistry,
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  defaultProjectRoleStore,
  defaultUserRoleModelSettingsStore,
  defaultUserRoleStore,
  hydrateDefaultRoleRegistry,
  normalizeRoleLaunchMode,
  resolveRoleModelSetting,
  runRole,
  validateRoleModel,
  type ResolvedRoleModelSetting,
  type RoleModelSettingsEntry,
  type RoleModelSettingsSource,
  type RoleLaunchMode,
  type RoleRunRef,
  type RoleSource,
  type RoleSpec,
  type RoleSpecProposal,
  type WritableRoleSource,
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
      model?: PiRolesSessionModel;
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

interface PiRolesSessionModel {
  provider?: unknown;
  id?: unknown;
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
  launch?: RoleLaunchMode;
  piCommand?: string;
  cwd?: string;
  sessionDir?: string;
  forkFromSession?: string;
  timeoutMs?: number;
  includeUser?: boolean;
  model?: string;
}

export function registerPiRolesTools(pi: PiRolesExtensionApi): void {
  const roleActionTools = new Map<string, PiRolesToolConfig>();
  const registerRoleActionTool = (config: PiRolesToolConfig): void => {
    roleActionTools.set(config.name, config);
  };
  const registerPublicRoleTool = (config: PiRolesToolConfig): void => {
    roleActionTools.set(config.name, config);
    pi.registerTool(config);
  };

  registerRoleActionTool({
    name: "list_roles",
    label: "List Roles",
    description: "List builtin, extension, project, and optionally user Pi role specs.",
    parameters: Type.Object({
      source: Type.Optional(
        Type.String({
          description: "builtin | extension | project | user. Omit to list all loaded roles.",
        }),
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
      const registry = createDefaultRoleRegistry();
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

  registerRoleActionTool({
    name: "get_role",
    label: "Get Role",
    description: "Inspect one builtin, extension, project, or user Pi role spec.",
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
      const registry = createDefaultRoleRegistry();
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
      const effectiveModel = await resolveRoleModelForRole(cwd, role);
      const effectiveModelText = effectiveModel
        ? `${effectiveModel.model} (${effectiveModel.source}${effectiveModel.selector ? ` selector=${effectiveModel.selector}` : ""})`
        : `not set; save one with role({ action: "model_set" }) before non-interactive runs`;
      const lines = [
        `${role.id} (${role.ref})`,
        `source: ${role.source}`,
        `description: ${role.description}`,
        `effectiveModel: ${effectiveModelText}`,
        `systemPrompt: ${role.systemPrompt.length} chars${includePrompt ? "" : `; preview=${JSON.stringify(promptPreview)}`}`,
      ];
      if (includePrompt) lines.push("", role.systemPrompt);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          role: includePrompt
            ? { ...compactRole(role), effectiveModel, systemPrompt: role.systemPrompt }
            : { ...compactRole(role), effectiveModel },
        },
      };
    },
  });

  registerRoleActionTool({
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
      rejectRoleSpecModelFields(params, "create_role");
      const source = normalizeWritableRoleSource(params.source);
      const proposal: RoleSpecProposal = {
        id: normalizeRequiredString(params.id, "create_role id"),
        source,
        description: normalizeRequiredString(params.description, "create_role description"),
        systemPrompt: normalizeRequiredString(params.systemPrompt, "create_role systemPrompt"),
        rationale: normalizeRequiredString(params.rationale, "create_role rationale"),
        expectedUses: normalizeRequiredStringArray(params.expectedUses, "create_role expectedUses"),
        allowedTools: normalizeOptionalStringArray(params.allowedTools, "create_role allowedTools"),
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

  registerRoleActionTool({
    name: "call_role",
    label: "Call Role",
    description:
      "Call one reusable Pi role directly with an explicit instruction. This is a one-off role invocation and is not attached to managed task graphs or workflow runs. Launches a fresh child Pi run by default, or an explicitly forked child run when launch=forked.",
    parameters: Type.Object({
      role: Type.String({
        description: "Role id or full role ref, e.g. worker or role:builtin-worker.",
      }),
      instruction: Type.String({ description: "Concrete instruction for this one role call." }),
      launch: Type.Optional(
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
          description: "Parent session/context for forked launch. Required when launch=forked.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Child run timeout in milliseconds." })),
      model: Type.Optional(
        Type.String({
          description:
            "Concrete Pi model override for this run. Defaults to a saved role model, then the current session model.",
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
          formatStringArg(args.launch, { fallback: "fresh" }),
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
      const registry = createDefaultRoleRegistry();
      await hydrateDefaultRoleRegistry(registry, cwd, { includeUser: p.includeUser });
      const role = registry.select(p.role);
      const launch = p.launch ?? "fresh";
      const runRef = `run:${randomUUID()}` as RoleRunRef;
      const model = await resolveRoleModelForCall({
        role,
        explicitModel: p.model,
        sessionModel: sessionModelName(ctx.model),
        piCommand: p.piCommand ?? "pi",
        cwd,
        actualRun: true,
        ui: ctx.ui,
      });
      const commandInput = {
        runRef,
        roleRef: role.ref,
        launch,
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
      const delivery = summarizeRoleCallDelivery({
        finalAssistantText,
        stdoutNonJsonTail,
        jsonEventCount: result.jsonEvents.length,
      });
      const summary = [
        `Role call ${result.record.status}: ${role.id} (${role.ref})`,
        formatRoleRunIdentity({
          runRef: result.record.ref,
          launch: result.record.launch,
          model: result.record.model,
          sessionDir: result.record.sessionDir,
          forkFromSession: result.record.forkFromSession,
        }),
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
          role: compactRole(role),
          launch,
          runRef,
          cwd,
          model,
          record: result.record,
          jsonEventCount: result.jsonEvents.length,
          delivery,
          stdoutTail,
          stderrTail,
        },
      };
    },
  });

  registerRoleActionTool({
    name: "model_list_roles",
    label: "List Role Models",
    description: "List persisted project/user role model settings.",
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "project | user. Omit to list both." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_list",
        [formatStringArg(args.source, { prefix: "source=" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "role model_list");
      const source = normalizeOptionalRoleModelSettingsSource(
        params.source,
        "role model_list source",
      );
      const entries = await loadRoleModelSettingEntries(cwd, source);
      const lines = entries.map(
        (entry) => `- [${entry.source}] ${entry.selector} -> ${entry.model}`,
      );
      return {
        content: [
          { type: "text", text: lines.length ? lines.join("\n") : "No role model settings." },
        ],
        details: { count: entries.length, entries },
      };
    },
  });

  registerRoleActionTool({
    name: "model_get_role",
    label: "Get Role Model",
    description: "Resolve the effective model setting for one role.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
    }),
    renderCall(args, theme) {
      return renderToolCall("role_model_get", [formatStringArg(args.role)], theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "role model_get");
      const role = await selectRoleForModelAction(cwd, params, "role model_get");
      const resolved = await resolveRoleModelForRole(cwd, role);
      const text = resolved
        ? `Role model for ${role.id} (${role.ref}): ${resolved.model} source=${resolved.source}${resolved.selector ? ` selector=${resolved.selector}` : ""}`
        : `No role model setting for ${role.id} (${role.ref}).`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), model: resolved },
      };
    },
  });

  registerRoleActionTool({
    name: "model_set_role",
    label: "Set Role Model",
    description: "Validate and save a project/user role model setting.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      model: Type.String({ description: "Concrete Pi model to validate and save." }),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
      piCommand: Type.Optional(Type.String({ description: "Pi executable for model validation." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_set",
        [formatStringArg(args.role), formatStringArg(args.source, { fallback: "project" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "role model_set");
      const role = await selectRoleForModelAction(cwd, params, "role model_set");
      const model = normalizeRequiredString(params.model, "role model_set model");
      await validateRoleModel({
        piCommand: normalizeOptionalString(params.piCommand, "role model_set piCommand") ?? "pi",
        model,
        cwd,
      });
      const source = normalizeRoleModelSettingsSource(params.source, "role model_set source");
      const store = roleModelSettingsStoreForSource(cwd, source);
      const entry = await store.save(role.ref, model);
      const text = `Saved ${source} role model setting for ${role.id} (${role.ref}): ${entry.model}`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), setting: entry },
      };
    },
  });

  registerRoleActionTool({
    name: "model_delete_role",
    label: "Delete Role Model",
    description: "Delete project/user role model setting(s) for one role.",
    parameters: Type.Object({
      role: Type.String({ description: "Role id or full role ref." }),
      source: Type.Optional(Type.String({ description: "project | user. Defaults to project." })),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role_model_delete",
        [formatStringArg(args.role), formatStringArg(args.source, { fallback: "project" })],
        theme,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requiredPiRolesCwd(ctx, "role model_delete");
      const role = await selectRoleForModelAction(cwd, params, "role model_delete");
      const source = normalizeRoleModelSettingsSource(params.source, "role model_delete source");
      const store = roleModelSettingsStoreForSource(cwd, source);
      const deleted: string[] = [];
      for (const selector of roleModelActionSelectors(role)) {
        if (await store.delete(selector)) deleted.push(selector);
      }
      const text = deleted.length
        ? `Deleted ${source} role model setting(s) for ${role.id}: ${deleted.join(", ")}`
        : `No ${source} role model settings matched ${role.id} (${role.ref}).`;
      return {
        content: [{ type: "text", text }],
        details: { role: compactRole(role), source, deleted },
      };
    },
  });

  registerPublicRoleTool({
    name: "role",
    label: "Role",
    description:
      "Canonical role capability. Use action=list, get, create, call, model_list, model_get, model_set, or model_delete instead of fragmented role tool names.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | get | create | call | model_list | model_get | model_set | model_delete",
      }),
      role: Type.Optional(Type.String({ description: "Role id or ref for get/call." })),
      source: Type.Optional(Type.String({ description: "builtin | project | user." })),
      includeUser: Type.Optional(Type.Boolean({ description: "Also load user roles." })),
      includePrompt: Type.Optional(
        Type.Boolean({ description: "Include full role system prompt." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum role rows for list." })),
      id: Type.Optional(Type.String({ description: "Stable role id for create." })),
      description: Type.Optional(Type.String({ description: "Role description for create." })),
      systemPrompt: Type.Optional(Type.String({ description: "Role system prompt for create." })),
      rationale: Type.Optional(Type.String({ description: "Role creation rationale." })),
      expectedUses: Type.Optional(Type.Array(Type.String())),
      allowedTools: Type.Optional(Type.Array(Type.String())),
      instruction: Type.Optional(Type.String({ description: "Instruction for call." })),
      launch: Type.Optional(Type.String({ description: "fresh | forked for call." })),
      piCommand: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      sessionDir: Type.Optional(Type.String()),
      forkFromSession: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      model: Type.Optional(Type.String()),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "role",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "?" }),
          formatStringArg(args.role),
          formatStringArg(args.id, { prefix: "id=" }),
        ],
        theme,
      );
    },
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeRoleAction(params.action);
      const target = roleToolNameForAction(action);
      const tool = roleActionTools.get(target);
      if (!tool) throw new Error(`role action adapter could not find ${target}`);
      return tool.execute(toolCallId, stripRoleAction(params), signal, onUpdate, ctx);
    },
  });
}

type RoleAction =
  | "list"
  | "get"
  | "create"
  | "call"
  | "model_list"
  | "model_get"
  | "model_set"
  | "model_delete";

function normalizeRoleAction(value: unknown): RoleAction {
  if (
    value === "list" ||
    value === "get" ||
    value === "create" ||
    value === "call" ||
    value === "model_list" ||
    value === "model_get" ||
    value === "model_set" ||
    value === "model_delete"
  )
    return value;
  throw new Error(
    "role.action must be list, get, create, call, model_list, model_get, model_set, or model_delete",
  );
}

function roleToolNameForAction(
  action: RoleAction,
):
  | "list_roles"
  | "get_role"
  | "create_role"
  | "call_role"
  | "model_list_roles"
  | "model_get_role"
  | "model_set_role"
  | "model_delete_role" {
  if (action === "list") return "list_roles";
  if (action === "get") return "get_role";
  if (action === "create") return "create_role";
  if (action === "call") return "call_role";
  if (action === "model_list") return "model_list_roles";
  if (action === "model_get") return "model_get_role";
  if (action === "model_set") return "model_set_role";
  return "model_delete_role";
}

function stripRoleAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

async function selectRoleForModelAction(
  cwd: string,
  params: Record<string, unknown>,
  fieldPrefix: string,
): Promise<RoleSpec> {
  const registry = createDefaultRoleRegistry();
  const includeUser = normalizeOptionalBoolean(
    params.includeUser,
    false,
    `${fieldPrefix} includeUser`,
  );
  await hydrateDefaultRoleRegistry(registry, cwd, { includeUser });
  return registry.select(normalizeRequiredString(params.role, `${fieldPrefix} role`));
}

async function loadRoleModelSettingEntries(
  cwd: string,
  source: RoleModelSettingsSource | undefined,
): Promise<RoleModelSettingsEntry[]> {
  const stores = source
    ? [roleModelSettingsStoreForSource(cwd, source)]
    : [defaultProjectRoleModelSettingsStore(cwd), defaultUserRoleModelSettingsStore()];
  const entries = await Promise.all(stores.map((store) => store.loadAll()));
  return entries.flat();
}

function roleModelSettingsStoreForSource(cwd: string, source: RoleModelSettingsSource) {
  return source === "project"
    ? defaultProjectRoleModelSettingsStore(cwd)
    : defaultUserRoleModelSettingsStore();
}

async function resolveRoleModelForRole(
  cwd: string,
  role: RoleSpec,
): Promise<ResolvedRoleModelSetting | undefined> {
  return resolveRoleModelSetting({
    roleRef: role.ref,
    roleId: role.id,
    roleName: role.id,
    projectStore: defaultProjectRoleModelSettingsStore(cwd),
    userStore: defaultUserRoleModelSettingsStore(),
  });
}

function roleModelActionSelectors(role: RoleSpec): string[] {
  return [...new Set([role.ref, role.ref.slice("role:".length), role.id])];
}

function normalizeRoleModelSettingsSource(value: unknown, field: string): RoleModelSettingsSource {
  const source = normalizeOptionalRoleModelSettingsSource(value, field) ?? "project";
  return source;
}

function normalizeOptionalRoleModelSettingsSource(
  value: unknown,
  field: string,
): RoleModelSettingsSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "project" || value === "user") return value;
  throw new Error(`${field} must be project or user`);
}

function rejectRoleSpecModelFields(params: Record<string, unknown>, toolName: string): void {
  for (const field of ["defaultModel", "model"]) {
    if (Object.hasOwn(params, field))
      throw new Error(`${toolName} ${field} is not supported; use role model settings`);
  }
}

function requiredPiRolesCwd(ctx: { cwd?: string }, toolName: string): string {
  if (typeof ctx.cwd === "string" && ctx.cwd.trim()) return ctx.cwd;
  throw new Error(`${toolName} requires ctx.cwd or an explicit cwd parameter.`);
}

function sessionModelName(model: PiRolesSessionModel | undefined): string | undefined {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  return provider && id ? `${provider}/${id}` : undefined;
}

async function resolveRoleModelForCall(input: {
  role: RoleSpec;
  explicitModel?: string;
  sessionModel?: string;
  piCommand: string;
  cwd: string;
  actualRun: boolean;
  ui?: {
    notify?: (message: string, level?: string) => void;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  };
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
  if (input.sessionModel) return input.sessionModel;
  if (!input.actualRun) return undefined;

  throw new Error(
    `role model unavailable for ${input.role.id} (${input.role.ref}); provide model, save one with role({ action: "model_set" }), or run with an active session model`,
  );
}

function normalizeCallRoleToolParams(params: Record<string, unknown>): CallRoleToolParams {
  const role = normalizeRequiredString(params.role, "call_role role");
  const instruction = normalizeRequiredString(params.instruction, "call_role instruction");
  if (Object.hasOwn(params, "mode"))
    throw new Error("call_role mode was renamed to launch; use launch=fresh or launch=forked");
  const launch = normalizeRoleLaunchMode(params.launch);
  if (Object.hasOwn(params, "dryRun"))
    throw new Error(
      "call_role dryRun is no longer supported; call_role always launches a child run",
    );
  const forkFromSession = normalizeOptionalString(
    params.forkFromSession,
    "call_role forkFromSession",
  );
  if (launch === "forked" && !forkFromSession)
    throw new Error("call_role forked launch requires forkFromSession");
  return {
    role,
    instruction,
    launch,
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
  if (value === "builtin" || value === "extension" || value === "project" || value === "user")
    return value;
  throw new Error(`${field} must be builtin, extension, project, or user`);
}

function normalizeWritableRoleSource(value: unknown): WritableRoleSource {
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
  };
}

const TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;

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
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? TOOL_CALL_DEFAULT_ARG_MAX_LENGTH)}`;
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
  launch: RoleLaunchMode;
  model?: string;
  sessionDir?: string;
  forkFromSession?: string;
}): string {
  return compactKeyValues([
    ["runRef", input.runRef],
    ["launch", input.launch],
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

interface RoleCallDeliverySummary {
  status: "delivered" | "non_json_output" | "empty";
  hasFinalAssistantText: boolean;
  hasNonJsonOutput: boolean;
  jsonEventCount: number;
  finalAssistantText?: string;
  stdoutNonJsonTail?: string;
}

function summarizeRoleCallDelivery(input: {
  finalAssistantText?: string;
  stdoutNonJsonTail?: string;
  jsonEventCount: number;
}): RoleCallDeliverySummary {
  if (input.finalAssistantText) {
    return {
      status: "delivered",
      hasFinalAssistantText: true,
      hasNonJsonOutput: Boolean(input.stdoutNonJsonTail),
      jsonEventCount: input.jsonEventCount,
      finalAssistantText: input.finalAssistantText,
      stdoutNonJsonTail: input.stdoutNonJsonTail,
    };
  }
  if (input.stdoutNonJsonTail) {
    return {
      status: "non_json_output",
      hasFinalAssistantText: false,
      hasNonJsonOutput: true,
      jsonEventCount: input.jsonEventCount,
      stdoutNonJsonTail: input.stdoutNonJsonTail,
    };
  }
  return {
    status: "empty",
    hasFinalAssistantText: false,
    hasNonJsonOutput: false,
    jsonEventCount: input.jsonEventCount,
  };
}

function renderRoleCallDelivery(delivery: RoleCallDeliverySummary): string | undefined {
  if (delivery.status === "delivered" && delivery.finalAssistantText) {
    return `result:\n${truncateBlock(delivery.finalAssistantText, 12_000)}`;
  }
  if (delivery.status === "non_json_output" && delivery.stdoutNonJsonTail) {
    return `output:\n${delivery.stdoutNonJsonTail}`;
  }
  return delivery.jsonEventCount > 0
    ? `delivery: empty — no final assistant message found (${delivery.jsonEventCount} JSON events captured).`
    : "delivery: empty — child process exited without assistant output.";
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
