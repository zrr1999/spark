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
    id: "research",
    mode: "research",
    title: "research",
    description:
      "Research workflow with planning, panel exploration, verification, and report synthesis",
    scriptFactory: researchWorkflowScript,
  },
  {
    id: "review",
    mode: "research",
    title: "review",
    description: "Findings cross-checked by skeptical reviewers",
    scriptFactory: reviewWorkflowScript,
  },
];

export function listBuiltinWorkflows(): readonly BuiltinWorkflowDefinition[] {
  return builtinWorkflowDefinitions;
}

export function getBuiltinWorkflowDefinition(id: string): BuiltinWorkflowDefinition | undefined {
  return builtinWorkflowDefinitions.find((workflow) => workflow.id === id);
}

export function researchWorkflowScript(): string {
  return `export const meta = {
  name: 'research',
  description: 'Research workflow with planning, panel exploration, verification, and report synthesis',
  phases: [{ title: 'Plan' }, { title: 'Explore' }, { title: 'Verify' }, { title: 'Report' }],
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
  : Array.from({ length: panelSize }, (_, index) => ({ label: 'researcher ' + (index + 1) }))

function panelPrompt() {
  return [
    'You are one contributor in a Spark research workflow.',
    'Answer the user request independently. Be concise, evidence-oriented, and mention uncertainty or assumptions. Do not call tools.',
    '',
    'User request:',
    question,
  ].join('\\n')
}

phase('Plan')
const plan = await agent('Plan a concise research approach for: ' + question, { label: 'research plan' })

phase('Explore')
const panelResults = await parallel(panel.map((item, index) => async () => {
  const model = typeof item === 'string'
    ? item
    : (item && item.model ? String(item.model) : undefined)
  const provider = item && typeof item === 'object' && item.provider ? String(item.provider) : undefined
  const label = item && typeof item === 'object' && (item.label || item.name)
    ? String(item.label || item.name)
    : (model || provider || ('researcher ' + (index + 1)))
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
      : (value.label || value.model || ('researcher ' + (index + 1)))
    return '## Contributor ' + (index + 1) + ': ' + label + '\\n' + (value.output || '(empty response)')
  }
  const reason = result && result.reason
    ? (result.reason.message || String(result.reason))
    : 'unknown error'
  return '## Contributor ' + (index + 1) + '\\nERROR: ' + reason
}

const renderedResults = panelResults.map(renderPanelResult).join('\\n\\n')

phase('Verify')
const verified = await agent([
  'Cross-check Spark research panel results.',
  '',
  'Original user request:',
  question,
  '',
  'Research plan:',
  plan,
  '',
  'Panel responses:',
  renderedResults,
].join('\\n'), { label: 'cross-check' })

phase('Report')
const report = await agent([
  'Write the final user-facing research answer.',
  'Prefer verified consensus, call out contradictions only when useful, and do not invent unavailable evidence.',
  '',
  'Original user request:',
  question,
  '',
  'Verified notes:',
  verified,
  '',
  'Panel responses:',
  renderedResults,
].join('\\n'), {
  label: 'write report',
  model: input.judgeModel,
  agentType: 'model',
})
return { question, plan, panelResults, verified, report }`;
}

export function reviewWorkflowScript(): string {
  return `export const meta = {
  name: 'review',
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

/** @deprecated Use researchWorkflowScript; fusion is now an implementation strategy, not a public builtin workflow id. */
export function fusionWorkflowScript(): string {
  return researchWorkflowScript();
}

/** @deprecated Use researchWorkflowScript; deep research is folded into the public research workflow. */
export function deepResearchWorkflowScript(): string {
  return researchWorkflowScript();
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

/** @deprecated Use reviewWorkflowScript; adversarial review is now the review workflow strategy. */
export function adversarialReviewWorkflowScript(): string {
  return reviewWorkflowScript();
}
