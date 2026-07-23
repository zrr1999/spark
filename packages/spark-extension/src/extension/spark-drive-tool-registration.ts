import { Type } from "typebox";
import { nowIso, type Project } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import { currentSparkProject, loadSparkGraph, sparkSessionOwnerKey } from "./session-state.ts";
import {
  deriveSparkDriveMode,
  normalizeSparkDriveMode,
  sparkActiveLens,
  type SparkDriveMode,
} from "./spark-drive-state.ts";
import {
  clearSessionGoal,
  inferSessionGoalObjective,
  loadSessionGoal,
  setSessionGoal,
} from "./spark-session-goals.ts";
import { clearSessionLoop, loadSessionLoop, setSessionLoop } from "./spark-session-loops.ts";
import {
  clearSessionRepro,
  createSparkSessionRepro,
  readSessionRepro,
  writeSessionRepro,
} from "./spark-session-repro.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import { type SparkDaemonDriverControl } from "./spark-daemon-driver-client.ts";

interface SparkDriveToolDeps {
  driverControl: SparkDaemonDriverControl;
  ensureSparkStateForActiveWorkspace: (cwd: string, ctx?: SparkToolContext) => Promise<unknown>;
  refreshSparkWidget?: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
}

export function registerSparkDriveTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkDriveToolDeps,
): void {
  registerSparkTool({
    name: "drive",
    label: "Spark Drive",
    description:
      "Inspect or control the current session drive. Mode is read-only and derived from drive state: assist, loop, goal, repro, or workflow. Use action=status for the projection; use start/switch/stop with drive=assist|goal|loop|repro for explicit foreground control. Workflow drive starts through workflow_run or /workflow, because it needs a workflow selector/script.",
    promptGuidelines: [
      "Use drive action=status when you need the read-only derived mode/drive projection.",
      "Do not set mode directly; start/switch/stop a drive instead.",
      "Use drive=goal for reviewer-gated autonomous completion, drive=loop for open-ended recurring ticks, and drive=repro for milestone-driven reproduction work.",
      "Use workflow_run or /workflow to enter workflow drive; drive does not synthesize workflow selectors or scripts.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          default: "status",
          description:
            "status | start | switch | stop. start and switch are equivalent explicit drive selection operations.",
        }),
      ),
      drive: Type.Optional(
        Type.String({
          description:
            "assist | loop | goal | repro | workflow. Required for start/switch/stop unless stopping the currently derived drive.",
        }),
      ),
      objective: Type.Optional(
        Type.String({
          description:
            "Objective for goal, loop, or repro drives. For goal/loop, Spark tries to infer a project-backed objective when omitted; repro may start without one but should keep user-supplied reproduction focus when available.",
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: "Optional reason for switching/stopping." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      await deps.ensureSparkStateForActiveWorkspace(cwd, ctx);
      const action = normalizeDriveAction(params.action);
      const graph = await loadSparkGraph(cwd, ctx);
      const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
      const before = await driveSnapshot(cwd, ctx);
      const requestedDrive = normalizeRequestedDrive(params.drive, action, before.mode);

      if (action === "status") return driveStatusResult(before, project);

      if (requestedDrive === "workflow") {
        const text =
          'Workflow drive is controlled by workflow_run or /workflow because a workflow selector/script is required. Use drive({ action: "status" }) to inspect the derived mode projection.';
        return {
          content: [{ type: "text", text }],
          details: { action, requestedDrive, currentMode: before.mode, supportedControl: false },
          isError: true,
        };
      }

      const ownerSessionId = requireDriveOwnerSessionId(ctx);
      // Availability is checked before mutating workspace state. There is no
      // frontend fallback when the daemon control plane is unavailable.
      await deps.driverControl.list({ ownerSessionId, includeStopped: false });

      if (action === "stop") {
        const stoppedDrive = requestedDrive ?? before.mode;
        await stopMatchingForegroundDriver(deps.driverControl, before, stoppedDrive);
        if (stoppedDrive === "goal") await clearSessionGoal(cwd, ctx);
        if (stoppedDrive === "loop") await clearSessionLoop(cwd, ctx);
        if (stoppedDrive === "repro") await clearSessionRepro(cwd, ctx);
        if (stoppedDrive === "assist") {
          // Stopping assist is a no-op; assist is the default when no foreground drive is active.
        }
        const after = await driveSnapshot(cwd, ctx, { ignoreActiveLens: true });
        ctx.sparkActiveLens = sparkActiveLens(ctx.sparkActiveLens?.phase ?? "plan", after.mode);
        await deps.refreshSparkWidget?.(cwd, ctx);
        return driveMutationResult("stopped", stoppedDrive, after, project);
      }

      if (!requestedDrive) throw new Error("drive is required for start/switch");

      if (requestedDrive === "assist") {
        await stopAllForegroundDrivers(deps.driverControl, ownerSessionId, "switched to assist");
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        await clearSessionRepro(cwd, ctx);
      } else if (requestedDrive === "repro") {
        // repro and goal/loop are mutually exclusive
        const objective = normalizeOptionalDriveObjective(params.objective);
        await clearSessionGoal(cwd, ctx);
        await clearSessionLoop(cwd, ctx);
        const existingRepro = await readSessionRepro(cwd, ctx);
        if (!existingRepro || existingRepro.status !== "active") {
          await writeSessionRepro(
            cwd,
            createSparkSessionRepro(sparkSessionOwnerKey(ctx), undefined, { objective }),
            ctx,
          );
        } else if (objective && existingRepro.objective !== objective) {
          await writeSessionRepro(cwd, { ...existingRepro, objective, updatedAt: nowIso() }, ctx);
        }
      } else if (requestedDrive === "goal") {
        const objective = resolveDriveObjective(params.objective, graph, project, "goal");
        await clearSessionLoop(cwd, ctx);
        await clearSessionRepro(cwd, ctx);
        await setSessionGoal(cwd, ctx, { objective, source: "explicit", status: "active" });
      } else if (requestedDrive === "loop") {
        const objective = resolveDriveObjective(params.objective, graph, project, "loop");
        await clearSessionGoal(cwd, ctx);
        await clearSessionRepro(cwd, ctx);
        await setSessionLoop(cwd, ctx, { objective, source: "explicit", status: "active" });
      }

      const after = await driveSnapshot(cwd, ctx, { ignoreActiveLens: true });
      await startSelectedDriver(deps.driverControl, cwd, ownerSessionId, requestedDrive, after);
      ctx.sparkActiveLens = sparkActiveLens(activeLensPhaseForDrive(ctx, after), after.mode);
      await deps.refreshSparkWidget?.(cwd, ctx);
      return driveMutationResult(
        action === "switch" ? "switched" : "started",
        requestedDrive,
        after,
        project,
      );
    },
  });
}

