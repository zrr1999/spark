import {
  defaultUserRoleModelBindingStore,
  saveValidatedRoleModelBinding,
  type RoleRegistry,
  type RoleSpec,
} from "pi-roles";
import type { RoleRef, ProjectRef } from "pi-extension-api";
import { sparkTaskExecutorRoleRef } from "spark-runtime";
import type { TaskGraph } from "pi-tasks";

export interface RoleModelBindingPreflightResult {
  ready: boolean;
  message: string;
  checkedRoleRefs: RoleRef[];
  boundRoleRefs: RoleRef[];
  missingRoleRefs: RoleRef[];
  error?: string;
}

interface RoleModelBindingContext {
  ui?: {
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

export async function ensureRoleModelBindingsForProject(input: {
  graph: TaskGraph;
  projectRef: ProjectRef;
  registry: RoleRegistry;
  cwd: string;
  ctx: RoleModelBindingContext;
}): Promise<RoleModelBindingPreflightResult> {
  const roleRefs = uniqueRoleRefs(
    input.graph.readyTasks(input.projectRef).map((task) => sparkTaskExecutorRoleRef(task)),
  );
  const store = defaultUserRoleModelBindingStore();
  const boundRoleRefs: RoleRef[] = [];
  const missingRoleRefs: RoleRef[] = [];
  for (const roleRef of roleRefs) {
    const existing = await store.get(roleRef);
    if (existing) {
      boundRoleRefs.push(roleRef);
      continue;
    }
    const role = input.registry.get(roleRef) as RoleSpec;
    const selected = await input.ctx.ui?.input?.(
      `Choose Pi model for Spark role ${role.id}`,
      role.defaultModel,
    );
    const model = selected?.trim();
    if (!model) {
      missingRoleRefs.push(roleRef);
      continue;
    }
    try {
      await saveValidatedRoleModelBinding({
        store,
        roleRef,
        model,
        piCommand: "pi",
        cwd: input.cwd,
      });
      boundRoleRefs.push(roleRef);
      input.ctx.ui?.notify?.(`Saved model binding for Spark role ${role.id}: ${model}`, "success");
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
      message: `Spark role model binding required before dispatch: ${missingRoleRefs.join(", ")}. Rerun with an interactive UI or bind a concrete model for each role.`,
      checkedRoleRefs: roleRefs,
      boundRoleRefs,
      missingRoleRefs,
      error: "missing_role_model_binding",
    };
  }
  return {
    ready: true,
    message: `Spark role model bindings ready for ${boundRoleRefs.length} role(s).`,
    checkedRoleRefs: roleRefs,
    boundRoleRefs,
    missingRoleRefs: [],
  };
}

function uniqueRoleRefs(roleRefs: RoleRef[]): RoleRef[] {
  return [...new Set(roleRefs)].sort((a, b) => a.localeCompare(b));
}
