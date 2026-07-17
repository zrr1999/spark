/**
 * One-shot writer: persist Compact V2 plan tasks into Ultra Smart Compact.
 * Run: pnpm exec node --experimental-strip-types scripts/write-compact-v2-plan.ts
 */
import { resolve } from "node:path";
import {
  decideTaskPlanBeforeCreate,
  defaultTaskGraphStore,
  type TaskPlanInput,
} from "@zendev-lab/spark-tasks";

const PROJECT_REF = "proj:55128918-a00f-41e6-a2cd-de47999e9594" as const;
const cwd = resolve(import.meta.dirname, "..");

function readyPlan(input: {
  objective: string;
  successCriteria: string[];
  evidenceRequired: string[];
  items: string[];
  contextRefs?: string[];
  constraints?: string[];
  nonGoals?: string[];
}): NonNullable<TaskPlanInput["plan"]> {
  return {
    objective: input.objective,
    contextRefs: input.contextRefs ?? [
      "docs/specs/turn.md",
      "apps/spark-tui/src/host/compaction.ts",
    ],
    constraints: input.constraints ?? [
      "Do not lower the compression quality bar with smoke-only or best-effort wording.",
      "Preserve tool-call/result protocol pairing and exact/verbatim tool results.",
    ],
    nonGoals: input.nonGoals ?? [
      "Do not rewrite unrelated session UI.",
      "Do not introduce pass-count or round-number micro-compression state.",
    ],
    successCriteria: input.successCriteria,
    evidenceRequired: input.evidenceRequired,
    steps: input.items,
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

const tasks: TaskPlanInput[] = [
  {
    name: "compact-v2-contract",
    title: "Define Compact V2 config and persistence contract",
    description:
      "Add typed Compact V2 configuration and durable metadata fields for micro/full thresholds, targetReduction default 0.4, minUsefulReduction, configurable compact model, summary version, token source, fallback reason, and measured reduction ratio.",
    kind: "implement",
    dependsOn: [],
    rationale:
      "Contract and types must land before micro/full/memory implementations share one schema.",
    plan: readyPlan({
      objective:
        "Ship a typed Compact V2 contract so micro and full compaction share one config surface and persist summaryVersion, tokenSource, fallbackReason, and measuredReductionRatio on every compact outcome.",
      contextRefs: [
        "docs/specs/turn.md",
        "apps/spark-tui/src/host/compaction.ts",
        "packages/spark-host/src/types.ts",
      ],
      successCriteria: [
        "`pnpm run check:tsc` reports exit code 0 for packages exporting Compact V2 config/metadata types.",
        "Unit tests assert targetReduction defaults to 0.4 and compact model defaults to the active session model when unset, with suite exit code 0.",
        "Schema/unit tests validate persisted compact metadata includes summaryVersion, tokenSource (reported|tokenizer|estimated), fallbackReason, and measuredReductionRatio.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 covering targetReduction=0.4 defaults and metadata field assertions.",
        "git diff or changed-file list naming the new/updated Compact V2 contract type files under packages/spark-* or apps/spark-tui.",
      ],
      items: [
        "Inspect current compact options and session_before_compact / session_compact event payloads in apps/spark-tui and related packages.",
        "Implement Compact V2 config types for microThreshold, fullThreshold, targetReduction, minUsefulReduction, and compactModel.",
        "Add durable compact outcome metadata fields and serialization helpers for summaryVersion/tokenSource/fallbackReason/measuredReductionRatio.",
        "Add unit tests for defaults and metadata round-trip, then run package typecheck with pnpm run check:tsc.",
      ],
    }),
  },
  {
    name: "compact-token-metering",
    title: "Implement three-tier token metering with source labels",
    description:
      "Prefer latest trusted provider usage, then model tokenizer, then chars/4 estimate; expose tokenSource so UI never presents estimates as exact counts.",
    kind: "implement",
    dependsOn: ["compact-v2-contract"],
    rationale:
      "Micro and full compaction decisions depend on a single trusted token accounting path.",
    plan: readyPlan({
      objective:
        "Deliver a shared token meter that selects reported provider usage first, tokenizer counts second, and chars/4 last, and always returns an explicit tokenSource label for UI and metadata.",
      successCriteria: [
        "Unit tests cover Chinese text, source code, and JSON fixtures and assert the chosen tokenSource for each metering path with exit code 0.",
        "Provider-usage fixture test asserts measured tokens equal the reported usage and tokenSource equals reported, with exit code 0.",
        "Compact feedback/status rendering tests assert estimated values include a tokenSource=estimated label rather than bare exact counts, with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 for Chinese/code/JSON metering fixtures.",
        "git diff or test artifact showing tokenSource labeled for estimated compact feedback/status output.",
      ],
      items: [
        "Inspect existing token/usage helpers used by compact and session status rendering.",
        "Implement provider → tokenizer → chars/4 fallback order with explicit tokenSource return values.",
        "Add fixtures for Chinese, code, and JSON inputs covering each metering fallback path.",
        "Update compact metadata and compact feedback UI strings to render tokenSource labels.",
      ],
    }),
  },
  {
    name: "compact-isomorphic-micro",
    title: "Implement isomorphic model-free micro-compaction at 40% target",
    description:
      "When micro threshold is crossed, run exactly one isomorphic micro-compaction pass with targetReduction 0.4, no model calls, no pass-count state; re-run the same algorithm on later crossings.",
    kind: "implement",
    dependsOn: ["compact-v2-contract", "compact-token-metering"],
    rationale: "Micro-compaction is the default pressure relief path and must stay deterministic.",
    plan: readyPlan({
      objective:
        "Implement isomorphic micro-compaction that runs once per threshold crossing, targets 40% reduction, never calls a model, and never stores pass/round counters while protecting exact/verbatim tool results.",
      constraints: [
        "Micro-compaction must be fully model-free.",
        "Crossing the same micro threshold again re-runs the identical algorithm with no pass-count state.",
        "Reuse existing tool-result-compaction rules for exact/verbatim protection.",
      ],
      successCriteria: [
        "Tests prove two sequential threshold crossings each invoke one micro pass and leave no durable pass-count or round-number state, with suite exit code 0.",
        "With enough compressible candidates, measuredReductionRatio is at least 0.4 or the run records minUsefulReduction abort with explicit metadata, asserted by tests with exit code 0.",
        "Exact/verbatim tool results remain unchanged after micro-compaction in dedicated fixture tests with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 covering repeated isomorphic triggers, 40% target, low-yield abort, and exact tool protection.",
        "git diff listing micro-compaction implementation files and tool-result-compaction reuse sites.",
      ],
      items: [
        "Implement priority scoring from failure state, length, context distance, recoverability, and tool type.",
        "Wire single-pass micro trigger on threshold crossing with isomorphic re-entry and no pass-count state.",
        "Update minUsefulReduction abort path to record measuredReductionRatio metadata.",
        "Add regression tests for repeated triggers, 40% target, and exact/verbatim protection.",
      ],
    }),
  },
  {
    name: "compact-artifact-recovery",
    title: "Offload long recoverable tool results to Artifacts",
    description:
      "For oversized recoverable tool results, store original text as an Artifact and keep only status, key conclusions, path, and artifact ref in context while preserving failure diagnostics and call/result pairing.",
    kind: "implement",
    dependsOn: ["compact-v2-contract", "compact-isomorphic-micro"],
    rationale: "Artifact offload is required for large tool outputs without losing recoverability.",
    plan: readyPlan({
      objective:
        "Persist oversized recoverable tool-result bodies as Artifacts and leave compact context stubs that keep status, key conclusions, path, artifact refs, failure exit codes, and protocol pairing intact.",
      successCriteria: [
        "Fixture test with a long recoverable tool result creates an artifact:* ref and the in-context stub retains status plus artifact ref, with exit code 0.",
        "Failed tool-result fixture keeps exit code and key diagnostic text in-context after offload, asserted by tests with exit code 0.",
        "Tests assert tool-call and tool-result protocol pairing remains valid after Artifact offload, with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 for long-result offload, failure-diagnostic retention, and pairing integrity.",
        "Sample artifact JSON file path under .spark/artifacts proving original body storage for the long tool result fixture.",
      ],
      items: [
        "Implement recoverability and length gates for Artifact offload candidates in tool-result compaction.",
        "Implement Artifact write plus in-context stub generation that keeps status and artifact refs.",
        "Update stubs to preserve failure status, exit-code, and diagnostic fields.",
        "Add pairing and recovery regression tests for long and failed tool results.",
      ],
    }),
  },
  {
    name: "compact-smart-summary",
    title: "Implement Smart fixed-structure full summary with fallback",
    description:
      "Generate full-compaction summaries with a fixed schema (goals, done, in-progress, decisions, files, commands, failures, facts, open items, memory refs), validate model output, and fall back immediately to deterministic summary on model or schema failure.",
    kind: "implement",
    dependsOn: ["compact-v2-contract", "compact-token-metering"],
    rationale:
      "Full compaction needs structured low-authority history plus a reliable deterministic fallback.",
    plan: readyPlan({
      objective:
        "Ship Smart full-summary generation with schema validation and immediate deterministic fallback when the model fails or returns invalid structure, recording fallbackReason in compact metadata.",
      constraints: [
        "Full summary always remains low-authority historical data.",
        "Default compact model is the current session model; an independent compact model must be configurable.",
      ],
      successCriteria: [
        "Schema validation tests accept valid model output only when all required Smart summary sections pass, with suite exit code 0.",
        "Model-failure and schema-invalid fixtures both produce deterministic fallback summaries with fallbackReason set, asserted by tests with exit code 0.",
        "Unit tests assert configurable compact model selection defaults to the active session model, with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 covering schema accept, model-failure fallback, and schema-invalid fallback paths.",
        "Test artifact or fixture JSON recording fallbackReason when deterministic fallback is used.",
      ],
      items: [
        "Implement Smart summary schema sections and validators for required fixed fields.",
        "Implement model-backed summary generation using the configurable compact model.",
        "Implement deterministic fallback summarizer and record fallbackReason in metadata.",
        "Add tests for schema accept path and both model-failure and schema-invalid fallback modes.",
      ],
    }),
  },
  {
    name: "compact-runtime-wiring",
    title: "Unify automatic, manual, daemon, and recovery compact entrypoints",
    description:
      "Wire one Compact V2 policy across auto threshold triggers, /compact, daemon/headless turns, session recovery, and branch summary reuse; micro-then-full escalation must avoid reprocessing already artifactized or compacted content.",
    kind: "implement",
    dependsOn: ["compact-isomorphic-micro", "compact-artifact-recovery", "compact-smart-summary"],
    rationale: "Entrypoint parity prevents TUI/daemon/recovery drift after algorithm work lands.",
    plan: readyPlan({
      objective:
        "Connect Compact V2 scheduling so auto, /compact, daemon/headless, recovery, and branch-summary paths share one policy: micro once on micro-threshold, escalate to full when still above full safety threshold, and skip already compacted/artifactized content.",
      successCriteria: [
        "Harness/integration tests cover auto trigger, manual /compact feedback fields, and daemon/headless entry with the same policy decisions, with suite exit code 0.",
        "After micro-compaction still above full threshold, tests assert an immediate full compaction runs once, with exit code 0.",
        "Follow-up compact-pass tests assert already artifactized or compacted segments are not selected again, with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 for auto, manual /compact, and daemon/headless compact entry fixtures.",
        "Captured /compact feedback log artifact showing compact type, tokenSource, measuredReductionRatio, and fallback fields.",
      ],
      items: [
        "Inspect existing auto, /compact, daemon, recovery, and branch-summary compact entrypoints.",
        "Implement shared scheduler for micro-then-full escalation and skip-already-compacted rules.",
        "Update manual /compact feedback fields for type, tokens, ratio, tokenSource, and fallback.",
        "Add cross-entry regression tests including recovery/branch summary reuse of Smart structure.",
      ],
    }),
  },
  {
    name: "compact-memory-candidates",
    title: "Add evidence-gated async Memory candidates after full compact",
    description:
      "Keep session_before_compact checkpoints; after full compaction asynchronously propose stable fact candidates, writing long-term Memory only when valid evidence refs exist, without blocking Compact on review/write failures.",
    kind: "implement",
    dependsOn: ["compact-smart-summary", "compact-runtime-wiring"],
    rationale:
      "Memory enrichment must stay evidence-gated and non-blocking relative to Compact latency.",
    plan: readyPlan({
      objective:
        "After full compaction, asynchronously emit Memory fact candidates that write only when evidence refs are valid, preserve session_before_compact checkpoints, and never block Compact completion on candidate review or write failures.",
      constraints: [
        "Task/goal/project durable tools remain authoritative over Memory candidates.",
        "Candidates without valid evidence refs must not enter long-term Memory.",
      ],
      successCriteria: [
        "Tests assert session_before_compact checkpoint artifact/content still exists after full compact, with exit code 0.",
        "Write-gate tests reject candidates lacking evidence refs and accept candidates with valid evidence refs, with exit code 0.",
        "Injected Memory write/review failure fixtures leave Compact marked succeeded and do not throw into the compact caller, with exit code 0.",
      ],
      evidenceRequired: [
        "Node/vitest command output with exit code 0 for checkpoint retention, evidence gate accept/reject, and non-blocking failure fixtures.",
        "Test log artifact proving Memory candidate work completes asynchronously relative to compact success status.",
      ],
      items: [
        "Inspect session_before_compact checkpoint path and verify it remains intact after full compact.",
        "Implement async candidate extraction from Smart summary facts and open items.",
        "Implement evidence-ref gate before long-term Memory writes.",
        "Add non-blocking failure tests around candidate review and write errors.",
      ],
    }),
  },
  {
    name: "compact-v2-acceptance",
    title: "Verify Compact V2 with tests, typecheck, build, and docs",
    description:
      "Run focused Compact/spark-turn/spark-memory/spark-session tests plus typecheck/build, and document Compact V2 config knobs and tokenSource semantics.",
    kind: "review",
    dependsOn: ["compact-runtime-wiring", "compact-memory-candidates"],
    rationale:
      "Acceptance gates prove the integrated Compact V2 path before calling the project done.",
    plan: readyPlan({
      objective:
        "Complete Compact V2 acceptance by running the compact/turn/memory/session test suites, package typecheck/build, and publishing config documentation for thresholds, targetReduction, compact model, and tokenSource labels.",
      successCriteria: [
        "Focused Compact, spark-turn, spark-memory, and spark-session test commands complete with exit code 0.",
        "`pnpm run check:tsc` and Compact-related package build commands complete with exit code 0.",
        "Docs file for Compact V2 config describes micro/full thresholds, default targetReduction 0.4, configurable compact model, and tokenSource semantics with no unresolved TODO markers.",
      ],
      evidenceRequired: [
        "Command logs with exit code 0 for the focused test suites plus check:tsc/build.",
        "git diff for the Compact V2 configuration documentation file path under docs/.",
      ],
      items: [
        "Run Compact, spark-turn, spark-memory, and spark-session focused tests and record exit codes.",
        "Run typecheck and Compact-related package builds and record exit codes.",
        "Document Compact V2 config knobs and tokenSource UI semantics under docs/.",
        "Record acceptance evidence checklist against the eight Compact V2 tasks in the docs or review artifact.",
      ],
    }),
  },
];

const store = defaultTaskGraphStore(cwd);
const graph = await store.load();
if (!graph) throw new Error(`No task graph found under ${cwd}`);
const project = graph.getProject(PROJECT_REF);
if (!project) throw new Error(`Project not found: ${PROJECT_REF}`);

const result = graph.planTasks(PROJECT_REF, tasks);
const changed = [...result.created, ...result.updated];
for (const task of changed) {
  const decision = decideTaskPlanBeforeCreate(task);
  if (!decision.accepted) {
    throw new Error(
      `Task plan not ready: @${task.name}: ${task.title}; ${decision.summary ?? "unknown readiness issue"}`,
    );
  }
}
await store.save(graph);

console.log(
  JSON.stringify(
    {
      projectRef: PROJECT_REF,
      created: result.created.map((task) => ({
        name: task.name,
        ref: task.ref,
        title: task.title,
      })),
      updated: result.updated.map((task) => ({
        name: task.name,
        ref: task.ref,
        title: task.title,
      })),
      ready: result.created
        .concat(result.updated)
        .filter((task) => task.status === "ready")
        .map((task) => task.name),
    },
    null,
    2,
  ),
);
