import type { SparkDriveMode } from "./spark-drive-state.ts";

export type SparkForegroundDriveDiscriminator = Exclude<SparkDriveMode, "assist"> | "implement";

type ForegroundTimer = ReturnType<typeof setTimeout>;

export interface SparkForegroundDriveScheduleInput {
  drive: SparkForegroundDriveDiscriminator;
  baseKey: string;
  delayMs: number;
  run: (generation: number) => void;
}

/**
 * Shared foreground-drive lifecycle substrate.
 *
 * Domain-specific drives still own their durable state and tick behavior, but
 * timer cancellation and stale-generation protection are common across goal,
 * loop, workflow, and future foreground drives.
 */
export class SparkForegroundDriveSubstrate {
  readonly #timers = new Map<string, ForegroundTimer>();
  readonly #generations = new Map<string, number>();

  schedule(input: SparkForegroundDriveScheduleInput): number {
    const key = this.key(input.drive, input.baseKey);
    const generation = this.nextGeneration(input.drive, input.baseKey);
    this.clearTimer(input.drive, input.baseKey);
    const timer = setTimeout(() => {
      if (this.currentGeneration(input.drive, input.baseKey) !== generation) return;
      this.#timers.delete(key);
      input.run(generation);
    }, input.delayMs);
    timer.unref?.();
    this.#timers.set(key, timer);
    return generation;
  }

  clearTimer(drive: SparkForegroundDriveDiscriminator, baseKey: string): void {
    const key = this.key(drive, baseKey);
    const timer = this.#timers.get(key);
    if (timer) clearTimeout(timer);
    this.#timers.delete(key);
  }

  nextGeneration(drive: SparkForegroundDriveDiscriminator, baseKey: string): number {
    const key = this.key(drive, baseKey);
    const generation = (this.#generations.get(key) ?? 0) + 1;
    this.#generations.set(key, generation);
    return generation;
  }

  currentGeneration(drive: SparkForegroundDriveDiscriminator, baseKey: string): number | undefined {
    return this.#generations.get(this.key(drive, baseKey));
  }

  private key(drive: SparkForegroundDriveDiscriminator, baseKey: string): string {
    return `${baseKey}:${drive}`;
  }
}

export function scheduledDriveDelayMs(
  schedule: { nextRunAt: string } | undefined,
): number | undefined {
  if (!schedule) return undefined;
  const nextRunAtMs = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(nextRunAtMs)) return 0;
  return Math.max(0, nextRunAtMs - Date.now());
}
