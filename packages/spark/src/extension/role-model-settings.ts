import {
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  resolveRoleModelSetting,
  validateRoleModel,
  type ResolvedRoleModelSetting,
  type RoleRegistry,
  type RoleSpec,
} from "@zendev-lab/pi-roles";
import type { RoleRef, ProjectRef } from "@zendev-lab/pi-extension-api";
import { sparkTaskExecutorRoleRef } from "@zendev-lab/spark-runtime";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import { sessionModelName } from "./session-model.ts";

export interface RoleModelSettingsPreflightResult {
  ready: boolean;
  message: string;
  checkedRoleRefs: RoleRef[];
  boundRoleRefs: RoleRef[];
  missingRoleRefs: RoleRef[];
  inheritedRoleRefs?: RoleRef[];
  error?: string;
}

interface RoleModelSettingsContext {
  model?: { provider?: unknown; id?: unknown };
  ui?: {
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

export async function ensureRoleModelSettingsForProject(input: {
  graph: TaskGraph;
  projectRef: ProjectRef;
  registry: RoleRegistry;
  cwd: string;
  ctx: RoleModelSettingsContext;
}): Promise<RoleModelSettingsPreflightResult> {
  const roleRefs = uniqueRoleRefs(
    input.graph.readyTasks(input.projectRef).map((task) => sparkTaskExecutorRoleRef(task)),
  );
  const projectStore = defaultProjectRoleModelSettingsStore(input.cwd);
  const userStore = defaultUserRoleModelSettingsStore();
  const boundRoleRefs: RoleRef[] = [];
  const missingRoleRefs: RoleRef[] = [];
  const inheritedRoleRefs: RoleRef[] = [];
  const sessionModel = sessionModelName(input.ctx.model);
  const resolvedModels: Array<{ roleRef: RoleRef; model: ResolvedRoleModelSetting }> = [];
  for (const roleRef of roleRefs) {
    const role = input.registry.get(roleRef) as RoleSpec;
    const existing = await resolveRoleModelSetting({
      roleRef,
      roleId: role.id,
      roleName: role.id,
      projectStore,
      userStore,
    });
    if (existing) {
      boundRoleRefs.push(roleRef);
      resolvedModels.push({ roleRef, model: existing });
      continue;
    }
    if (sessionModel) {
      inheritedRoleRefs.push(roleRef);
      continue;
    }
    const selected = await input.ctx.ui?.input?.(`Choose Pi model for Spark role ${role.id}`);
    const model = selected?.trim();
    if (!model) {
      missingRoleRefs.push(roleRef);
      continue;
    }
    try {
      await validateRoleModel({ piCommand: "pi", model, cwd: input.cwd });
      const entry = await userStore.save(roleRef, model);
      boundRoleRefs.push(roleRef);
      resolvedModels.push({
        roleRef,
        model: { model: entry.model, source: entry.source, selector: entry.selector },
      });
      input.ctx.ui?.notify?.(`Saved model setting for Spark role ${role.id}: ${model}`, "success");
    } catch (error) {
      return {
        ready: false,
        message: `Model validation failed for ${role.id} (${roleRef}): ${error instanceof Error ? error.message : String(error)}`,
        checkedRoleRefs: roleRefs,
        boundRoleRefs,
        missingRoleRefs: [roleRef],
        error: "model_validation_failed",
      };
    }
  }
  if (missingRoleRefs.length > 0) {
    return {
      ready: false,
      message: `Spark role model unavailable before dispatch: ${missingRoleRefs.join(", ")}. Rerun with an active session model or save a concrete model with role({ action: "model_set" }) for each role.`,
      checkedRoleRefs: roleRefs,
      boundRoleRefs,
      missingRoleRefs,
      inheritedRoleRefs,
      error: "missing_role_model_setting",
    };
  }
  return {
    ready: true,
    message: renderRoleModelSettingsReadyMessage(
      boundRoleRefs,
      inheritedRoleRefs,
      resolvedModels,
      sessionModel,
    ),
    checkedRoleRefs: roleRefs,
    boundRoleRefs,
    missingRoleRefs: [],
    inheritedRoleRefs,
  };
}

function renderRoleModelSettingsReadyMessage(
  boundRoleRefs: RoleRef[],
  inheritedRoleRefs: RoleRef[],
  resolvedModels: Array<{ roleRef: RoleRef; model: ResolvedRoleModelSetting }>,
  sessionModel: string | undefined,
): string {
  const saved = resolvedModels.map(
    ({ roleRef, model }) => `${roleRef}=${model.model} (${model.source})`,
  );
  const inherited = sessionModel
    ? inheritedRoleRefs.map((roleRef) => `${roleRef}=${sessionModel} (session)`)
    : [];
  const total = boundRoleRefs.length + inheritedRoleRefs.length;
  return `Spark role models ready for ${total} role(s): ${[...saved, ...inherited].join(", ")}.`;
}

function uniqueRoleRefs(roleRefs: RoleRef[]): RoleRef[] {
  return [...new Set(roleRefs)].sort((a, b) => a.localeCompare(b));
}
