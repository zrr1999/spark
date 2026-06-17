export type BuiltinWorkflowMode = "research" | "plan" | "implement";

export interface BuiltinWorkflowDefinition {
  id: string;
  mode: BuiltinWorkflowMode;
  title: string;
  description: string;
  scriptFactory: () => string;
}

export const builtinWorkflowDefinitions: readonly BuiltinWorkflowDefinition[] = [
  {
    id: "fusion",
    mode: "research",
    title: "fusion",
    description: "Fusion-style multi-model deliberation with panel review and judge synthesis",
    scriptFactory: fusionWorkflowScript,
  },
  {
    id: "deep-research",
    mode: "research",
    title: "deep_research",
    description: "Deep research with cross-checked claims",
    scriptFactory: deepResearchWorkflowScript,
  },
  {
    id: "fan-out-with-brief",
    mode: "research",
    title: "fan_out_with_brief",
    description:
      "Fan out multiple agents from one shared briefing artifact and collect their outputs",
    scriptFactory: fanOutWithBriefWorkflowScript,
  },
  {
    id: "adversarial-review",
    mode: "research",
    title: "adversarial_review",
    description: "Findings cross-checked by skeptical reviewers",
    scriptFactory: adversarialReviewWorkflowScript,
  },
];

export function listBuiltinWorkflows(): readonly BuiltinWorkflowDefinition[] {
  return builtinWorkflowDefinitions;
}

export function getBuiltinWorkflowDefinition(id: string): BuiltinWorkflowDefinition | undefined {
  return builtinWorkflowDefinitions.find((workflow) => workflow.id === id);
}

export function fusionWorkflowScript(): string {
  return `export const meta = {
  name: 'fusion',
  description: 'Fusion-style multi-model deliberation with panel review and judge synthesis',
  phases: [{ title: 'Panel' }, { title: 'Synthesis' }],
}

const input = args || {}
const question = String(input.question || input.prompt || input.task || '')
const configuredPanel = Array.isArray(input.panelModels)
  ? input.panelModels
  : (Array.isArray(input.models) ? input.models : [])
const requestedPanelSize = Number(input.panelSize)
const panelSize = Number.isFinite(requestedPanelSize)
  ? Math.max(1, Math.min(8, Math.trunc(requestedPanelSize)))
  : 3
const panel = configuredPanel.length > 0
  ? configuredPanel
  : Array.from({ length: panelSize }, (_, index) => ({ label: 'panel ' + (index + 1) }))

function panelPrompt() {
  return [
    'You are one expert in a Spark Fusion-style multi-model panel.',
    'Answer the user request independently. Be concise, evidence-oriented, and mention uncertainty or assumptions. Do not call tools.',
    '',
    'User request:',
    question,
  ].join('\\n')
}

phase('Panel')
const panelResults = await parallel(panel.map((item, index) => async () => {
  const model = typeof item === 'string'
    ? item
    : (item && item.model ? String(item.model) : undefined)
  const provider = item && typeof item === 'object' && item.provider ? String(item.provider) : undefined
  const label = item && typeof item === 'object' && (item.label || item.name)
    ? String(item.label || item.name)
    : (model || provider || ('panel ' + (index + 1)))
  return {
    label,
    provider,
    model,
    output: await agent(panelPrompt(), { label, model, agentType: 'model' }),
  }
}), {
  concurrency: input.concurrency,
  retry: input.retry,
  onError: 'collect',
})

function renderPanelResult(result, index) {
  if (result && result.status === 'fulfilled') {
    const value = result.value || {}
    const label = value.provider && value.model
      ? value.provider + '/' + value.model
      : (value.label || value.model || ('panel ' + (index + 1)))
    return '## Panel ' + (index + 1) + ': ' + label + '\\n' + (value.output || '(empty response)')
  }
  const reason = result && result.reason
    ? (result.reason.message || String(result.reason))
    : 'unknown error'
  return '## Panel ' + (index + 1) + '\\nERROR: ' + reason
}

phase('Synthesis')
const renderedResults = panelResults.map(renderPanelResult).join('\\n\\n')
const judgePrompt = [
  'You are the judge in a Spark Fusion-style multi-model deliberation.',
  'Compare the panel responses, then write the final answer for the user. Prefer consensus, call out contradictions only when useful, preserve unique correct insights, and do not invent unavailable evidence.',
  'Return the final user-facing answer directly; do not include hidden analysis JSON unless the user asked for it.',
  '',
  'Original user request:',
  question,
  '',
  'Panel responses:',
  renderedResults,
  '',
  'Synthesize a final answer. Use this comparison checklist internally: consensus, contradictions, coverage gaps, unique insights, and blind spots.',
].join('\\n')
const report = await agent(judgePrompt, {
  label: 'judge synthesis',
  model: input.judgeModel,
  agentType: 'model',
})
return { question, panelResults, report }`;
}

