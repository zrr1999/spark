import {
  createDefaultRoleRegistry,
  createRoleRef,
  hydrateDefaultRoleRegistry,
  nowIso,
  registerBuiltinRoleProvider,
  type RoleRegistry,
  type RoleSpec,
} from "pi-roles";

export const SPARK_ROLE_PROVIDER_ID = "spark";
export const SPARK_PATCHER_ROLE_ID = "patcher";
export const SPARK_PATCHER_ROLE_REF = createRoleRef("builtin", "spark-patcher");

export function createSparkPredefinedRoles(now = nowIso()): RoleSpec[] {
  return [
    {
      ref: SPARK_PATCHER_ROLE_REF,
      id: SPARK_PATCHER_ROLE_ID,
      source: "builtin",
      description: "Produces narrow, reviewable code patches for ready Spark implementation tasks.",
      systemPrompt: [
        "You are a Spark patcher. Produce a narrow, reviewable code patch for the assigned Spark implementation task.",
        "Inspect the current worktree before editing, preserve unrelated user changes, and keep edits scoped to the task intent.",
        "Prefer existing repository patterns and small focused changes over broad refactors, compatibility shims, or speculative abstractions.",
        "Use Spark ask tools for real blockers or missing user decisions; otherwise proceed from repository evidence and document the choice.",
        "Run focused verification appropriate to the files touched, and report changed files plus concrete evidence.",
      ].join("\n"),
      origin: { kind: "builtin", note: "spark predefined role" },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function registerSparkPredefinedRoles(): void {
  registerBuiltinRoleProvider(SPARK_ROLE_PROVIDER_ID, createSparkPredefinedRoles);
}

export async function createSparkRoleRegistry(cwd: string): Promise<RoleRegistry> {
  registerSparkPredefinedRoles();
  const registry = createDefaultRoleRegistry();
  await hydrateDefaultRoleRegistry(registry, cwd);
  return registry;
}
