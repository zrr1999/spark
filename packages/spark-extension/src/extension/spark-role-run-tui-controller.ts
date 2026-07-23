import type { ProjectRef, TaskRef } from "@zendev-lab/spark-core";

import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import { loadRoleRunActivityEvents } from "./role-run-activity-events.ts";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { currentSparkProject, loadSparkGraph } from "./session-state.ts";
import {
  buildSparkRoleRunRegistry,
  serializeSparkRoleRunRegistry,
  type SparkRoleRunRegistryEntry,
  type SparkRoleRunRegistrySnapshot,
} from "./spark-role-run-observability.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import {
  formatSparkRoleRunStatusSummary,
  renderSparkRoleRunBoardLines,
  renderSparkRoleRunCompletionMessageLines,
  roleRunCompletionMessageContent,
  type SparkRoleRunTaskInfoByRef,
  type SparkRoleRunTuiTheme,
} from "../ui/spark-role-run-tui.ts";

const ROLE_RUN_WIDGET_KEY = "spark-role-runs";
const ROLE_RUN_STATUS_KEY = "spark-role-runs";
const ROLE_RUN_MESSAGE_TYPE = "spark-role-run-completion";

interface SparkRoleRunTuiApi {
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  registerMessageRenderer?(
    customType: string,
    renderer: (
      message: { content: unknown; details?: unknown },
      options: { expanded?: boolean },
      theme: SparkRoleRunTuiTheme,
    ) => { render(width: number): string[]; invalidate(): void },
  ): void;
}

export class SparkRoleRunTuiController {
  private initialized = false;
  private renderedWidget = false;
  private renderedStatus = false;
  private readonly announcedTerminalKeys = new Set<string>();
  private readonly pi: SparkRoleRunTuiApi;

  constructor(pi: SparkRoleRunTuiApi) {
    this.pi = pi;
    this.registerCompletionRenderer();
  }

  async refresh(cwd: string, ctx?: SparkToolContext): Promise<void> {
    await ensureLocalSparkDirectory(cwd);
    const graph = await loadSparkGraph(cwd, ctx);
    const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
    if (!graph || !project) {
      this.clearUi(ctx);
      return;
    }

    const snapshot = buildSparkRoleRunRegistry({
      graph,
      projectRef: project.ref,
      activeProcesses: activeSparkRoleRunProcessesForCwd(cwd),
      activityEvents: await loadRoleRunActivityEvents(cwd),
    });
    const taskInfoByRef: SparkRoleRunTaskInfoByRef = Object.fromEntries(
      graph.tasks(project.ref).map((task) => [task.ref, { name: task.name, title: task.title }]),
    ) as SparkRoleRunTaskInfoByRef;

    this.renderUi(ctx, snapshot, taskInfoByRef);
    this.announceTerminalTransitions(snapshot, project.ref, ctx);
  }

  private clearUi(ctx: SparkToolContext | undefined): void {
    if (this.renderedStatus) {
      ctx?.ui?.setStatus?.(ROLE_RUN_STATUS_KEY, undefined);
      this.renderedStatus = false;
    }
    if (this.renderedWidget) {
      ctx?.ui?.setWidget?.(ROLE_RUN_WIDGET_KEY, undefined, { placement: "belowEditor" });
      this.renderedWidget = false;
    }
  }

  private renderUi(
    ctx: SparkToolContext | undefined,
    snapshot: SparkRoleRunRegistrySnapshot,
    taskInfoByRef: SparkRoleRunTaskInfoByRef,
  ): void {
    const status = formatSparkRoleRunStatusSummary(snapshot);
    if (status || this.renderedStatus) {
      ctx?.ui?.setStatus?.(ROLE_RUN_STATUS_KEY, status);
      this.renderedStatus = Boolean(status);
    }
    const width = 120;
    const lines = renderSparkRoleRunBoardLines(snapshot, taskInfoByRef, {
      width,
      now: snapshot.generatedAt,
    });
    if (lines.length > 0 || this.renderedWidget) {
      ctx?.ui?.setWidget?.(ROLE_RUN_WIDGET_KEY, lines.length > 0 ? lines : undefined, {
        placement: "belowEditor",
      });
      this.renderedWidget = lines.length > 0;
    }
  }

  private announceTerminalTransitions(
    snapshot: SparkRoleRunRegistrySnapshot,
    projectRef: ProjectRef,
    ctx: SparkToolContext | undefined,
  ): void {
    const terminalEntries = snapshot.entries.filter(isTerminalEntry);
    if (!this.initialized) {
      for (const entry of terminalEntries) this.announcedTerminalKeys.add(terminalKey(entry));
      this.initialized = true;
      return;
    }
    if (ctx?.hasUI === false) return;
    for (const entry of terminalEntries) {
      const key = terminalKey(entry);
      if (this.announcedTerminalKeys.has(key)) continue;
      this.announcedTerminalKeys.add(key);
      this.pi.sendMessage?.(
        {
          customType: ROLE_RUN_MESSAGE_TYPE,
          content: roleRunCompletionMessageContent(entry),
          display: true,
          details: {
            ...serializeSparkRoleRunRegistry({
              generatedAt: snapshot.generatedAt,
              projectRef,
              counts: snapshot.counts,
              entries: [entry],
            }).entries[0],
          },
        },
        // Default: wake the owner session so it can synthesize the result now,
        // matching async subagent completion behavior in competing hosts.
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  }

  private registerCompletionRenderer(): void {
    this.pi.registerMessageRenderer?.(ROLE_RUN_MESSAGE_TYPE, (message, options, theme) => ({
      render: (width: number) =>
        renderSparkRoleRunCompletionMessageLines(
          message.details,
          {
            expanded: options.expanded,
            width,
          },
          theme,
        ),
      invalidate() {},
    }));
  }
}

function isTerminalEntry(entry: SparkRoleRunRegistryEntry): boolean {
  return (
    entry.status === "done" ||
    entry.status === "blocked" ||
    entry.status === "failed" ||
    entry.status === "cancelled"
  );
}

function terminalKey(entry: SparkRoleRunRegistryEntry): string {
  return `${entry.runRef}:${entry.status}:${entry.finishedAt ?? entry.updatedAt}`;
}

export function roleRunTaskInfoByRefForTests(
  entries: Array<{ ref: TaskRef; name?: string; title?: string }>,
): SparkRoleRunTaskInfoByRef {
  return Object.fromEntries(
    entries.map((entry) => [entry.ref, { name: entry.name, title: entry.title }]),
  ) as SparkRoleRunTaskInfoByRef;
}