async function stopMatchingForegroundDriver(
  driverControl: SparkDaemonDriverControl,
  snapshot: Awaited<ReturnType<typeof driveSnapshot>>,
  drive: SparkDriveMode,
): Promise<void> {
  const driverId =
    drive === "goal"
      ? snapshot.goal?.goalId
      : drive === "loop"
        ? snapshot.loop?.loopId
        : drive === "repro"
          ? snapshot.repro?.reproId
          : undefined;
  if (driverId) {
    await driverControl.stop({ driverId, reason: `drive ${drive} stopped` });
  }
}

async function stopAllForegroundDrivers(
  driverControl: SparkDaemonDriverControl,
  ownerSessionId: string,
  reason: string,
): Promise<void> {
  const { drivers } = await driverControl.list({ ownerSessionId, includeStopped: false });
  for (const driver of drivers) {
    if (
      driver.kind !== "workflow" &&
      driver.kind !== "session_todo" &&
      driver.status !== "stopped"
    ) {
      await driverControl.stop({ driverId: driver.driverId, reason });
    }
  }
}

async function startSelectedDriver(
  driverControl: SparkDaemonDriverControl,
  cwd: string,
  ownerSessionId: string,
  drive: SparkDriveMode,
  snapshot: Awaited<ReturnType<typeof driveSnapshot>>,
): Promise<void> {
  if (drive === "assist") return;
  if (drive === "goal" && snapshot.goal) {
    await driverControl.start({
      driverId: snapshot.goal.goalId,
      kind: "goal",
      ownerSessionId,
      continuity: "session",
      cwd,
      prompt: [
        "Continue the daemon-owned Spark goal by one concrete turn.",
        `Goal: ${snapshot.goal.objective}`,
        'When fully verified, call goal({ action: "complete", reason, requirements, validationRuns, unresolved }) for reviewer gating.',
      ].join("\n"),
      reason: "goal drive selected",
    });
    return;
  }
  if (drive === "loop" && snapshot.loop) {
    await driverControl.start({
      driverId: snapshot.loop.loopId,
      kind: "loop",
      ownerSessionId,
      continuity: "session",
      cwd,
      prompt: [
        "Continue the daemon-owned Spark loop by one concrete turn.",
        `Loop objective: ${snapshot.loop.objective}`,
        'Before ending, call loop({ action: "schedule", delayMs, reason }); otherwise the driver becomes dormant.',
      ].join("\n"),
      reason: "loop drive selected",
    });
    return;
  }
  if (drive === "repro" && snapshot.repro) {
    await driverControl.start({
      driverId: snapshot.repro.reproId,
      kind: "repro",
      ownerSessionId,
      continuity: "session",
      cwd,
      prompt: [
        "Advance the daemon-owned Spark reproduction contract by one evidence-backed turn.",
        snapshot.repro.objective ? `Objective: ${snapshot.repro.objective}` : undefined,
        'Use repro({ action: "status" }) and persist proof before advancing.',
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      reason: "repro drive selected",
    });
  }
}

function requireDriveOwnerSessionId(ctx: SparkToolContext): string {
  const ownerSessionId = ctx.sessionId?.trim();
  if (!ownerSessionId) throw new Error("Spark drive control requires a daemon-owned session");
  return ownerSessionId;
}

function activeLensPhaseForDrive(
  ctx: SparkToolContext,
  snapshot: { mode: SparkDriveMode; repro: Awaited<ReturnType<typeof readSessionRepro>> },
): "plan" | "implement" {
  if (snapshot.mode === "repro" && snapshot.repro?.status === "active")
    return snapshot.repro.currentPhase;
  return ctx.sparkActiveLens?.phase ?? "plan";
}

function normalizeDriveAction(value: unknown): "status" | "start" | "switch" | "stop" {
  if (value === undefined || value === null || value === "") return "status";
  if (value === "status" || value === "start" || value === "switch" || value === "stop")
    return value;
  throw new Error("drive action must be status, start, switch, or stop");
}

function normalizeRequestedDrive(
  value: unknown,
  action: "status" | "start" | "switch" | "stop",
  currentMode: SparkDriveMode,
): SparkDriveMode | undefined {
  const requested = normalizeSparkDriveMode(value);
  if (requested) return requested;
  if (value === undefined || value === null || value === "") {
    if (action === "stop") return currentMode;
    return undefined;
  }
  throw new Error("drive must be assist, loop, goal, repro, or workflow");
}

async function driveSnapshot(
  cwd: string,
  ctx: SparkToolContext,
  options: { ignoreActiveLens?: boolean } = {},
): Promise<{
  mode: SparkDriveMode;
  goal: Awaited<ReturnType<typeof loadSessionGoal>>;
  loop: Awaited<ReturnType<typeof loadSessionLoop>>;
  repro: Awaited<ReturnType<typeof readSessionRepro>>;
}> {
  const [goal, loop, repro] = await Promise.all([
    loadSessionGoal(cwd, ctx),
    loadSessionLoop(cwd, ctx),
    readSessionRepro(cwd, ctx),
  ]);
  return {
    mode: deriveSparkDriveMode({
      activeLens: options.ignoreActiveLens ? undefined : ctx.sparkActiveLens,
      repro,
      goal,
      loop,
    }),
    goal,
    loop,
    repro,
  };
}

function normalizeOptionalDriveObjective(explicit: unknown): string | undefined {
  if (explicit === undefined || explicit === null) return undefined;
  if (typeof explicit !== "string") throw new Error("drive objective must be a string");
  return explicit.trim() || undefined;
}

function resolveDriveObjective(
  explicit: unknown,
  graph: TaskGraph | null,
  project: Project | undefined,
  drive: "goal" | "loop",
): string {
  const normalized = normalizeOptionalDriveObjective(explicit);
  if (normalized) return normalized;
  const inferred = graph ? inferSessionGoalObjective(graph, project) : undefined;
  if (inferred) return inferred;
  throw new Error(
    `${drive} drive requires objective when Spark cannot infer one from the current project`,
  );
}

function driveStatusResult(
  snapshot: Awaited<ReturnType<typeof driveSnapshot>>,
  project: Project | undefined,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const lines = [`Mode: ${snapshot.mode} (derived from active drive state).`];
  if (project) lines.push(`Current project: ${project.title}`);
  if (snapshot.goal) lines.push(`Goal drive: ${snapshot.goal.status} | ${snapshot.goal.objective}`);
  if (snapshot.loop) lines.push(`Loop drive: ${snapshot.loop.status} | ${snapshot.loop.objective}`);
  if (!snapshot.goal && !snapshot.loop && snapshot.mode === "assist")
    lines.push("No foreground goal or loop drive is active; assist is the default.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: driveDetails(snapshot, project),
  };
}

function driveMutationResult(
  verb: "started" | "switched" | "stopped",
  drive: SparkDriveMode,
  snapshot: Awaited<ReturnType<typeof driveSnapshot>>,
  project: Project | undefined,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const text = `Drive ${verb}: ${drive}. Mode is now ${snapshot.mode}.`;
  return { content: [{ type: "text", text }], details: driveDetails(snapshot, project) };
}

function driveDetails(
  snapshot: Awaited<ReturnType<typeof driveSnapshot>>,
  project: Project | undefined,
): Record<string, unknown> {
  return {
    mode: snapshot.mode,
    drive: snapshot.mode,
    currentProjectRef: project?.ref,
    goal: snapshot.goal
      ? {
          status: snapshot.goal.status,
          objective: snapshot.goal.objective,
          goalId: snapshot.goal.goalId,
        }
      : undefined,
    loop: snapshot.loop
      ? {
          status: snapshot.loop.status,
          objective: snapshot.loop.objective,
          loopId: snapshot.loop.loopId,
        }
      : undefined,
  };
}
