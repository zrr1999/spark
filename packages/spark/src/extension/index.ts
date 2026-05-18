import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { Type } from "typebox";
import { registerSparkAskTool } from "spark-ask";
import { defaultArtifactStore } from "spark-artifacts";
import {
  approveManagedAgentAsk,
  clarifyThreadAsk,
  createSparkAskRequest,
  detectCopyLanguage,
  isSparkAskArtifactBody,
  replaySparkAsk,
  reviewGateAsk,
  runSparkAsk,
  resolveTaskBlockerAsk,
  type SparkCopyLanguage,
} from "spark-ask";
import {
  AgentRegistry,
  builtinAgentRef,
  createManagedAgentSpec,
  defaultManagedAgentStore,
} from "spark-agents";
import {
  newRef,
  nowIso,
  type ArtifactRef,
  type AskRef,
  type JsonValue,
  type ManagedAgentProposal,
  type SparkRunTrace,
  type ThreadRef,
} from "spark-core";
import { registerPiCueTools } from "pi-cue";
import { createReviewGate } from "spark-review";
import { defaultTaskGraphStore, TaskGraph } from "spark-tasks";
import { SparkWidget, type SparkWidgetState, type TaskEntry } from "../ui/spark-widget.ts";

interface SparkExtensionAPI {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: SparkCommandContext) => void | Promise<void>;
    },
  ): void;
  registerTool?(config: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: SparkToolContext,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  on?(event: string, handler: (event: unknown, ctx: SparkToolContext) => unknown): void;
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

interface SparkToolContext {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    setWidget?: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface SparkCommandContext extends SparkToolContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}

export default function sparkExtension(pi: SparkExtensionAPI) {
  if (pi.registerTool) {
    registerPiCueTools(pi as unknown as Parameters<typeof registerPiCueTools>[0]);
    registerSparkAskTool(pi as unknown as Parameters<typeof registerSparkAskTool>[0]);
  }

  pi.on?.("input", async (event: unknown, ctx: SparkToolContext) => handleSparkInput(event, ctx));
  pi.on?.("before_agent_start", async (event: unknown, ctx: SparkToolContext) =>
    injectSparkHints(event, ctx),
  );
  pi.on?.("turn_start", async (_event: unknown, ctx: SparkToolContext) => {
    await refreshSparkWidget(ctx.cwd, ctx);
  });
  pi.on?.("session_switch", async (_event: unknown, ctx: SparkToolContext) => {
    // Restore widget after session switch (/new, /resume)
    const graph = await defaultTaskGraphStore(ctx.cwd).load();
    if (graph) {
      if (ensureSparkGraphInvariants(graph)) await defaultTaskGraphStore(ctx.cwd).save(graph);
      await refreshSparkWidget(ctx.cwd, ctx);
    }
  });

  const widget = new SparkWidget(
    () => undefined,
    (key, cb) => {
      // Widget will register lazily via refreshSparkWidget
    },
  );

  async function refreshSparkWidget(cwd: string, ctx?: SparkToolContext): Promise<void> {
    const store = defaultTaskGraphStore(cwd);
    const graph = await store.load();
    if (!graph) {
      widget.update();
      return;
    }
    if (ensureSparkGraphInvariants(graph)) await store.save(graph);
    const thread = graph.threads()[0];
    if (!thread) {
      widget.update();
      return;
    }
    const summary = graph.threadTodoSummary(thread.ref);

    const tasks: TaskEntry[] = graph.tasks(thread.ref).map((task) => {
      const todo = graph.todoSummary(task.ref);
      return {
        title: task.title,
        status: mapTaskStatus(task.status),
        todoActive: todo.active,
        todosDone: todo.done,
        todosTotal: todo.total,
      } satisfies TaskEntry;
    });

    const state: SparkWidgetState = {
      threadTitle: thread.title,
      tasks,
      todosTotal: summary.total,
      todosInProgress: summary.inProgress,
      todosPending: summary.pending,
      todosDone: summary.done,
      outputLanguage: (thread.outputLanguage as "zh" | "en" | undefined) ?? "en",
    };

    // Re-point widget at the current state, then register with the current UI ctx
    const widgetWithState = new SparkWidget(
      () => state,
      (key, cb) => {
        (ctx?.ui as { setWidget?: (...args: unknown[]) => void } | null | undefined)?.setWidget?.(
          key,
          cb,
          { placement: "aboveEditor" },
        );
      },
    );
    widgetWithState.update();
  }

  function mapTaskStatus(status: string): TaskEntry["status"] {
    switch (status) {
      case "running":
        return "running";
      case "done":
        return "done";
      case "failed":
      case "cancelled":
        return "failed";
      default:
        return "pending";
    }
  }

  pi.registerCommand("spark", {
    description:
      "Turn an idea into SPARK.md, a thread/task DAG, agent plan, artifacts, and review gates.",
    async handler(args, ctx) {
      const idea = args.trim();
      if (!idea) {
        ctx.ui?.notify?.("Usage: /spark <idea>", "warning");
        return;
      }

      const language = detectCopyLanguage(idea);
      let outputLanguage: SparkCopyLanguage = language;

      // Targeted clarification with options, not a broad form
      let workingTitle = titleFromIdea(idea);
      let deliveryMode: string | undefined;
      let targetUser: string | undefined;

      if (ctx.ui?.select) {
        // First: confirm output language
        const langChoice = await ctx.ui.select(
          language === "zh"
            ? "Spark 生成的文档和界面用什么语言？"
            : "Which language should Spark use for generated documents and UI?",
          language === "zh" ? ["中文", "English"] : ["中文", "English"],
        );
        if (langChoice === undefined) return;
        outputLanguage = langChoice === "中文" ? "zh" : "en";

        const titleChoice = await ctx.ui.select(
          outputLanguage === "zh" ? "这个线程叫什么名字？" : "What should this thread be called?",
          [
            `"${workingTitle}"`,
            outputLanguage === "zh" ? "「自定义输入」" : "[Enter custom title]",
          ],
        );
        if (titleChoice === undefined) return;
        if (titleChoice.startsWith("[")) {
          const custom = await ctx.ui!.input!(
            outputLanguage === "zh" ? "输入标题" : "Enter title",
            workingTitle,
          );
          if (!custom) return;
          workingTitle = custom.trim();
        } else {
          workingTitle = titleChoice.replace(/^"|"$/g, "");
        }

        const modeChoice = await ctx.ui.select(
          outputLanguage === "zh" ? "这次交付范围是什么？" : "What scope of delivery do you want?",
          outputLanguage === "zh"
            ? ["只做规划", "规划 + 文档", "规划 + 文档 + 实现", "直接实现"]
            : ["Plan only", "Plan + document", "Plan + document + implement", "Implement directly"],
        );
        if (modeChoice === undefined) return;
        deliveryMode = mapDeliveryChoice(modeChoice, outputLanguage);

        const audienceChoice = await ctx.ui.select(
          outputLanguage === "zh" ? "这是给谁用的？" : "Who is this for?",
          outputLanguage === "zh"
            ? ["我自己", "我的团队", "公开项目"]
            : ["Myself", "My team", "A public project"],
        );
        if (audienceChoice === undefined) return;
        targetUser = audienceChoice;
      }

      const result = await initializeSparkIdea(ctx.cwd, idea, {
        threadTitle: workingTitle,
        outputLanguage,
        clarification: {
          workingTitle,
          outputLanguage,
          deliveryMode,
          targetUser,
        },
      });

      ctx.ui?.notify?.(
        language === "zh" ? "Spark 线程已初始化" : "Spark thread initialized",
        "success",
      );
      pi.sendUserMessage?.(renderSparkInitSummary(result), {
        deliverAs: "followUp",
      });

      await refreshSparkWidget(ctx.cwd, ctx);

      // Auto-execute the first ready task (scout — no dependencies)
      const store = defaultTaskGraphStore(ctx.cwd);
      const graph = await store.load();
      if (graph) {
        const ready = graph.enqueueReadyTasks(result.threadRef as ThreadRef);
        if (ready.length > 0) {
          const registry = new AgentRegistry();
          await defaultManagedAgentStore(ctx.cwd).hydrate(registry);
          const artifactStore = defaultArtifactStore(ctx.cwd);
          for (const task of ready) {
            await graph.runTask({
              taskRef: task.ref,
              registry,
              artifactStore,
              cwd: ctx.cwd,
            });
          }
          await store.save(graph);
        }
      }
    },
  });

  pi.registerTool?.({
    name: "spark_status",
    label: "Spark Status",
    description: "Show the current Spark thread/task DAG status for the active workspace.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd =
        typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();
      const store = defaultTaskGraphStore(cwd);
      const graph = await store.load();
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) await store.save(graph);
      const lines = ["Spark tasks:"];
      for (const thread of graph.threads()) {
        const current = graph.currentTask(thread.ref);
        const summary = graph.threadTodoSummary(thread.ref);
        lines.push(`\nThread ${thread.ref}: ${thread.title}`);
        lines.push(`  Current task: ${current ? `${current.title} (${current.ref})` : "none"}`);
        lines.push(
          `  TODOs: ${summary.total} total | ${summary.inProgress} in_progress | ${summary.pending} pending | ${summary.done} done | ${summary.blocked} blocked | ${summary.cancelled} cancelled`,
        );
        for (const task of graph.tasks(thread.ref)) {
          const todo = graph.todoSummary(task.ref);
          const activeTodo = todo.active ? ` todo=${todo.active}` : "";
          lines.push(
            `- [${task.status}] ${task.title} (${task.ref}) kind=${task.kind} agent=${task.agentRef ?? "unbound"} todos=${todo.done}/${todo.total} done${activeTodo}`,
          );
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: graph.snapshot() as unknown as Record<string, unknown>,
      };
    },
  });

  pi.registerTool?.({
    name: "spark_run_ready_tasks",
    label: "Spark Run Ready Tasks",
    description: "Dry-run all currently ready Spark tasks and persist task run artifacts.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd =
        typeof (ctx as { cwd?: unknown }).cwd === "string"
          ? (ctx as { cwd: string }).cwd
          : process.cwd();
      const store = defaultTaskGraphStore(cwd);
      const graph = await store.load();
      if (!graph)
        return {
          content: [{ type: "text", text: "No Spark thread found." }],
          details: { found: false },
        };
      if (ensureSparkGraphInvariants(graph)) await store.save(graph);
      const artifactStore = defaultArtifactStore(cwd);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const ready = graph.enqueueReadyTasks();
      const runs: unknown[] = [];
      for (const task of ready) {
        runs.push(
          await graph.runTask({
            taskRef: task.ref,
            registry,
            artifactStore,
            cwd,
            dryRun: params.dryRun !== false,
          }),
        );
      }
      await store.save(graph);
      return {
        content: [{ type: "text", text: `Ran ${runs.length} ready Spark task(s).` }],
        details: { runs: runs as unknown as Record<string, unknown>[] },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_ask",
    label: "Spark Ask",
    description:
      "Ask the user a structured clarification, decision, approval, or unblock question and persist the answer as an artifact.",
    parameters: Type.Object({
      kind: Type.String({
        description: "clarification | decision | approval | unblock",
      }),
      question: Type.String({ description: "Question shown to the user." }),
      options: Type.Array(
        Type.Object({
          id: Type.String(),
          label: Type.String(),
          description: Type.String(),
          preview: Type.Optional(Type.String()),
        }),
      ),
      multiSelect: Type.Optional(Type.Boolean({ default: false })),
      defaultOptionId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        question: string;
        options?: Array<{ id: string; label: string; description: string }>;
        multiSelect?: boolean;
        timeoutMs?: number;
      };
      const cwd = ctxCwd(ctx);
      const request = createSparkAskRequest({
        flow: "custom",
        title: p.question,
        questions: [
          {
            id: "answer",
            prompt: p.question,
            type: p.multiSelect === true ? "multi" : "single",
            options:
              p.options?.map((option) => ({
                value: option.id,
                label: option.label,
                description: option.description,
              })) ?? [],
            required: true,
          },
        ],
        behaviour: {
          allowElaborate: true,
          allowReplay: true,
          preservePriorAnswers: true,
        },
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      });
      const result = await runSparkAsk(request, sparkAskUi(ctx));
      const sparkAskRequest = request as { title?: string };
      const artifact = await defaultArtifactStore(cwd).put({
        kind: "ask-answer",
        title: `Ask answer: ${sparkAskRequest.title ?? "custom ask"}`,
        format: "json",
        body: { request, result } as unknown as JsonValue,
        provenance: { producer: "ask" },
      });
      const answer = result.answers.answer;
      return {
        content: [
          {
            type: "text",
            text: `Ask answered: ${answer?.values.join(", ") || answer?.customText || "no selection"} (${artifact.ref})`,
          },
        ],
        details: {
          request: request as unknown as Record<string, unknown>,
          result: result as unknown as Record<string, unknown>,
          artifactRef: artifact.ref,
        },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_ask_clarify_thread",
    label: "Spark Ask Clarify Thread",
    description: "Run the thread-clarification ask flow for a new or ambiguous Spark request.",
    parameters: Type.Object({
      idea: Type.String({ description: "The initial project intent or ambiguous request." }),
      title: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { idea: string; title?: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        clarifyThreadAsk({
          idea: p.idea,
          title: p.title,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_approve_agent",
    label: "Spark Ask Approve Agent",
    description: "Run the managed-agent approval ask flow.",
    parameters: Type.Object({
      id: Type.String(),
      description: Type.String(),
      systemPrompt: Type.String(),
      rationale: Type.String(),
      expectedUses: Type.Array(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        id: string;
        description: string;
        systemPrompt: string;
        rationale: string;
        expectedUses: string[];
        timeoutMs?: number;
      };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        approveManagedAgentAsk({
          proposal: {
            id: p.id,
            description: p.description,
            systemPrompt: p.systemPrompt,
            rationale: p.rationale,
            expectedUses: p.expectedUses,
          },
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_unblock_task",
    label: "Spark Ask Unblock Task",
    description: "Run the task-blocker resolution ask flow.",
    parameters: Type.Object({
      taskTitle: Type.String(),
      blocker: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { taskTitle: string; blocker: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        resolveTaskBlockerAsk({
          taskTitle: p.taskTitle,
          blocker: p.blocker,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_review_gate",
    label: "Spark Ask Review Gate",
    description: "Run the review-gate decision ask flow.",
    parameters: Type.Object({
      subject: Type.String(),
      summary: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { subject: string; summary: string; timeoutMs?: number };
      return runAndPersistSparkAskFlow(
        ctxCwd(ctx),
        reviewGateAsk({
          subject: p.subject,
          summary: p.summary,
          timeoutMs: p.timeoutMs,
        }),
        sparkAskUi(ctx),
      );
    },
  });

  pi.registerTool?.({
    name: "spark_ask_replay",
    label: "Spark Ask Replay",
    description:
      "Replay the latest Spark ask artifact, or a specified ask artifact, preserving prior answers where possible.",
    parameters: Type.Object({
      artifactRef: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const store = defaultArtifactStore(cwd);
      const artifactRef =
        typeof params.artifactRef === "string" ? (params.artifactRef as ArtifactRef) : undefined;
      const artifact = artifactRef
        ? await store.get(artifactRef)
        : (await store.list({ kind: "ask-answer" })).slice(-1)[0];
      if (!artifact) {
        return {
          content: [{ type: "text", text: "No replayable ask artifact found." }],
          details: { found: false },
        };
      }
      if (!isSparkAskArtifactBody(artifact.body)) {
        return {
          content: [
            {
              type: "text",
              text: `Artifact ${artifact.ref} is not a Spark ask artifact.`,
            },
          ],
          details: { found: true, replayable: false },
        };
      }
      const request = artifact.body.request;
      const prior = artifact.body.result;
      const result = await replaySparkAsk(request, prior, sparkAskUi(ctx));
      const replayArtifact = await store.put({
        kind: "ask-answer",
        title: `Replay ask: ${request.title ?? request.flow}`,
        format: "json",
        body: { request, result } as unknown as JsonValue,
        provenance: { producer: "ask", parentArtifactRefs: [artifact.ref] },
      });
      return {
        content: [{ type: "text", text: `Replayed ask saved to ${replayArtifact.ref}` }],
        details: {
          artifactRef: replayArtifact.ref,
          request: request,
          result: result,
        },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_list_agents",
    label: "Spark List Agents",
    description: "List builtin and managed agents available to Spark.",
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ description: "builtin | managed" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctxCwd(ctx);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const scope = typeof params.scope === "string" ? params.scope : undefined;
      const agents = registry.list().filter((agent) => !scope || agent.scope === scope);
      const lines = agents.map(
        (agent) => `- [${agent.scope}] ${agent.id} (${agent.ref}) — ${agent.description}`,
      );
      return {
        content: [
          {
            type: "text",
            text: lines.length ? lines.join("\n") : "No matching agents.",
          },
        ],
        details: { agents: agents as unknown as Record<string, unknown>[] },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_get_agent",
    label: "Spark Get Agent",
    description: "Inspect one builtin or managed agent spec.",
    parameters: Type.Object({
      agent: Type.String({ description: "agent id or full agent ref" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { agent: string };
      const cwd = ctxCwd(ctx);
      const registry = new AgentRegistry();
      await defaultManagedAgentStore(cwd).hydrate(registry);
      const agent = registry.select(p.agent);
      return {
        content: [
          {
            type: "text",
            text: [
              `${agent.id} (${agent.ref})`,
              `scope: ${agent.scope}`,
              `description: ${agent.description}`,
            ].join("\n"),
          },
        ],
        details: { agent: agent as unknown as Record<string, unknown> },
      };
    },
  });

  pi.registerTool?.({
    name: "spark_create_managed_agent",
    label: "Spark Create Managed Agent",
    description: "Create and persist a managed Spark agent from a validated proposal shape.",
    parameters: Type.Object({
      id: Type.String({ description: "stable managed agent id" }),
      description: Type.String({ description: "what this agent is for" }),
      systemPrompt: Type.String({
        description: "fixed system prompt for the managed agent",
      }),
      rationale: Type.String({
        description: "why this managed agent should exist",
      }),
      expectedUses: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as {
        id: string;
        description: string;
        systemPrompt: string;
        rationale: string;
        expectedUses: string[];
      };
      const cwd = ctxCwd(ctx);
      const proposal: ManagedAgentProposal = {
        id: p.id,
        description: p.description,
        systemPrompt: p.systemPrompt,
        rationale: p.rationale,
        expectedUses: p.expectedUses,
      };
      const artifactStore = defaultArtifactStore(cwd);
      const proposalArtifact = await artifactStore.put({
        kind: "agent-spec-proposal",
        title: `Managed agent proposal: ${proposal.id}`,
        format: "json",
        body: proposal as unknown as JsonValue,
        provenance: { producer: "agent" },
      });
      const spec = createManagedAgentSpec({
        ...proposal,
        artifactRef: proposalArtifact.ref,
      });
      await defaultManagedAgentStore(cwd).save(spec);
      return {
        content: [
          {
            type: "text",
            text: `Managed agent created: ${spec.id} (${spec.ref}) proposal=${proposalArtifact.ref}`,
          },
        ],
        details: {
          agent: spec as unknown as Record<string, unknown>,
          proposalArtifactRef: proposalArtifact.ref,
        },
      };
    },
  });
}

interface SparkInputEvent {
  text: string;
  source?: string;
}

interface SparkContextLike {
  cwd?: string;
}

async function handleSparkInput(
  event: unknown,
  ctx: unknown,
  pi?: Pick<SparkExtensionAPI, "sendUserMessage">,
): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  const cwd = ctxCwd(ctx);
  const activation = await detectSparkActivation(cwd);
  if (activation.active) return { action: "continue" };
  const intent = detectNaturalSparkIntent(text);
  if (intent === "new_idea") return { action: "transform", text: `/spark ${text}` };
  return { action: "continue" };
}

async function injectSparkHints(event: unknown, ctx: unknown): Promise<unknown> {
  const cwd = ctxCwd(ctx);
  const activation = await detectSparkActivation(cwd);
  if (!activation.active) return undefined;
  const contextSummary = await renderActiveSparkContextSummary(cwd);
  const sparkPrompt = renderSparkActiveSystemPrompt(eventSystemPrompt(event), activation.reason);
  return {
    systemPrompt: contextSummary ? `${sparkPrompt}\n\n${contextSummary}` : sparkPrompt,
  };
}

async function renderActiveSparkContextSummary(cwd: string): Promise<string | undefined> {
  const store = defaultTaskGraphStore(cwd);
  const graph = await store.load();
  if (!graph) return undefined;
  if (ensureSparkGraphInvariants(graph)) await store.save(graph);
  const thread = graph.threads()[0];
  if (!thread) return undefined;
  const current = graph.currentTask(thread.ref);
  const summary = graph.threadTodoSummary(thread.ref);
  if (summary.total === 0 && !current) return undefined;
  const activeTodo = current ? graph.todoSummary(current.ref).active : undefined;
  const lines = [
    "Spark current state:",
    `- Thread: ${thread.title} (${thread.ref})`,
    current ? `- Current task: ${current.title} (${current.ref})` : "- Current task: none",
    activeTodo ? `- Active TODO: ${activeTodo}` : undefined,
    `- TODOs: ${summary.total} total / ${summary.inProgress} in_progress / ${summary.pending} pending / ${summary.done} done`,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

async function detectSparkActivation(cwd: string): Promise<{ active: boolean; reason: string }> {
  if (await findUpExisting(cwd, "SPARK.md")) return { active: true, reason: "SPARK.md" };
  if (await findUpExisting(cwd, join(".spark", "thread.json")))
    return { active: true, reason: ".spark/thread.json" };
  if (await isWhitelistedByConfig(cwd))
    return { active: true, reason: "~/.config/spark/config.toml" };
  return { active: false, reason: "none" };
}

function detectNaturalSparkIntent(text: string): "new_idea" | "maybe_idea" | "normal_task" {
  const normalized = text.toLowerCase();
  if (
    /^(我想|我希望|我有个|帮我构建|帮我做|构建一个|做一个|create a|build a|i want to build|i have an idea)/i.test(
      text.trim(),
    )
  )
    return "new_idea";
  if (normalized.includes("idea") || text.includes("想法") || text.includes("新项目"))
    return "maybe_idea";
  return "normal_task";
}

async function isWhitelistedByConfig(cwd: string): Promise<boolean> {
  const configPath = join(homedir(), ".config", "spark", "config.toml");
  try {
    const config = await readFile(configPath, "utf8");
    if (/enabled\s*=\s*false/.test(config)) return false;
    const dirs = [...config.matchAll(/"([^"]+)"/g)].map((match) =>
      resolve(expandHome(match[1] ?? "")),
    );
    const resolved = resolve(cwd);
    return dirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}/`));
  } catch {
    return false;
  }
}

async function findUpExisting(cwd: string, relativePath: string): Promise<string | null> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, relativePath);
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (current === parent) return null;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function shouldMaterializeSparkMd(cwd: string): Promise<boolean> {
  return exists(join(cwd, ".git"));
}

function expandHome(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function isSparkInputEvent(event: unknown): event is SparkInputEvent {
  return Boolean(
    event && typeof event === "object" && typeof (event as { text?: unknown }).text === "string",
  );
}

function ctxCwd(ctx: unknown): string {
  return ctx && typeof ctx === "object" && typeof (ctx as SparkContextLike).cwd === "string"
    ? (ctx as { cwd: string }).cwd
    : process.cwd();
}

function sparkAskUi(ctx: unknown) {
  if (!ctx || typeof ctx !== "object") return undefined;
  const ui = (ctx as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return undefined;
  return {
    select:
      typeof (ui as { select?: unknown }).select === "function"
        ? (
            ui as {
              select: (title: string, options: string[]) => Promise<string | undefined>;
            }
          ).select
        : undefined,
    confirm:
      typeof (ui as { confirm?: unknown }).confirm === "function"
        ? (
            ui as {
              confirm: (title: string, message: string) => Promise<boolean>;
            }
          ).confirm
        : undefined,
    input:
      typeof (ui as { input?: unknown }).input === "function"
        ? (
            ui as {
              input: (title: string, defaultValue?: string) => Promise<string | undefined>;
            }
          ).input
        : undefined,
    notify:
      typeof (ui as { notify?: unknown }).notify === "function"
        ? (
            ui as {
              notify: (message: string, level?: "info" | "warning" | "error" | "success") => void;
            }
          ).notify
        : undefined,
  };
}

async function runAndPersistSparkAskFlow(
  cwd: string,
  request: Parameters<typeof createSparkAskRequest>[0],
  ui: ReturnType<typeof sparkAskUi>,
) {
  const normalizedRequest = createSparkAskRequest(request);
  const result = await runSparkAsk(normalizedRequest, ui);
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "ask-answer",
    title: `Spark ask: ${normalizedRequest.title ?? normalizedRequest.flow}`,
    format: "json",
    body: { request: normalizedRequest, result } as unknown as JsonValue,
    provenance: { producer: "ask" },
  });
  const preview = Object.entries(result.answers).map(
    ([id, answer]) => `${id}=${answer.values.join(",") || answer.customText || ""}`,
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `Spark ask ${result.mode}: ${preview.join("; ") || "no answers"} (${artifact.ref})`,
      },
    ],
    details: {
      request: normalizedRequest as unknown as Record<string, unknown>,
      result: result as unknown as Record<string, unknown>,
      artifactRef: artifact.ref,
    },
  };
}

function eventSystemPrompt(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
    ? (event as { systemPrompt: string }).systemPrompt
    : "";
}

export function renderSparkActiveSystemPrompt(basePrompt: string, reason: string): string {
  const sparkPrompt = [
    `Spark is active for the current workspace (${reason}).`,
    "The spark skill is loaded and available — read it with the read tool when Spark workflow guidance is needed.",
    "Use spark_status for thread state, spark_run_ready_tasks when the user asks to proceed, and pi-cue tools (run/jobs/status/kill/wait/cron/scopes/log) for command execution.",
    "Do not guess missing intent. If scope, output, or next action is ambiguous, ask the user to clarify before proceeding.",
    "After a clarification or decision answer is confirmed, continue with the selected action in the same turn when the next action is clear; do not stop just to ask for permission to proceed again.",
    "If the user points out a concrete Spark/pi-tool behavior change or defect in the current codebase, treat that as an implementation task unless they explicitly say it is only a preference/memory update.",
    "Do not satisfy such feedback by only storing memory or preferences; update the relevant code, docs, tests, or Spark state when appropriate.",
  ].join(" ");
  return basePrompt ? `${basePrompt}\n\n${sparkPrompt}` : sparkPrompt;
}

export interface SparkInitResult {
  cwd: string;
  idea: string;
  threadTitle: string;
  threadRef: string;
  taskCount: number;
  outputLanguage: SparkCopyLanguage;
  currentTaskRef?: string;
  currentTaskTitle?: string;
  todoSummary: {
    total: number;
    inProgress: number;
    pending: number;
    done: number;
    blocked: number;
    cancelled: number;
  };
  sparkMdPath?: string;
  sparkMdArtifactRef: string;
  agentPlanArtifactRef: string;
  traceRef: string;
  askArtifactRefs: ArtifactRef[];
}

export interface SparkInitClarificationData {
  workingTitle?: string;
  outputLanguage?: SparkCopyLanguage;
  objective?: string;
  targetUser?: string;
  smallestSlice?: string;
  successSignal?: string;
  nonGoals?: string;
  deliveryMode?: string;
  nextAction?: string;
}

interface SparkInitOptions {
  threadTitle?: string;
  outputLanguage?: SparkCopyLanguage;
  clarification?: SparkInitClarificationData;
  sparkMd?: string;
  askArtifactRefs?: ArtifactRef[];
  askRefs?: AskRef[];
}

interface SparkInitClarification {
  threadTitle: string;
  data: SparkInitClarificationData;
  askRef: AskRef;
  askArtifactRef: ArtifactRef;
}

async function maybeClarifySparkInit(
  cwd: string,
  idea: string,
  ui: ReturnType<typeof sparkAskUi>,
): Promise<SparkInitClarification | undefined> {
  if (!ui) return undefined;
  const defaultLanguage = detectCopyLanguage(idea);
  const request = clarifyThreadAsk({ idea, defaultLanguage });
  const result = await runSparkAsk(request, ui);
  const askRef = newRef("ask");
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "ask-answer",
    title: `Spark ask: ${request.title ?? request.flow}`,
    format: "json",
    body: { ref: askRef, request, result } as unknown as JsonValue,
    provenance: { producer: "ask" },
  });
  if (result.cancelled) return undefined;
  const threadTitle = normalizedFreeformAnswer(result.answers, "working-title");
  if (!threadTitle) return undefined;
  return {
    threadTitle: normalizeThreadTitle(threadTitle),
    data: {
      workingTitle: normalizeThreadTitle(threadTitle),
      outputLanguage:
        normalizeSparkCopyLanguage(normalizedAnswer(result.answers, "output-language")) ??
        defaultLanguage,
      objective: normalizedFreeformAnswer(result.answers, "objective"),
      targetUser: normalizedFreeformAnswer(result.answers, "target-user"),
      smallestSlice: normalizedFreeformAnswer(result.answers, "smallest-slice"),
      successSignal: normalizedFreeformAnswer(result.answers, "success-signal"),
      nonGoals: normalizedFreeformAnswer(result.answers, "non-goals"),
      deliveryMode: normalizedAnswer(result.answers, "delivery-mode"),
      nextAction: normalizedAnswer(result.answers, "next-action"),
    },
    askRef,
    askArtifactRef: artifact.ref,
  };
}

export async function initializeSparkIdea(
  cwd: string,
  idea: string,
  options: SparkInitOptions = {},
): Promise<SparkInitResult> {
  const sparkDir = join(cwd, ".spark");
  await mkdir(sparkDir, { recursive: true });

  const graph = new TaskGraph();
  const threadTitle =
    options.threadTitle ?? options.clarification?.workingTitle ?? titleFromIdea(idea);
  const thread = graph.createThread({
    title: threadTitle,
    description: options.clarification?.objective ?? idea,
    outputLanguage: options.outputLanguage ?? options.clarification?.outputLanguage,
  });

  graph.ensureContextTask(thread.ref, {
    title: "Maintain current interaction context",
    description: `Thread created from: ${truncateForDescription(idea, 200)}`,
    todos: [{ content: `Confirm scope and next action for: ${truncateForDescription(idea, 120)}` }],
  });

  const scout = graph.createTask({
    threadRef: thread.ref,
    title: "Capture project intent",
    description:
      "Draft SPARK.md from confirmed intent, explicitly preserving goals, non-goals, success signals, and unresolved questions.",
    kind: "research",
    agentRef: builtinAgentRef("scout"),
  });
  const planner = graph.createTask({
    threadRef: thread.ref,
    title: "Build initial task graph",
    description:
      "Turn the clarified SPARK.md into a small executable task DAG with explicit agent bindings and no guessed scope.",
    kind: "plan",
    agentRef: builtinAgentRef("planner"),
  });
  const reviewer = graph.createTask({
    threadRef: thread.ref,
    title: "Review initial direction",
    description:
      "Verify that the task graph follows the confirmed intent and avoids premature implementation or missing clarification.",
    kind: "review",
    agentRef: builtinAgentRef("reviewer"),
  });
  graph.addDependency(planner.ref, scout.ref);
  graph.addDependency(reviewer.ref, planner.ref);

  const store = defaultArtifactStore(cwd);
  const sparkMd =
    options.sparkMd ??
    renderSparkMd({ idea, workingTitle: threadTitle, clarification: options.clarification });
  const sparkMdArtifact = await store.put({
    kind: "spark-md",
    title: "SPARK.md draft",
    format: "markdown",
    body: sparkMd,
    provenance: { producer: "spark", threadRef: thread.ref },
  });
  const sparkMdPath = (await shouldMaterializeSparkMd(cwd)) ? join(cwd, "SPARK.md") : undefined;
  if (sparkMdPath) await writeFile(sparkMdPath, sparkMd, "utf8");

  const agentPlan = renderAgentPlan({ idea, tasks: graph.tasks(thread.ref) });
  const agentPlanArtifact = await store.put({
    kind: "agent-plan",
    title: "Initial agent plan",
    format: "markdown",
    body: agentPlan,
    provenance: {
      producer: "spark",
      threadRef: thread.ref,
      parentArtifactRefs: [sparkMdArtifact.ref],
    },
  });

  const gate = createReviewGate({
    subject: agentPlanArtifact.ref,
    lens: "artifact",
    policy: "required",
    outcome: "blocked",
    summary: "Initial Spark flow created a review gate; reviewer execution is pending.",
  });

  const trace: SparkRunTrace = {
    ref: newRef("spark"),
    idea,
    threadRef: thread.ref,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    taskRefs: graph.tasks(thread.ref).map((task) => task.ref),
    reviewRefs: [gate.ref],
    askRefs: options.askRefs ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await store.put({
    kind: "run-trace",
    title: "Spark run trace",
    format: "json",
    body: trace as unknown as JsonValue,
    provenance: {
      producer: "spark",
      threadRef: thread.ref,
      parentArtifactRefs: [sparkMdArtifact.ref, agentPlanArtifact.ref],
    },
  });
  await defaultTaskGraphStore(cwd).save(graph);
  await writeFile(join(sparkDir, "review-gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");

  const currentTask = graph.currentTask(thread.ref);
  const todoSummary = graph.threadTodoSummary(thread.ref);
  return {
    cwd,
    idea,
    threadTitle,
    threadRef: thread.ref,
    taskCount: graph.tasks(thread.ref).length,
    outputLanguage: options.clarification?.outputLanguage ?? detectCopyLanguage(idea),
    currentTaskRef: currentTask?.ref,
    currentTaskTitle: currentTask?.title,
    todoSummary: {
      total: todoSummary.total,
      inProgress: todoSummary.inProgress,
      pending: todoSummary.pending,
      done: todoSummary.done,
      blocked: todoSummary.blocked,
      cancelled: todoSummary.cancelled,
    },
    sparkMdPath,
    sparkMdArtifactRef: sparkMdArtifact.ref,
    agentPlanArtifactRef: agentPlanArtifact.ref,
    traceRef: trace.ref,
    askArtifactRefs: options.askArtifactRefs ?? [],
  };
}

function renderSparkInitSummary(result: SparkInitResult): string {
  if (result.outputLanguage === "zh") {
    const lines = [
      "Spark 已初始化：",
      `- 想法：${result.idea}`,
      `- 线程标题：${result.threadTitle}`,
      result.sparkMdPath
        ? `- SPARK.md：${result.sparkMdPath}`
        : "- SPARK.md：未物化（当前 cwd 没有 .git）",
      `- Thread：${result.threadRef}`,
      `- Tasks：${result.taskCount}`,
      result.currentTaskTitle
        ? `- 当前 task：${result.currentTaskTitle} (${result.currentTaskRef})`
        : "- 当前 task：无",
      `- TODO：${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
      `- SPARK artifact：${result.sparkMdArtifactRef}`,
      `- Agent plan artifact：${result.agentPlanArtifactRef}`,
      `- Trace：${result.traceRef}`,
    ];
    for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask：${askRef}`);
    return lines.join("\n");
  }

  const lines = [
    "Spark initialized:",
    `- Idea: ${result.idea}`,
    `- Thread title: ${result.threadTitle}`,
    result.sparkMdPath
      ? `- SPARK.md: ${result.sparkMdPath}`
      : "- SPARK.md: not materialized (cwd has no .git)",
    `- Thread: ${result.threadRef}`,
    `- Tasks: ${result.taskCount}`,
    result.currentTaskTitle
      ? `- Current task: ${result.currentTaskTitle} (${result.currentTaskRef})`
      : "- Current task: none",
    `- TODOs: ${result.todoSummary.total} total / ${result.todoSummary.inProgress} in_progress / ${result.todoSummary.pending} pending / ${result.todoSummary.done} done`,
    `- SPARK artifact: ${result.sparkMdArtifactRef}`,
    `- Agent plan artifact: ${result.agentPlanArtifactRef}`,
    `- Trace: ${result.traceRef}`,
  ];
  for (const askRef of result.askArtifactRefs) lines.push(`- Clarification ask: ${askRef}`);
  return lines.join("\n");
}

function titleFromIdea(idea: string): string {
  const firstLine = idea.split(/\r?\n/, 1)[0]?.trim() ?? "Spark thread";
  return normalizeThreadTitle(firstLine);
}

function normalizeThreadTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim() || "Spark thread";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}

function normalizedAnswer(
  answers: Record<string, { values: string[]; customText?: string }>,
  questionId: string,
): string | undefined {
  const answer = answers[questionId];
  if (!answer) return undefined;
  const value = answer.customText ?? answer.values[0];
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizedFreeformAnswer(
  answers: Record<string, { values: string[]; customText?: string }>,
  questionId: string,
): string | undefined {
  return normalizedAnswer(answers, questionId);
}

function normalizeSparkCopyLanguage(value?: string): SparkCopyLanguage | undefined {
  return value === "zh" || value === "en" ? value : undefined;
}

function mapDeliveryChoice(choice: string, language: SparkCopyLanguage): string {
  const zhMap: Record<string, string> = {
    只做规划: "clarify_only",
    "规划 + 文档": "document",
    "规划 + 文档 + 实现": "document_and_execute",
    直接实现: "execute",
  };
  const enMap: Record<string, string> = {
    "Plan only": "clarify_only",
    "Plan + document": "document",
    "Plan + document + implement": "document_and_execute",
    "Implement directly": "execute",
  };
  return (language === "zh" ? zhMap[choice] : enMap[choice]) ?? "document_and_execute";
}

function renderSparkMd(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const language = input.clarification?.outputLanguage ?? detectCopyLanguage(input.idea);
  return language === "zh" ? renderSparkMdZh(input) : renderSparkMdEn(input);
}

function renderSparkMdEn(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryEn(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## Origin");
  sections.push("");
  sections.push(shortSummaryEn(input.idea));
  sections.push("");
  sections.push("## Working title");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## Delivery mode");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "en")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## Target users");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## Objective");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## Smallest slice");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## Success signal");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## Non-goals");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## Open questions");
  sections.push("");
  sections.push(
    "- Does the current interaction task reflect the latest confirmed intent?<!-- dynamically maintained -->",
  );
  sections.push(
    "- Is the next concrete action specific enough to execute?<!-- dynamically maintained -->",
  );
  sections.push("");
  sections.push("## Revision history");
  sections.push("");
  sections.push(`- ${date}: Generated by /spark.`);
  return `${sections.join("\n")}\n`;
}

function renderSparkMdZh(input: {
  idea: string;
  workingTitle?: string;
  clarification?: SparkInitClarificationData;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const title =
    input.workingTitle ?? input.clarification?.workingTitle ?? shortSummaryZh(input.idea);
  const sections: string[] = [];

  sections.push(`---
description: ${escapeYamlLine(title)}
owner: zrr1999
created: ${date}
updated: ${date}
inspired_by: []
---`);
  sections.push("");
  sections.push("## 起源");
  sections.push("");
  sections.push(shortSummaryZh(input.idea));
  sections.push("");
  sections.push("## 当前工作标题");
  sections.push("");
  sections.push(`- ${title}`);

  if (input.clarification?.deliveryMode) {
    sections.push("");
    sections.push("## 交付方式");
    sections.push("");
    sections.push(`- ${describeDeliveryMode(input.clarification.deliveryMode, "zh")}`);
  }
  if (input.clarification?.targetUser) {
    sections.push("");
    sections.push("## 目标用户");
    sections.push("");
    sections.push(`- ${input.clarification.targetUser}`);
  }
  if (input.clarification?.objective) {
    sections.push("");
    sections.push("## 目标");
    sections.push("");
    sections.push(`- ${input.clarification.objective}`);
  }
  if (input.clarification?.smallestSlice) {
    sections.push("");
    sections.push("## 最小切片");
    sections.push("");
    sections.push(`- ${input.clarification.smallestSlice}`);
  }
  if (input.clarification?.successSignal) {
    sections.push("");
    sections.push("## 成功信号");
    sections.push("");
    sections.push(`- ${input.clarification.successSignal}`);
  }
  if (input.clarification?.nonGoals) {
    sections.push("");
    sections.push("## 非目标");
    sections.push("");
    sections.push(`- ${input.clarification.nonGoals}`);
  }

  sections.push("");
  sections.push("## 开放问题");
  sections.push("");
  sections.push("- 当前交互 task 是否准确反映了最新确认的意图？<!-- 动态维护 -->");
  sections.push("- 下一个具体动作是否已经明确到可执行？<!-- 动态维护 -->");
  sections.push("");
  sections.push("## 修订记录");
  sections.push("");
  sections.push(`- ${date}：由 /spark 生成。`);
  return `${sections.join("\n")}\n`;
}

function shortSummaryEn(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function shortSummaryZh(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function renderAgentPlan(input: {
  idea: string;
  tasks: Array<{
    title: string;
    description: string;
    kind?: string;
    agentRef?: string;
    todos?: Array<{ content: string; status: string }>;
  }>;
}): string {
  const lines = ["# Initial Agent Plan", "", `Idea: ${input.idea}`, "", "## Tasks", ""];
  for (const task of input.tasks) {
    lines.push(`- **${task.title}**`);
    lines.push(`  - Kind: ${task.kind ?? "generic"}`);
    lines.push(`  - Agent: ${task.agentRef ?? "unbound"}`);
    lines.push(`  - Instruction: ${task.description}`);
    if (task.todos && task.todos.length > 0) {
      lines.push("  - TODOs:");
      for (const todo of task.todos) {
        lines.push(`    - [${todo.status}] ${todo.content}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function describeDeliveryMode(value: string | undefined, language: SparkCopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "clarify_only":
        return "只澄清意图，不继续扩展交付。";
      case "document":
        return "澄清并写入文档。";
      case "document_and_execute":
        return "澄清、写入文档并继续执行。";
      case "execute":
        return "直接进入执行。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "clarify_only":
      return "Clarification only.";
    case "document":
      return "Clarification and documentation.";
    case "document_and_execute":
      return "Clarification, documentation, and continued execution.";
    case "execute":
      return "Proceed directly to execution.";
    default:
      return "To be confirmed.";
  }
}

function describeNextAction(value: string | undefined, language: SparkCopyLanguage): string {
  if (language === "zh") {
    switch (value) {
      case "stop_after_summary":
        return "输出澄清摘要后停止。";
      case "update_docs":
        return "更新 Spark 文档。";
      case "continue_tasking":
        return "继续任务规划和执行。";
      default:
        return "待确认。";
    }
  }
  switch (value) {
    case "stop_after_summary":
      return "Stop after a clarified summary.";
    case "update_docs":
      return "Update Spark documentation.";
    case "continue_tasking":
      return "Continue with task planning and execution.";
    default:
      return "To be confirmed.";
  }
}

function ensureSparkGraphInvariants(graph: TaskGraph): boolean {
  let changed = false;
  for (const thread of graph.threads()) {
    const current = graph.currentTask(thread.ref);
    if (!current) {
      graph.ensureContextTask(thread.ref);
      changed = true;
    } else if (graph.getThread(thread.ref).currentTaskRef !== current.ref) {
      graph.setCurrentTask(thread.ref, current.ref);
      changed = true;
    }
  }
  return changed;
}

function truncateForDescription(text: string, max: number): string {
  const line = text.trim().split(/\r?\n/)[0] ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function escapeYamlLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 160 ? `${line.slice(0, 157)}...` : line);
}
