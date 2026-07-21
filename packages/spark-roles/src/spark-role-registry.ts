import {
  createDefaultRoleRegistry,
  hydrateDefaultRoleRegistry,
  type RoleRegistry,
} from "./index.ts";

export async function createSparkRoleRegistry(cwd: string): Promise<RoleRegistry> {
  const registry = createDefaultRoleRegistry();
  await hydrateDefaultRoleRegistry(registry, cwd);
  return registry;
}
