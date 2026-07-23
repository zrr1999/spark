#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sparkExtension from "../packages/pi-extension/src/extension/index.ts";
import {
  renderSparkWidgetLines,
  type SparkWidgetTheme,
  type SparkWidgetTui,
} from "../packages/spark-host/src/spark-widget.ts";
import type {
  SparkRegisteredToolConfig,
  SparkToolContext,
} from "../packages/spark-extension/src/extension/spark-tool-registration.ts";
import type {
  ReviewerRunner,
  ReviewInput,
} from "../packages/spark-extension/src/extension/reviewer-runner.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const args = new Map<string, string | boolean>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}
const outputPath = String(args.get("output") || "/tmp/spark-pi-extension-manual-matrix.json");
const keep = args.get("keep") === true;

interface StepResult {
  name: string;
  ok: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  detail?: unknown;
  error?: string;
}

class ManualPiApi {
  publicTools = new Map<string, SparkRegisteredToolConfig>();
  internalTools = new Map<string, SparkRegisteredToolConfig>();
  commands = new Map<string, unknown>();
  shortcuts = new Map<string, unknown>();
  events = new Map<string, Array<(event: unknown, ctx: SparkToolContext) => unknown>>();
  renderers = new Map<string, unknown>();
  messages: unknown[] = [];
  timers: Array<{ delayMs: number; label?: string }> = [];
  widgetFactories: Array<{ key: string; placement?: string; cb: unknown }> = [];

