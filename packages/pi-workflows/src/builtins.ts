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
