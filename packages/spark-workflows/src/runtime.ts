import { createHash } from "node:crypto";
import vm from "node:vm";
import { parseSparkWorkflowScript } from "./metadata.ts";
import type {
  SparkWorkflowAgentOptions,
  SparkWorkflowJournalEntry,
  SparkWorkflowRunOptions,
  SparkWorkflowRunResult,
} from "./types.ts";

export function sparkWorkflowCallHash(input: {
  prompt: string;
  phase?: string;
  options?: SparkWorkflowAgentOptions;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ prompt: input.prompt, phase: input.phase, options: input.options ?? {} }),
    )
    .digest("hex");
}

export async function runSparkWorkflowScript<T = unknown>(
  script: string,
  options: SparkWorkflowRunOptions,
): Promise<SparkWorkflowRunResult<T>> {
  const parsed = parseSparkWorkflowScript(script);
  const phases: string[] = [];
  const journal: SparkWorkflowJournalEntry[] = [];
  const resume = options.resumeJournal ?? new Map<number, SparkWorkflowJournalEntry>();
  const maxAgents = options.maxAgents ?? 1000;
  let currentPhase: string | undefined;
  const phaseModelByTitle = new Map(
    (parsed.meta.phases ?? [])
      .filter((phase) => phase.model)
      .map((phase) => [phase.title, phase.model as string]),
  );
  let callIndex = 0;

  const phase = (title: string) => {
    currentPhase = String(title);
    if (!phases.includes(currentPhase)) phases.push(currentPhase);
    options.onPhase?.(currentPhase);
  };

  const agent = async (prompt: string, agentOptions: SparkWorkflowAgentOptions = {}) => {
    const normalizedAgentOptions = normalizeSparkWorkflowAgentOptions(agentOptions);
    if (callIndex >= maxAgents) throw new Error("Spark workflow agent limit exceeded");
    const index = callIndex++;
    const phaseName = normalizedAgentOptions.phase ?? currentPhase;
    const effectiveAgentOptions = applySparkWorkflowPhaseModel(
      normalizedAgentOptions,
      phaseName ? phaseModelByTitle.get(phaseName) : undefined,
    );
    const hash = sparkWorkflowCallHash({
      prompt,
      phase: phaseName,
      options: effectiveAgentOptions,
    });
    const cached = resume.get(index);
    if (cached?.hash === hash) {
      journal.push(cached);
      return cached.result;
    }
    const event = {
      index,
      label: effectiveAgentOptions.label ?? "agent " + (index + 1),
      phase: phaseName,
      prompt,
      model: effectiveAgentOptions.model,
    };
    options.onAgentStart?.(event);
    const result = await options.agent(prompt, {
      ...effectiveAgentOptions,
      index,
      phase: phaseName,
    });
    const entry = { index, hash, result };
    journal.push(entry);
    options.onAgentJournal?.(entry);
    options.onAgentEnd?.({ ...event, result });
    return result;
  };

  const parallel = async <T>(items: Array<() => Promise<T> | T>): Promise<T[]> =>
    Promise.all(items.map((item) => item()));
  const pipeline = async <T>(
    steps: Array<(value: unknown) => Promise<unknown>>,
    initial?: T,
  ): Promise<unknown> => {
    let value: unknown = initial;
    for (const step of steps) value = await step(value);
    return value;
  };

  const wrapped = "(async () => {\n" + parsed.body + "\n})()";
  const context = vm.createContext({
    args: options.args,
    agent,
    parallel,
    pipeline,
    phase,
    console,
  });
  const result = (await new vm.Script(wrapped).runInContext(context, { timeout: 1000 })) as T;
  return { meta: parsed.meta, result, phases, agentCount: callIndex, journal };
}

export function normalizeSparkWorkflowAgentOptions(
  options: SparkWorkflowAgentOptions,
): SparkWorkflowAgentOptions {
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw new Error("Spark workflow agent isolation must be 'worktree' when provided");
  }
  return options;
}

export function applySparkWorkflowPhaseModel(
  options: SparkWorkflowAgentOptions,
  phaseModel: string | undefined,
): SparkWorkflowAgentOptions {
  if (options.model || !phaseModel) return options;
  return { ...options, model: phaseModel };
}