  registerTool(config: SparkRegisteredToolConfig): void {
    this.publicTools.set(config.name, config);
  }
  registerInternalTool(config: SparkRegisteredToolConfig): void {
    this.internalTools.set(config.name, config);
  }
  registerCommand(name: string, config: unknown): void {
    this.commands.set(name, config);
  }
  registerShortcut(shortcut: string, config: unknown): void {
    this.shortcuts.set(shortcut, config);
  }
  on(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void {
    const handlers = this.events.get(event) ?? [];
    handlers.push(handler);
    this.events.set(event, handlers);
  }
  sendMessage(message: unknown): void {
    this.messages.push(message);
  }
  setTimer(delayMs: number, handler: () => unknown, options?: { label?: string }): void {
    this.timers.push({ delayMs, label: options?.label });
    void handler;
  }
  clearTimer(): void {}
  registerMessageRenderer(type: string, renderer: unknown): void {
    this.renderers.set(type, renderer);
  }
  getThinkingLevel(): string {
    return "low";
  }
  getPiCommand(): string {
    return "pi";
  }
  createReviewerRunner(): ReviewerRunner {
    return {
      async review(input: ReviewInput) {
        const now = new Date().toISOString();
        const verdict = (() => {
          if (input.targetKind === "task") {
            return {
              targetKind: "task" as const,
              taskRef: input.task.ref,
              approved: true,
              outcome: "approved" as const,
              summary: "manual matrix reviewer stub approved task evidence",
              findings: [],
              blockers: [],
              confidence: "high" as const,
            };
          }
          if (input.targetKind === "goal") {
            return {
              targetKind: "goal" as const,
              goalId: input.goalId,
              achieved: input.requestedStatus === "complete",
              remainingWork:
                input.requestedStatus === "complete"
                  ? ""
                  : "manual matrix did not request completion",
              outcome: "approved" as const,
              summary: "manual matrix reviewer stub approved goal transition",
              findings: [],
              blockers: [],
              confidence: "high" as const,
            };
          }
          return {
            targetKind: "tool_approval" as const,
            toolName: input.toolName,
            approved: true,
            outcome: "approved" as const,
            summary: "manual matrix reviewer stub approved tool use",
            findings: [],
            blockers: [],
            confidence: "high" as const,
          };
        })();
        return {
          verdict,
          record: {
            roleRef: "role:manual-matrix-reviewer" as any,
            startedAt: now,
            finishedAt: now,
            stdout: JSON.stringify({ targetKind: input.targetKind }),
          },
        };
      },
      async answerAsk() {
        return { answers: {} };
      },
    };
  }
}

function tail(value: string, max = 2000): string {
  return value.length > max
    ? `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`
    : value;
}
async function run(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<StepResult> {
  const label = [command, ...argv].join(" ");
  try {
    const result = await execFileAsync(command, argv, {
      cwd,
      env,
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      name: label,
      command: label,
      ok: true,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return {
      name: label,
      command: label,
      ok: false,
      stdout: tail(err.stdout ?? ""),
      stderr: tail(err.stderr ?? String(error)),
      detail: { code: err.code },
    };
  }
}
async function step(name: string, fn: () => unknown): Promise<StepResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      error:
        error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error),
    };
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function tool(api: ManualPiApi, name: string): SparkRegisteredToolConfig {
  const config = api.publicTools.get(name) ?? api.internalTools.get(name);
  if (!config) throw new Error(`tool not registered: ${name}`);
  return config;
}
async function execTool(
  api: ManualPiApi,
  name: string,
  params: Record<string, unknown>,
  ctx: SparkToolContext,
): Promise<any> {
  const config = tool(api, name);
  return config.execute(
    `manual-${name}-${Math.random().toString(16).slice(2)}`,
    params,
    new AbortController().signal,
    async () => undefined,
    ctx,
  );
}
function textOf(result: any): string {
  return String(
    result?.content?.map?.((part: any) => part?.text ?? "").join("\n") ??
      result?.content?.[0]?.text ??
      JSON.stringify(result),
  );
}

const tempRoot = await mkdtemp(join(tmpdir(), "spark-pi-extension-manual-"));
const piHome = join(tempRoot, "pi-home");
const workspace = join(tempRoot, "workspace");
const steps: StepResult[] = [];
try {
  await writeFile(
    join(tempRoot, "README.txt"),
    "Spark Pi extension manual matrix temp root\n",
    "utf8",
  );
  await execFileAsync("mkdir", ["-p", piHome, workspace]);
  await writeFile(
    join(piHome, "settings.json"),
    JSON.stringify(
      {
        enableInstallTelemetry: false,
        npmCommand: ["pnpm"],
        packages: [repoRoot],
        enabledModels: ["baidu-oneapi/gpt-5.5"],
        defaultProvider: "baidu-oneapi",
        defaultModel: "gpt-5.5",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify(
      { name: "manual-pi-extension-workspace", private: true, type: "module" },
      null,
      2,
    ),
    "utf8",
  );
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: piHome,
    PI_OFFLINE: "1",
    SPARK_REVIEWER_TIMEOUT_MS: "5000",
  };

  steps.push(await run("pi", ["--offline", "--help"], repoRoot, env));
  steps.push(await run("pi", ["--offline", "--list-models", "baidu"], repoRoot, env));

  const api = new ManualPiApi();
  sparkExtension(api as any);
  const sessionKey = "session:manual-pi-extension";
  const widgetRegistrations: unknown[] = [];
  const ctx: SparkToolContext = {
    cwd: workspace,
    model: "baidu-oneapi/gpt-5.5",
    sessionManager: {
      getLeafId: () => sessionKey,
      getSessionFile: () => join(tempRoot, "manual-session.jsonl"),
    },
    ui: {
      setWidget: (key: string, cb: unknown, options?: { placement?: string }) => {
        api.widgetFactories.push({ key, cb, placement: options?.placement });
        widgetRegistrations.push({
          key,
          placement: options?.placement,
          hasFactory: typeof cb === "function",
        });
      },
    },
    runRole: async () => ({
      exitStatus: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
      jsonEvents: [],
    }),
  } as any;

  steps.push(
    await step("extension registers expected Pi surfaces", () => {
      const publicTools = Array.from(api.publicTools.keys()).sort();
      const internalTools = Array.from(api.internalTools.keys()).sort();
      const requiredPublic = [
        "goal",
        "loop",
        "repro",
        "drive",
        "phase",
        "workflow_run",
        "task_read",
        "task_write",
        "assign",
        "todo",
        "learning",
        "context",
      ];
      const missingPublic = requiredPublic.filter((name) => !api.publicTools.has(name));
      const requiredInternal = [
        "impl_status",
        "impl_state",
        "impl_claim_task",
        "impl_finish_task",
        "impl_plan_tasks",
        "impl_run_ready_tasks",
        "impl_workflow_runs",
      ];
      const missingInternal = requiredInternal.filter((name) => !api.internalTools.has(name));
      assert(missingPublic.length === 0, `missing public tools: ${missingPublic.join(", ")}`);
      assert(missingInternal.length === 0, `missing internal tools: ${missingInternal.join(", ")}`);
      assert(api.commands.size >= 8, `expected commands, got ${api.commands.size}`);
      assert(api.events.size >= 5, `expected event handlers, got ${api.events.size}`);
      return {
        publicTools,
        internalTools,
        commands: Array.from(api.commands.keys()).sort(),
        events: Array.from(api.events.keys()).sort(),
        shortcuts: Array.from(api.shortcuts.keys()).sort(),
        renderers: Array.from(api.renderers.keys()).sort(),
      };
    }),
  );

  steps.push(
    await step("project/task/todo lifecycle through canonical task_write/task_read", async () => {
      const use = await execTool(
        api,
        "task_write",
        {
          action: "project_use",
          title: "Manual Pi Extension Matrix",
          purpose: "exercise current pi-extension",
        },
        ctx,
      );
      const projectText = textOf(use);
      assert(/Created new Spark project|Using Spark project/u.test(projectText), projectText);
      const plan = await execTool(
        api,
        "task_write",
        {
          action: "plan",
          tasks: [
            {
              name: "manual-extension-task",
              title: "Manual extension lifecycle task",
              description:
                "Exercise claim, task plan item updates, reviewer-gated finish, and status reads through the Pi facade.",
              status: "ready",
              kind: "implement",
              plan: {
                objective: "Complete a temporary lifecycle task through the Pi extension facade.",
                contextRefs: [],
                constraints: ["Use only the temp workspace created by the manual matrix."],
                nonGoals: ["Do not mutate the real user project."],
                successCriteria: [
                  "The task reaches done status in task_read project_status output.",
                ],
                evidenceRequired: [
                  "Manual matrix report captures plan, claim, todo update, finish, and status output.",
                ],
                steps: [
                  "Inspect task_read project_status output for the Manual Pi Extension Matrix project before claiming.",
                  "Run task_write claim for @manual-extension-task and verify the claimed-by-current-session status.",
                  "Run task_write plan_update and task_write finish, then verify task_read reports one done task.",
                ],
                riskLevel: "normal",
                openQuestions: [],
                askRefs: [],
              },
            },
          ],
        },
        ctx,
      );
      const planText = textOf(plan);
      assert(/Planned tasks: created=1/u.test(planText), planText);
      const claim = await execTool(
        api,
        "task_write",
        { action: "claim", project: "Manual Pi Extension Matrix", task: "manual-extension-task" },
        ctx,
      );
      const claimText = textOf(claim);
      assert(/Claimed Spark task/u.test(claimText), claimText);
      const todoInit = await execTool(
        api,
        "task_write",
        {
          action: "plan_update",
          scope: "task",
          ops: [
            {
              op: "init",
              items: [
                "Inspect task_read project_status before finish",
                "Run task_write finish with reviewer stub",
              ],
            },
          ],
        },
        ctx,
      );
      const todoDone = await execTool(
        api,
        "task_write",
        {
          action: "plan_update",
          scope: "task",
          ops: [
            { op: "done", item: "Inspect task_read project_status before finish" },
            { op: "done", item: "Run task_write finish with reviewer stub" },
          ],
        },
        ctx,
      );
      const todoText = `${textOf(todoInit)}\n${textOf(todoDone)}`;
      assert(/Updated plan items/u.test(todoText), todoText);
      const finish = await execTool(
        api,
        "task_write",
        {
          action: "finish",
          status: "done",
          summary: "manual matrix lifecycle completed",
          evidence: {
            validationCommands: ["manual matrix lifecycle"],
            changedFiles: [],
            sourceRefs: [],
            notes: "reviewer stub approved",
          },
        },
        ctx,
      );
      const finishText = textOf(finish);
      assert(/Finished Spark task/u.test(finishText), finishText);
      const status = await execTool(
        api,
        "task_read",
        {
          action: "project_status",
          project: "Manual Pi Extension Matrix",
          view: "active",
          format: "json",
        },
        ctx,
      );
      assert(
        status.details?.selectedProject?.taskCounts?.statusCounts?.done === 1,
        JSON.stringify(status.details),
      );
      const taskStatus = await execTool(
        api,
        "task_read",
        {
          action: "task_status",
          project: "Manual Pi Extension Matrix",
          task: "manual-extension-task",
          format: "json",
        },
        ctx,
      );
      assert(
        taskStatus.details?.selectedTask?.status === "done",
        JSON.stringify(taskStatus.details),
      );
      const workspaceStatus = await execTool(
        api,
        "task_read",
        { action: "workspace_status", format: "json", limit: 5 },
        ctx,
      );
      assert(
        workspaceStatus.details?.projects?.length >= 1 ||
          /Manual Pi Extension Matrix/u.test(textOf(workspaceStatus)),
        textOf(workspaceStatus),
      );
      const projectList = await execTool(
        api,
        "task_read",
        { action: "project_list", limit: 5 },
        ctx,
      );
      assert(/Manual Pi Extension Matrix/u.test(textOf(projectList)), textOf(projectList));
      const renamed = await execTool(
        api,
        "task_write",
        {
          action: "project_rename",
          project: "Manual Pi Extension Matrix",
          title: "Manual Pi Extension Matrix Renamed",
        },
        ctx,
      );
      assert(/Renamed|Manual Pi Extension Matrix Renamed/u.test(textOf(renamed)), textOf(renamed));
      const metadata = await execTool(
        api,
        "task_write",
        {
          action: "project_metadata_update",
          project: "Manual Pi Extension Matrix Renamed",
          purpose: "manual matrix metadata update",
          outputLanguage: "en",
        },
        ctx,
      );
      assert(
        /Updated|metadata|Manual Pi Extension Matrix Renamed/u.test(textOf(metadata)),
        textOf(metadata),
      );
      const cleanup = await execTool(
        api,
        "task_write",
        { action: "cache_cleanup", dryRun: true, olderThanDays: 9999 },
        ctx,
      );
      assert(/dry|cache|cleanup|No/u.test(textOf(cleanup)), textOf(cleanup));
      return {
        projectText: tail(projectText),
        plan: tail(planText),
        claim: tail(claimText),
        todo: tail(todoText),
        finish: tail(finishText),
        taskStatus: taskStatus.details,
        workspaceStatus: tail(textOf(workspaceStatus)),
        projectList: tail(textOf(projectList)),
        renamed: tail(textOf(renamed)),
        metadata: tail(textOf(metadata)),
        cleanup: tail(textOf(cleanup)),
        statusDetails: status.details,
      };
    }),
  );

  steps.push(
    await step("goal loop repro drive phase tools", async () => {
      const goalStart = await execTool(
        api,
        "goal",
        { action: "start", objective: "manual extension goal" },
        ctx,
      );
      assert(/goal active|Goal/u.test(textOf(goalStart)), textOf(goalStart));
      const goalStatus = await execTool(api, "goal", { action: "status" }, ctx);
      assert(/manual extension goal/u.test(textOf(goalStatus)), textOf(goalStatus));
      const goalEdit = await execTool(
        api,
        "goal",
        {
          action: "edit",
          objective: "manual extension goal edited",
          reason: "manual matrix verifies edit action",
        },
        ctx,
      );
      assert(
        /edited|active|manual extension goal edited/u.test(textOf(goalEdit)),
        textOf(goalEdit),
      );
      const goalComplete = await execTool(api, "goal", { action: "complete" }, ctx);
      assert(
        /complete|approved|Spark session goal complete/u.test(textOf(goalComplete)),
        textOf(goalComplete),
      );

      const driveLoop = await execTool(
        api,
        "drive",
        { action: "start", drive: "loop", objective: "manual loop objective" },
        ctx,
      );
      assert(/loop|Mode/u.test(textOf(driveLoop)), textOf(driveLoop));
      const loopSchedule = await execTool(
        api,
        "loop",
        { action: "schedule", delayMs: 1000, reason: "manual matrix cadence" },
        ctx,
      );
      assert(/scheduled|next|loop/i.test(textOf(loopSchedule)), textOf(loopSchedule));
      const loopStatus = await execTool(api, "loop", { action: "status" }, ctx);
      assert(
        /manual loop objective|scheduled|active/i.test(textOf(loopStatus)),
        textOf(loopStatus),
      );
      const loopClear = await execTool(api, "loop", { action: "clear" }, ctx);
      assert(/cleared|No Spark loop/i.test(textOf(loopClear)), textOf(loopClear));

      const reproStart = await execTool(
        api,
        "repro",
        { action: "start", objective: "manual repro focus" },
        ctx,
      );
      assert(/Repro drive started/u.test(textOf(reproStart)), textOf(reproStart));
      const reproStatus = await execTool(api, "repro", { action: "status" }, ctx);
      assert(
        /Stage:|manual repro focus|Acceptance/u.test(textOf(reproStatus)),
        textOf(reproStatus),
      );
      const reproStop = await execTool(api, "repro", { action: "stop" }, ctx);
      assert(/stopped|cleared|No Spark repro/i.test(textOf(reproStop)), textOf(reproStop));

      const driveStatus = await execTool(api, "drive", { action: "status" }, ctx);
      let removedPhaseRejected = "";
      try {
        await execTool(api, "phase", { action: "research", focus: "manual phase" }, ctx);
      } catch (error) {
        removedPhaseRejected = error instanceof Error ? error.message : String(error);
      }
      assert(
        /phase action must be one of: plan, implement, status/i.test(removedPhaseRejected),
        removedPhaseRejected,
      );
      const phasePlan = await execTool(
        api,
        "phase",
        { action: "plan", focus: "manual phase" },
        ctx,
      );
      const phaseImplement = await execTool(
        api,
        "phase",
        { action: "implement", focus: "manual phase" },
        ctx,
      );
      const phaseStatus = await execTool(api, "phase", { action: "status" }, ctx);
      assert(/plan/i.test(textOf(phasePlan)), textOf(phasePlan));
      assert(/implement/i.test(textOf(phaseImplement)), textOf(phaseImplement));
      assert(/implement/i.test(textOf(phaseStatus)), textOf(phaseStatus));
      return {
        goalStart: tail(textOf(goalStart)),
        goalStatus: tail(textOf(goalStatus)),
        goalEdit: tail(textOf(goalEdit)),
        goalComplete: tail(textOf(goalComplete)),
        driveLoop: tail(textOf(driveLoop)),
        loopSchedule: tail(textOf(loopSchedule)),
        loopStatus: tail(textOf(loopStatus)),
        loopClear: tail(textOf(loopClear)),
        reproStart: tail(textOf(reproStart)),
        reproStatus: tail(textOf(reproStatus)),
        reproStop: tail(textOf(reproStop)),
        driveStatus: tail(textOf(driveStatus)),
        removedPhaseRejected: tail(removedPhaseRejected),
        phasePlan: tail(textOf(phasePlan)),
        phaseImplement: tail(textOf(phaseImplement)),
        phaseStatus: tail(textOf(phaseStatus)),
      };
    }),
  );

  steps.push(
    await step("workflow/run-status/assign read surfaces", async () => {
      const workflowStatus = await execTool(
        api,
        "workflow_run",
        {
          script:
            "export const meta = { name: 'manual noop', description: 'manual matrix noop' }\nreturn { ok: true }",
          args: {},
          wait: true,
          maxAgents: 1,
          concurrency: 1,
          tokenBudget: 1000,
        },
        ctx,
      );
      const workflowText = textOf(workflowStatus);
      assert(/succeeded|ok|completed/u.test(workflowText), workflowText);
      const runList = await execTool(
        api,
        "task_read",
        { action: "run_status", runAction: "list", limit: 5 },
        ctx,
      );
      const runListText = textOf(runList);
      assert(/Dynamic workflow runs|Background work/u.test(runListText), runListText);
      const runRef =
        workflowStatus.details?.workflow?.ref ??
        workflowStatus.details?.workflow?.runRef ??
        /run:[0-9a-f-]+/u.exec(workflowText)?.[0];
      assert(runRef, workflowText);
      const runInspect = await execTool(
        api,
        "task_read",
        { action: "run_status", runAction: "inspect", runRef },
        ctx,
      );
      assert(/manual noop|succeeded|Result/u.test(textOf(runInspect)), textOf(runInspect));
      const runAck = await execTool(
        api,
        "task_read",
        { action: "run_status", runAction: "ack", runRef },
        ctx,
      );
      assert(/ack|acknowledged|Dynamic workflow/i.test(textOf(runAck)), textOf(runAck));
      const assignDry = await execTool(api, "assign", { dryRun: true, maxConcurrency: 1 }, ctx);
      const assignText = textOf(assignDry);
      assert(/Dry-run/u.test(assignText), assignText);
      return {
        workflowStatus: tail(workflowText),
        runList: tail(runListText),
        runInspect: tail(textOf(runInspect)),
        runAck: tail(textOf(runAck)),
        assignDry: tail(assignText),
      };
    }),
  );

  steps.push(
    await step("learning/context/widget rendering", async () => {
      const learningRecord = await execTool(
        api,
        "learning",
        {
          action: "record",
          id: "manual-pi-extension-matrix",
          title: "Manual Pi extension matrix",
          statement: "Current pi-extension manual matrix executed in temp workspace.",
          category: "tool",
          location: "workspace",
          rationale: "manual validation",
          applicability: "pi-extension smoke",
          evidenceRefs: [],
          tags: ["manual-matrix"],
          confidence: 0.8,
        },
        ctx,
      );
      assert(/Recorded learning/u.test(textOf(learningRecord)), textOf(learningRecord));
      const learningSearch = await execTool(
        api,
        "learning",
        { action: "search", query: "manual matrix", limit: 5 },
        ctx,
      );
      assert(
        /manual-pi-extension-matrix|Manual Pi extension matrix/u.test(textOf(learningSearch)),
        textOf(learningSearch),
      );
      const learningList = await execTool(api, "learning", { action: "list", limit: 5 }, ctx);
      assert(
        /Manual Pi extension matrix|manual-pi-extension-matrix/u.test(textOf(learningList)),
        textOf(learningList),
      );
      const learningRead = await execTool(
        api,
        "learning",
        { action: "read", ref: "artifact:manual-pi-extension-matrix" },
        ctx,
      );
      assert(
        /Current pi-extension manual matrix/u.test(textOf(learningRead)),
        textOf(learningRead),
      );
      const exportPath = join(tempRoot, "learnings.md");
      const learningExport = await execTool(
        api,
        "learning",
        { action: "export_markdown", outputPath: exportPath },
        ctx,
      );
      assert(/export|wrote|learnings/i.test(textOf(learningExport)), textOf(learningExport));
      const learningImportPreview = await execTool(
        api,
        "learning",
        { action: "import_markdown", inputPath: exportPath, apply: false },
        ctx,
      );
      assert(
        /preview|import|would|learning/i.test(textOf(learningImportPreview)),
        textOf(learningImportPreview),
      );
      const rejected = await execTool(
        api,
        "learning",
        {
          action: "record",
          id: "manual-pi-extension-matrix-reject",
          title: "Manual matrix reject candidate",
          statement: "Temporary reject candidate.",
          category: "tool",
          location: "workspace",
          rationale: "manual validation",
          applicability: "pi-extension smoke",
          evidenceRefs: [],
          tags: ["manual-matrix"],
          confidence: 0.5,
        },
        ctx,
      );
      assert(/Recorded learning/u.test(textOf(rejected)), textOf(rejected));
      const learningReject = await execTool(
        api,
        "learning",
        {
          action: "reject",
          ref: "artifact:manual-pi-extension-matrix-reject",
          reason: "manual matrix reject action smoke",
        },
        ctx,
      );
      assert(/rejected|Reject/i.test(textOf(learningReject)), textOf(learningReject));
      const contextList = await execTool(api, "context", { action: "list" }, ctx);
      assert(/spark\.active/u.test(textOf(contextList)), textOf(contextList));
      const contextPreview = await execTool(
        api,
        "context",
        { action: "preview", providerIds: ["spark.active"], budgetChars: 1000 },
        ctx,
      );
      assert(
        /Spark context|Manual Pi Extension Matrix/u.test(textOf(contextPreview)),
        textOf(contextPreview),
      );
      for (const handler of api.events.get("session_start") ?? []) await handler({}, ctx);
      for (const handler of api.events.get("tool_execution_end") ?? [])
        await handler(
          {
            toolName: "goal",
            args: { action: "complete" },
            result: { details: { status: "complete" } },
          },
          ctx,
        );
      const factory = api.widgetFactories.find((entry) => typeof entry.cb === "function")?.cb as
        | ((tui: SparkWidgetTui, theme: SparkWidgetTheme) => { render(): string[] })
        | undefined;
      const widgetLines =
        factory?.(
          { terminal: { columns: 140 }, requestRender() {} },
          { fg: (_color, text) => text, bold: (text) => text, strikethrough: (text) => text },
        )?.render?.() ?? [];
      const directWidgetLines = renderSparkWidgetLines(
        {
          projectTitle: "Manual Pi Extension Matrix",
          goal: { status: "active", objective: "manual" },
          projects: [
            {
              title: "Manual Pi Extension Matrix",
              active: true,
              totalTasks: 1,
              doneTasks: 1,
              readyTasks: 0,
            },
          ],
          tasks: [],
          independentTodos: [],
          taskCountTotal: 1,
          taskCountClaimed: 0,
          taskCountClaimedBySession: 0,
          outputLanguage: "en",
        },
        { terminal: { columns: 140 }, requestRender() {} },
        { fg: (_color, text) => text, bold: (text) => text, strikethrough: (text) => text },
      );
      return {
        learningRecord: tail(textOf(learningRecord)),
        learningSearch: tail(textOf(learningSearch)),
        learningList: tail(textOf(learningList)),
        learningRead: tail(textOf(learningRead)),
        learningExport: tail(textOf(learningExport)),
        learningImportPreview: tail(textOf(learningImportPreview)),
        learningReject: tail(textOf(learningReject)),
        contextList: tail(textOf(contextList)),
        contextPreview: tail(textOf(contextPreview)),
        widgetRegistrations,
        widgetLines,
        directWidgetLines,
      };
    }),
  );

  const ok = steps.every((entry) => entry.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    tempRoot,
    piHome,
    workspace,
    ok,
    stepCount: steps.length,
    steps,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        ok,
        stepCount: steps.length,
        failed: steps.filter((entry) => !entry.ok).map((entry) => entry.name),
        tempRoot: keep ? tempRoot : undefined,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
} finally {
  if (!keep) await rm(tempRoot, { recursive: true, force: true });
}
