import {
  runWorkflowScript,
  type WorkflowAgentRunner,
  type WorkflowFetchContentInput,
  type WorkflowJournalEntry,
  type WorkflowRunEvent,
  type WorkflowRunResult,
  type WorkflowRunSnapshot,
  type WorkflowWebSearchInput,
  type WorkflowArtifactRecordInput,
} from "@zendev-lab/pi-workflows";
import type { SparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import type {
  SparkDynamicWorkflowRunOptions,
  SparkDynamicWorkflowRunRecord,
} from "./spark-dynamic-workflow-run-store.ts";

export type SparkDynamicWorkflowRunWorkflow = typeof runWorkflowScript;

export interface SparkDynamicWorkflowLiveUpdate {
  runRef: string;
  event?: WorkflowRunEvent;
  snapshot?: WorkflowRunSnapshot;
  run?: SparkDynamicWorkflowRunRecord;
}

export type SparkDynamicWorkflowLiveUpdateListener = (
  update: SparkDynamicWorkflowLiveUpdate,
) => void | Promise<void>;

export interface SparkDynamicWorkflowManagerRunInput {
  store: SparkDynamicWorkflowEventStore;
  run: SparkDynamicWorkflowRunRecord;
  abortController?: AbortController;
  script: string;
  args?: unknown;
  options: SparkDynamicWorkflowRunOptions;
  resumeJournal?: WorkflowJournalEntry[];
  agent: WorkflowAgentRunner;
  runWorkflow?: SparkDynamicWorkflowRunWorkflow;
  artifactRecord?: (
    record: WorkflowArtifactRecordInput,
  ) => Promise<{ ref: string }> | { ref: string };
  webSearch?: (request: WorkflowWebSearchInput) => unknown;
  fetchContent?: (request: WorkflowFetchContentInput) => unknown;
  loadWorkflowScript?: (selector: string) => string | undefined | Promise<string | undefined>;
  restartInput?: (input: {
    abortController: AbortController;
    run: SparkDynamicWorkflowRunRecord;
  }) => Promise<SparkDynamicWorkflowManagerRunInput> | SparkDynamicWorkflowManagerRunInput;
  onLiveUpdate?: SparkDynamicWorkflowLiveUpdateListener;
}

export type SparkDynamicWorkflowManagerCompletion =
  | {
      status: "succeeded";
      runRef: string;
      result: WorkflowRunResult;
      run?: SparkDynamicWorkflowRunRecord;
    }
  | {
      status: "failed";
      runRef: string;
      error: unknown;
      run?: SparkDynamicWorkflowRunRecord;
    };

export interface SparkDynamicWorkflowManagerHandle {
  runRef: string;
  completion: Promise<SparkDynamicWorkflowManagerCompletion>;
}

interface SparkDynamicWorkflowControlState {
  abortController: AbortController;
  input?: SparkDynamicWorkflowManagerRunInput;
  paused: boolean;
  stopped: boolean;
  resumeWaiters: Array<() => void>;
}

export class SparkDynamicWorkflowManager {
  private readonly active = new Map<string, Promise<SparkDynamicWorkflowManagerCompletion>>();
  private readonly controls = new Map<string, SparkDynamicWorkflowControlState>();
  private readonly subscribers = new Map<string, Set<SparkDynamicWorkflowLiveUpdateListener>>();

  subscribe(runRef: string, listener: SparkDynamicWorkflowLiveUpdateListener): () => void {
    const listeners =
      this.subscribers.get(runRef) ?? new Set<SparkDynamicWorkflowLiveUpdateListener>();
    listeners.add(listener);
    this.subscribers.set(runRef, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(runRef);
    };
  }

  start(input: SparkDynamicWorkflowManagerRunInput): SparkDynamicWorkflowManagerHandle {
    const existing = this.active.get(input.run.ref);
    if (existing) return { runRef: input.run.ref, completion: existing };
    const control = this.controlFor(input.run.ref, input.abortController);
    control.input = input;
    control.stopped = false;
    const completion = this.execute(input).finally(() => this.active.delete(input.run.ref));
    this.active.set(input.run.ref, completion);
    return { runRef: input.run.ref, completion };
  }

  isActive(runRef: string): boolean {
    return this.active.has(runRef);
  }

  wait(runRef: string): Promise<SparkDynamicWorkflowManagerCompletion> | undefined {
    return this.active.get(runRef);
  }

  async pause(
    store: SparkDynamicWorkflowEventStore,
    runRef: string,
    reason = "paused by workflow control",
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    const control = this.controlFor(runRef);
    control.paused = true;
    const run = await store.pause(runRef as SparkDynamicWorkflowRunRecord["ref"], reason);
    await store.appendEvent(runRef as SparkDynamicWorkflowRunRecord["ref"], {
      type: "control_applied",
      nodeId: "run",
      nodeKind: "run",
      message: reason,
      data: { action: "pause" },
    });
    return run;
  }

  async resume(
    store: SparkDynamicWorkflowEventStore,
    runRef: string,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    const control = this.controlFor(runRef);
    control.paused = false;
    const waiters = control.resumeWaiters.splice(0);
    for (const resolve of waiters) resolve();
    const run = await store.resume(runRef as SparkDynamicWorkflowRunRecord["ref"]);
    await store.appendEvent(runRef as SparkDynamicWorkflowRunRecord["ref"], {
      type: "control_applied",
      nodeId: "run",
      nodeKind: "run",
      data: { action: "resume" },
    });
    return run;
  }

  async stop(
    store: SparkDynamicWorkflowEventStore,
    runRef: string,
    reason = "stopped by workflow control",
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    const control = this.controlFor(runRef);
    control.stopped = true;
    control.paused = false;
    const waiters = control.resumeWaiters.splice(0);
    for (const resolve of waiters) resolve();
    control.abortController.abort(new Error(reason));
    const run = await store.stop(runRef as SparkDynamicWorkflowRunRecord["ref"], reason);
    await store.appendEvent(runRef as SparkDynamicWorkflowRunRecord["ref"], {
      type: "control_applied",
      nodeId: "run",
      nodeKind: "run",
      message: reason,
      data: { action: "stop" },
    });
    return run;
  }

  async restart(
    store: SparkDynamicWorkflowEventStore,
    runRef: string,
  ): Promise<SparkDynamicWorkflowRunRecord | undefined> {
    const control = this.controls.get(runRef);
    const previousInput = control?.input;
    const active = this.active.get(runRef);
    if (control) {
      control.stopped = true;
      control.paused = false;
      for (const resolve of control.resumeWaiters.splice(0)) resolve();
      control.abortController.abort(new Error("restarted by workflow control"));
    }
    if (active) await active;
    const restarted = await store.restart(runRef as SparkDynamicWorkflowRunRecord["ref"]);
    await store.appendEvent(runRef as SparkDynamicWorkflowRunRecord["ref"], {
      type: "control_applied",
      nodeId: "run",
      nodeKind: "run",
      data: { action: "restart" },
    });
    if (previousInput && restarted) {
      const abortController = new AbortController();
      const restartInput = previousInput.restartInput
        ? await previousInput.restartInput({ abortController, run: restarted })
        : { ...previousInput, run: restarted, resumeJournal: [], abortController };
      this.start(restartInput);
    }
    return restarted;
  }

  private async execute(
    input: SparkDynamicWorkflowManagerRunInput,
  ): Promise<SparkDynamicWorkflowManagerCompletion> {
    const runWorkflow = input.runWorkflow ?? runWorkflowScript;
    const artifactRecord = input.artifactRecord;
    const webSearch = input.webSearch;
    const fetchContent = input.fetchContent;
    const loadWorkflowScript = input.loadWorkflowScript;
    try {
      const result = await runWorkflow(input.script, {
        args: input.args,
        agent: async (prompt, options) => {
          await this.checkpoint(input.run.ref);
          const result = await input.agent(prompt, options);
          await this.checkpoint(input.run.ref);
          return result;
        },
        concurrency: input.options.concurrency,
        maxAgents: input.options.maxAgents,
        tokenBudget: input.options.tokenBudget,
        resumeJournal: new Map(
          (input.resumeJournal ?? input.run.journal).map((entry) => [entry.index, entry]),
        ),
        artifactRecord: artifactRecord
          ? async (record) => {
              await this.checkpoint(input.run.ref);
              return artifactRecord(record);
            }
          : undefined,
        webSearch: webSearch
          ? async (request) => {
              await this.checkpoint(input.run.ref);
              return webSearch(request);
            }
          : undefined,
        fetchContent: fetchContent
          ? async (request) => {
              await this.checkpoint(input.run.ref);
              return fetchContent(request);
            }
          : undefined,
        loadWorkflowScript: loadWorkflowScript
          ? async (selector) => {
              await this.checkpoint(input.run.ref);
              return loadWorkflowScript(selector);
            }
          : undefined,
        onEvent: async (event) => {
          if (event.type === "run_started") return;
          if (this.controls.get(input.run.ref)?.stopped) return;
          const { id: _id, sequence: _sequence, ...eventInput } = event;
          const snapshot = await input.store.appendEvent(input.run.ref, eventInput);
          await this.notify(input, { event, snapshot });
        },
        onTokenUsage: async (usage) => {
          await input.store.recordTokenUsage(input.run.ref, usage.spent, usage.usage);
          await this.notify(input, {});
        },
        onAgentTelemetry: async (telemetry) => {
          await input.store.recordAgentTelemetry(input.run.ref, telemetry);
          await this.notify(input, {});
        },
      });
      const run = await input.store.finish(input.run.ref, result);
      await this.notify(input, { run });
      return { status: "succeeded", runRef: input.run.ref, result, run };
    } catch (error) {
      if (this.controls.get(input.run.ref)?.stopped) {
        return {
          status: "failed",
          runRef: input.run.ref,
          error,
          run: await input.store.get(input.run.ref),
        };
      }
      const run = await input.store.fail(input.run.ref, error);
      await this.notify(input, { run });
      return { status: "failed", runRef: input.run.ref, error, run };
    }
  }

  private async notify(
    input: SparkDynamicWorkflowManagerRunInput,
    update: Omit<SparkDynamicWorkflowLiveUpdate, "runRef">,
  ): Promise<void> {
    const run = update.run ?? (await input.store.get(input.run.ref));
    const next: SparkDynamicWorkflowLiveUpdate = {
      runRef: input.run.ref,
      ...update,
      ...(run ? { run } : {}),
    };
    await input.onLiveUpdate?.(next);
    const listeners = this.subscribers.get(input.run.ref);
    if (!listeners) return;
    await Promise.all([...listeners].map((listener) => Promise.resolve(listener(next))));
  }

  private async checkpoint(runRef: string): Promise<void> {
    const control = this.controlFor(runRef);
    if (control.stopped || control.abortController.signal.aborted) {
      throw new Error(`dynamic workflow run stopped: ${runRef}`);
    }
    while (control.paused) {
      await new Promise<void>((resolve) => control.resumeWaiters.push(resolve));
      if (control.stopped || control.abortController.signal.aborted) {
        throw new Error(`dynamic workflow run stopped: ${runRef}`);
      }
    }
  }

  private controlFor(
    runRef: string,
    abortController?: AbortController,
  ): SparkDynamicWorkflowControlState {
    const existing = this.controls.get(runRef);
    if (existing) {
      if (abortController && existing.abortController.signal.aborted) {
        existing.abortController = abortController;
      }
      return existing;
    }
    const control: SparkDynamicWorkflowControlState = {
      abortController: abortController ?? new AbortController(),
      paused: false,
      stopped: false,
      resumeWaiters: [],
    };
    this.controls.set(runRef, control);
    return control;
  }
}

const defaultManager = new SparkDynamicWorkflowManager();

export function defaultSparkDynamicWorkflowManager(): SparkDynamicWorkflowManager {
  return defaultManager;
}
