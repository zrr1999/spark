import type { Mode, ModeDefinition } from "./types.ts";

/**
 * Open registry of operating-lens definitions. Hosts register the built-in
 * research/plan/implement lenses plus any custom modes; registration order is
 * preserved for menu/cycle rendering.
 */
export interface ModeRegistry {
  register(definition: ModeDefinition): void;
  has(id: Mode): boolean;
  get(id: Mode): ModeDefinition | undefined;
  /** Throwing accessor for call sites that require a known mode. */
  require(id: Mode): ModeDefinition;
  list(): ModeDefinition[];
  /** Registered mode ids, in registration order. */
  ids(): Mode[];
  /** Ids of modes flagged `builtin` (the auto-classifiable subset). */
  builtinIds(): Mode[];
}

export interface CreateModeRegistryOptions {
  /** Initial definitions; equivalent to calling register for each in order. */
  definitions?: ModeDefinition[];
}

export function createModeRegistry(options: CreateModeRegistryOptions = {}): ModeRegistry {
  const order: Mode[] = [];
  const byId = new Map<Mode, ModeDefinition>();

  const register = (definition: ModeDefinition): void => {
    const id = definition.id.trim();
    if (!id) throw new Error("mode id must be a non-empty string");
    if (!byId.has(id)) order.push(id);
    byId.set(id, { ...definition, id });
  };

  for (const definition of options.definitions ?? []) register(definition);

  return {
    register,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    require: (id) => {
      const definition = byId.get(id);
      if (!definition) {
        throw new Error(
          `unknown mode: ${id}; registered modes are ${order.join(", ") || "(none)"}`,
        );
      }
      return definition;
    },
    list: () => order.map((id) => byId.get(id)!),
    ids: () => [...order],
    builtinIds: () => order.filter((id) => byId.get(id)?.builtin),
  };
}
