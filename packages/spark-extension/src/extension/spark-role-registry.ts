import {
  createDefaultRoleRegistry,
  hydrateDefaultRoleRegistry,
  type RoleRegistry,
} from "@zendev-lab/spark-roles";

export async function createSparkRoleRegistry(cwd: string): Promise<RoleRegistry> {
  const registry = createDefaultRoleRegistry();
  await hydrateDefaultRoleRegistry(registry, cwd);
  return registry;
}
