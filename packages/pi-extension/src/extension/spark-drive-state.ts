import { DEFAULT_SPARK_DRIVE_DESCRIPTORS } from "./spark-drive-descriptors.ts";
import type { SparkSessionGoal } from "./spark-session-goals.ts";
import type { SparkSessionLoop } from "./spark-session-loops.ts";
import type { SparkSessionRepro } from "./spark-session-repro.ts";

export interface SparkDriveDerivationInput {
  activeLens?: SparkActiveLensDriveState;
  workflowActive?: boolean;
  repro?: SparkSessionRepro | null | undefined;
  goal?: SparkSessionGoal | null | undefined;
  loop?: SparkSessionLoop | null | undefined;
}

export interface SparkDriveDescriptor<Id extends string = string> {
  id: Id;
  label?: string;
  priority: number;
  aliases?: readonly string[];
  isActive?: (input: SparkDriveDerivationInput) => boolean;
}

export class SparkDriveRegistry<Mode extends string = string> {
  readonly #descriptors = new Map<Mode, SparkDriveDescriptor<Mode>>();
  readonly #aliases = new Map<string, Mode>();

  register<Id extends Mode>(descriptor: SparkDriveDescriptor<Id>): this {
    this.#descriptors.set(descriptor.id, descriptor as SparkDriveDescriptor<Mode>);
    this.#aliases.set(descriptor.id, descriptor.id);
    for (const alias of descriptor.aliases ?? []) this.#aliases.set(alias, descriptor.id);
    return this;
  }

  modes(): Mode[] {
    return Array.from(this.#descriptors.keys());
  }

  normalize(value: unknown): Mode | undefined {
    if (typeof value !== "string") return undefined;
    return this.#aliases.get(value.trim());
  }

  derive(input: SparkDriveDerivationInput): Mode {
    const explicit = this.normalize(input.activeLens?.drive);
    const assist = this.normalize("assist");
    if (explicit && explicit !== assist) return explicit;

    const active = Array.from(this.#descriptors.values())
      .filter((descriptor) => descriptor.isActive?.(input) ?? false)
      .sort((a, b) => b.priority - a.priority)[0];
    if (active) return active.id;
    if (!assist) throw new Error("Spark drive registry is missing required assist drive");
    return assist;
  }

  render(mode: Mode): string {
    return this.#descriptors.get(mode)?.label ?? mode;
  }
}

export type SparkDriveMode = (typeof DEFAULT_SPARK_DRIVE_DESCRIPTORS)[number]["id"];
export const SPARK_DRIVE_MODES = DEFAULT_SPARK_DRIVE_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
) as readonly SparkDriveMode[];

/** @deprecated Old name for the default assist drive. */
export type SparkLegacyDriveMode = "interactive";
export type SparkDriveModeInput = SparkDriveMode | SparkLegacyDriveMode;

export const sparkDriveRegistry = new SparkDriveRegistry<SparkDriveMode>();
for (const descriptor of DEFAULT_SPARK_DRIVE_DESCRIPTORS) sparkDriveRegistry.register(descriptor);

export interface SparkActiveLensDriveState {
  phase?: "research" | "plan" | "implement";
  drive?: SparkDriveModeInput;
}

export function normalizeSparkDriveMode(value: unknown): SparkDriveMode | undefined {
  return sparkDriveRegistry.normalize(value);
}

export function sparkActiveLensDriveMode(
  lens: SparkActiveLensDriveState | undefined,
): SparkDriveMode {
  return normalizeSparkDriveMode(lens?.drive) ?? "assist";
}

export function sparkActiveLensPhase(
  lens: SparkActiveLensDriveState | undefined,
): "research" | "plan" | "implement" {
  if (lens?.phase === "research" || lens?.phase === "plan" || lens?.phase === "implement")
    return lens.phase;
  return "research";
}

export function sparkActiveLens(
  phase: "research" | "plan" | "implement",
  drive: SparkDriveModeInput = "assist",
): {
  phase: "research" | "plan" | "implement";
  drive: SparkDriveMode;
} {
  const normalized = normalizeSparkDriveMode(drive) ?? "assist";
  return { phase, drive: normalized };
}

export function deriveSparkDriveMode(input: SparkDriveDerivationInput): SparkDriveMode {
  return sparkDriveRegistry.derive(input);
}

export function renderSparkDriveMode(mode: SparkDriveMode): string {
  return sparkDriveRegistry.render(mode);
}
