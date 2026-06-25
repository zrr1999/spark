/**
 * SparkKeybindings — host-side keybinding registry for the spark-tui native
 * pi-tui host.
 *
 * Responsibilities:
 *
 *   - Hold a default keybinding table covering both app-level (`app.*`) and
 *     TUI-level (`tui.*`) actions; defaults match the most common Pi
 *     conventions but live in this file as the single source of truth so
 *     spark-cli can diverge if needed.
 *
 *   - Layer user overrides loaded from `~/.spark/agent/keybindings.json` on
 *     top of defaults. The JSON file maps each registered binding id to a
 *     key string (`shift+tab`, `ctrl+o`, etc.). User-provided keys win over
 *     defaults. Bindings not present in the JSON file inherit the default
 *     key.
 *
 *   - Allow extensions and the host to register additional bindings via
 *     `register(id, definition)` (e.g. Spark active mode registers
 *     `app.spark.cycleMode`). When two bindings share a key, the most
 *     recently registered binding wins for `executeKey` — this is how the
 *     Spark active mode-as-state work overrides the default
 *     `app.thinking.cycle` on `shift+tab` only when Spark is active.
 *
 *   - Expose `executeKey(key, ctx)` for the TUI key dispatcher: looks up the
 *     active binding for that key (after user overrides + most-recent
 *     registration), then invokes its handler with a host-supplied context.
 *
 * Persistence is JSON; no schema migrations live here yet. Reading is lazy
 * via `loadFromDisk(path)`; writing is explicit via `saveToDisk(path)`. Tests
 * either pre-seed an in-memory store or use a temp directory.
 *
 * This module is *host-only* — extensions do not import it directly. They
 * still call `pi.registerShortcut(key, options)` (currently throws as
 * not-implemented in SparkHostRuntime; lighting that up is a follow-up that
 * will internally call `keybindings.register(...)`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SparkKeybindingId = string;

export interface SparkKeybindingDefinition {
  id: SparkKeybindingId;
  defaultKey: string;
  description: string;
  /** When invoked, the binding receives the host context. */
  handler: (ctx: SparkKeybindingContext) => void | Promise<void>;
  /**
   * Optional gate: only fire the handler when this returns true. The Spark
   * active mode-as-state work uses this to make `app.spark.cycleMode` only
   * win on shift+tab when Spark is active in the workspace.
   */
  isActive?: (ctx: SparkKeybindingContext) => boolean;
}

export interface SparkKeybindingContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: unknown;
  [key: string]: unknown;
}

export interface SparkKeybindingsSnapshot {
  bindings: Array<{
    id: SparkKeybindingId;
    description: string;
    key: string;
    defaultKey: string;
    overridden: boolean;
  }>;
}

export interface SparkKeybindingsOptions {
  defaults?: SparkKeybindingDefinition[];
  /** Pre-loaded user overrides (id → key). Tests use this to avoid disk I/O. */
  overrides?: Record<string, string>;
}

const DEFAULT_BINDINGS: SparkKeybindingDefinition[] = [
  {
    id: "app.exit",
    defaultKey: "ctrl+c",
    description: "Exit the spark-cli host",
    handler: () => undefined,
  },
  {
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle the assistant thinking level (off/minimal/low/medium/high)",
    handler: () => undefined,
  },
  {
    id: "app.toggleTools",
    defaultKey: "ctrl+o",
    description: "Toggle tool output expansion",
    handler: () => undefined,
  },
  {
    id: "app.toggleThinking",
    defaultKey: "ctrl+t",
    description: "Toggle thinking block expansion",
    handler: () => undefined,
  },
  {
    id: "app.modelPicker",
    defaultKey: "ctrl+l",
    description: "Open the model selector",
    handler: () => undefined,
  },
  {
    id: "app.modelCycle.next",
    defaultKey: "ctrl+p",
    description: "Cycle to the next Spark model",
    handler: () => undefined,
  },
  {
    id: "app.modelCycle.prev",
    defaultKey: "shift+ctrl+p",
    description: "Cycle to the previous Spark model",
    handler: () => undefined,
  },
  {
    id: "app.abortTurn",
    defaultKey: "esc",
    description: "Abort the current LLM turn",
    handler: () => undefined,
  },
];

export class SparkKeybindings {
  private readonly bindings = new Map<SparkKeybindingId, SparkKeybindingDefinition>();
  /**
   * Registration order list. When a key is bound by multiple bindings we
   * prefer the most-recently registered one in `executeKey`. Spark active
   * mode-as-state registers `app.spark.cycleMode` after `app.thinking.cycle`
   * so it wins on shift+tab.
   */
  private readonly registrationOrder: SparkKeybindingId[] = [];
  private readonly overrides: Record<string, string> = {};

