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
