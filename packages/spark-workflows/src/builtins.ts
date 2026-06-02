export function goalWorkflowScript(): string {
  return `export const meta = {
  name: 'goal',
  description: 'Foreground continuous verified progress across ready Spark tasks until complete or blocked',
  whenToUse: 'Use when the user wants autonomous verified project progress over the Spark task DAG.',
  phases: [{ title: 'Inspect' }, { title: 'Execute' }, { title: 'Continue' }],
}

phase('Inspect')
return {
  backend: 'goal',
  contract: 'Inspect the current Spark project/task plan, claim one ready task at a time, finish it with evidence, and continue until complete or blocked.',
}
`;
}

export function readyWorkflowScript(): string {
  return `export const meta = {
  name: 'ready',
  description: 'Background ready-task frontier scheduler backed by Spark task graph claims and workflow-run history',
  whenToUse: 'Use when the user wants to dispatch the current ready frontier through Spark workflow-run scheduling.',
  phases: [{ title: 'Preflight' }, { title: 'Dispatch' }, { title: 'Reconcile' }],
}

phase('Preflight')
return {
  backend: 'ready-frontier',
  contract: 'Preflight ready tasks, then dispatch with spark_run_ready_tasks when approved and reconcile workflow-run state afterward.',
}
`;
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