  constructor(options: SparkKeybindingsOptions = {}) {
    const defaults = options.defaults ?? DEFAULT_BINDINGS;
    for (const definition of defaults) this.register(definition);
    if (options.overrides) {
      for (const [id, key] of Object.entries(options.overrides)) this.overrides[id] = key;
    }
  }

  // ── Registration ───────────────────────────────────────────────────────

  register(definition: SparkKeybindingDefinition): void {
    if (!definition.id) throw new Error("SparkKeybindings.register requires a binding id");
    this.bindings.set(definition.id, definition);
    // Refresh registration order: move id to the end if already present.
    const previousIndex = this.registrationOrder.indexOf(definition.id);
    if (previousIndex >= 0) this.registrationOrder.splice(previousIndex, 1);
    this.registrationOrder.push(definition.id);
  }

  unregister(id: SparkKeybindingId): void {
    this.bindings.delete(id);
    const index = this.registrationOrder.indexOf(id);
    if (index >= 0) this.registrationOrder.splice(index, 1);
  }

  // ── Lookup / dispatch ──────────────────────────────────────────────────

  /** Active key for the given id — user override or default. */
  keyFor(id: SparkKeybindingId): string | undefined {
    if (id in this.overrides) return this.overrides[id];
    return this.bindings.get(id)?.defaultKey;
  }

  /**
   * The `executeKey(key, ctx)` entry point. Returns `true` when a registered
   * binding matched and ran. Conflict resolution:
   *
   *   1. Among bindings that resolve to `key` (via override or default),
   *   2. Filter to those whose `isActive(ctx)` is undefined or returns true,
   *   3. Pick the one registered most recently.
   *
   * Most-recent-wins lets Spark active mode register `app.spark.cycleMode`
   * over the default `app.thinking.cycle` on shift+tab.
   */
  async executeKey(key: string, ctx: SparkKeybindingContext): Promise<boolean> {
    const candidates: SparkKeybindingDefinition[] = [];
    for (const id of this.registrationOrder) {
      const definition = this.bindings.get(id);
      if (!definition) continue;
      if (this.keyFor(id) !== key) continue;
      if (definition.isActive && !definition.isActive(ctx)) continue;
      candidates.push(definition);
    }
    if (candidates.length === 0) return false;
    const winner = candidates[candidates.length - 1]!;
    await winner.handler(ctx);
    return true;
  }

  snapshot(): SparkKeybindingsSnapshot {
    const rows = this.registrationOrder
      .map((id) => {
        const definition = this.bindings.get(id);
        if (!definition) return undefined;
        return {
          id,
          description: definition.description,
          key: this.keyFor(id) ?? definition.defaultKey,
          defaultKey: definition.defaultKey,
          overridden: id in this.overrides,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    return { bindings: rows };
  }

  // ── Override management ────────────────────────────────────────────────

  /** Set a single user override. Pass undefined to clear. */
  setOverride(id: SparkKeybindingId, key: string | undefined): void {
    if (key === undefined) {
      delete this.overrides[id];
      return;
    }
    this.overrides[id] = key;
  }

  applyOverrides(overrides: Record<string, string>): void {
    for (const [id, key] of Object.entries(overrides)) this.overrides[id] = key;
  }

  getOverrides(): Readonly<Record<string, string>> {
    return this.overrides;
  }

  // ── Persistence ────────────────────────────────────────────────────────

  async loadFromDisk(path: string = defaultKeybindingsPath()): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `SparkKeybindings.loadFromDisk failed to parse ${path}: ${(error as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`SparkKeybindings.loadFromDisk: ${path} must contain a JSON object`);
    }
    const bindingsField = (parsed as { bindings?: unknown }).bindings;
    const flatRecord =
      bindingsField && typeof bindingsField === "object" && !Array.isArray(bindingsField)
        ? (bindingsField as Record<string, unknown>)
        : (parsed as Record<string, unknown>);
    for (const [id, key] of Object.entries(flatRecord)) {
      if (typeof key === "string" && key.length > 0) this.overrides[id] = key;
    }
  }

  async saveToDisk(path: string = defaultKeybindingsPath()): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const payload = JSON.stringify({ bindings: this.overrides }, null, 2);
    await writeFile(path, `${payload}\n`, "utf8");
  }
}

export function defaultKeybindingsPath(): string {
  const root = process.env.SPARK_AGENT_DIR ?? join(homedir(), ".spark", "agent");
  return join(root, "keybindings.json");
}

export function defaultSparkKeybindings(options: SparkKeybindingsOptions = {}): SparkKeybindings {
  return new SparkKeybindings(options);
}