export function deepResearchWorkflowScript(): string {
  return `export const meta = {
  name: 'deep_research',
  description: 'Deep research with cross-checked claims',
  phases: [{ title: 'Queries' }, { title: 'Gather' }, { title: 'Verify' }, { title: 'Report' }],
}

const question = (args && args.question) || ''
phase('Queries')
const plan = await agent('Plan diverse research queries for: ' + question, { label: 'plan queries' })
phase('Gather')
const gathered = await parallel([
  () => agent('Gather source-backed claims for: ' + question, { label: 'gather claims' }),
  () => agent('Find dissenting or missing evidence for: ' + question, { label: 'find caveats' }),
])
phase('Verify')
const verified = await agent('Cross-check gathered research: ' + JSON.stringify(gathered), { label: 'cross-check' })
phase('Report')
const report = await agent('Write final cited report for: ' + question + '\\n' + verified, { label: 'write report' })
return { question, gathered, verified, report }`;
}

export function fanOutWithBriefWorkflowScript(): string {
  return `export const meta = {
  name: 'fan_out_with_brief',
  description: 'Fan out multiple agents from one shared briefing artifact and collect their outputs',
  phases: [{ title: 'Brief' }, { title: 'Fan out' }, { title: 'Fan in' }],
}

const briefBody = args && typeof args.briefBody === 'string' ? args.briefBody : ''
const agents = Array.isArray(args && args.agents) ? args.agents : []
if (!briefBody.trim()) throw new Error('fan_out_with_brief requires args.briefBody')
if (agents.length === 0) throw new Error('fan_out_with_brief requires args.agents[]')

phase('Brief')
const brief = await artifactRecord({
  title: args.briefTitle || 'Workflow briefing',
  kind: 'research',
  format: 'markdown',
  body: briefBody,
})
phase('Brief', { status: 'success' })

phase('Fan out')
const outputs = await parallel(agents.map((item, index) => async () => {
  const name = item && (item.name || item.label) ? String(item.name || item.label) : 'agent-' + (index + 1)
  const prompt = item && item.prompt ? String(item.prompt) : ''
  if (!prompt.trim()) throw new Error('fan_out_with_brief agent ' + name + ' requires prompt')
  return {
    name,
    label: item && item.label ? String(item.label) : name,
    result: await agent(prompt, {
      label: item && item.label ? String(item.label) : name,
      artifactRef: brief.ref,
      agentType: item && item.agentType ? String(item.agentType) : undefined,
      model: item && item.model ? String(item.model) : undefined,
    }),
  }
}), {
  concurrency: args && args.concurrency,
  retry: args && args.retry,
  onError: args && args.onError,
})
phase('Fan out', { status: 'success' })

phase('Fan in')
return { briefRef: brief.ref, outputs }`;
}

export function adversarialReviewWorkflowScript(): string {
  return `export const meta = {
  name: 'adversarial_review',
  description: 'Findings cross-checked by skeptical reviewers',
  phases: [{ title: 'Investigate' }, { title: 'Refute' }, { title: 'Consensus' }],
}

const task = (args && args.task) || ''
phase('Investigate')
const findings = await agent('List concrete findings for: ' + task, { label: 'investigate' })
phase('Refute')
const refutations = await parallel([
  () => agent('Try to refute these findings: ' + findings, { label: 'skeptic 1' }),
  () => agent('Independently verify these findings: ' + findings, { label: 'skeptic 2' }),
])
phase('Consensus')
const report = await agent('Write only findings that survived review: ' + JSON.stringify(refutations), { label: 'consensus' })
return { task, findings, refutations, report }`;
}
