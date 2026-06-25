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
      "Deep research workflow with query planning, web search, source fetching, verification, and cited synthesis",
    scriptFactory: researchWorkflowScript,
  },
  {
    id: "review",
    mode: "research",
    title: "review",
    description: "Adversarial review workflow with critique, rebuttal, and verdict synthesis",
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
  description: 'Deep research workflow with query planning, web search, source fetching, verification, and cited synthesis',
  stages: [
    { title: 'Plan' },
    { title: 'Search' },
    { title: 'Fetch' },
    { title: 'Verify' },
    { title: 'Report' },
  ],
}

const input = args || {}
const question = String(input.question || input.prompt || input.task || '').trim()
const collectErrors = input.collectErrors !== false
const maxQueries = boundedInt(input.maxQueries, 4, 1, 8)
const searchResultsPerQuery = boundedInt(input.searchResultsPerQuery || input.numResults, 5, 1, 20)
const fetchTopN = boundedInt(input.fetchTopN, 6, 0, 12)
const configuredPanel = Array.isArray(input.panelModels)
  ? input.panelModels
  : (Array.isArray(input.models) ? input.models : [])
const panelSize = boundedInt(input.panelSize, configuredPanel.length || 2, 1, 8)
const panel = configuredPanel.length > 0
  ? configuredPanel
  : Array.from({ length: panelSize }, (_, index) => ({ label: 'source analyst ' + (index + 1) }))

function boundedInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}

function defaultQueries(text) {
  const base = text || 'research question'
  return [
    base,
    base + ' evidence sources',
    base + ' counterarguments limitations',
    base + ' implementation details examples',
  ].slice(0, maxQueries)
}

const queries = (Array.isArray(input.queries) ? input.queries : defaultQueries(question))
  .map((query) => String(query).trim())
  .filter(Boolean)
  .slice(0, maxQueries)

function compact(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

function normalizeParallel(results, labels) {
  return results.map((item, index) => {
    if (item && item.status === 'fulfilled') return item.value
    if (item && item.status === 'rejected') return { label: labels[index], error: errorText(item.reason) }
    return item
  })
}

function collectUrls(value, out) {
  if (!out) out = []
  if (!value) return out
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\\/\\/[^\\s)\\]"'<>]+/g)) out.push(match[0])
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out)
    return out
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'sourceUrl', 'link', 'href', 'citationUrl']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && /^https?:\\/\\//.test(candidate)) out.push(candidate)
    }
    for (const item of Object.values(value)) collectUrls(item, out)
  }
  return out
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

stage('Plan')
const plan = await agent([
  'Plan a deep research approach.',
  'Return concise bullets covering search angles, likely source types, and verification risks.',
  '',
  'Question:',
  question,
].join('\\n'), { label: 'research plan', model: input.plannerModel })

stage('Search')
const rawSearches = await parallel(queries.map((query) => async () => ({
  query,
  result: await webSearch({
    query,
    numResults: searchResultsPerQuery,
    includeContent: false,
    recencyFilter: input.recencyFilter,
    domainFilter: Array.isArray(input.domainFilter) ? input.domainFilter : undefined,
  }),
})), {
  concurrency: input.concurrency,
  retry: input.retry,
  onError: collectErrors ? 'collect' : 'fail-fast',
})
const searches = normalizeParallel(rawSearches, queries)
const urls = unique([
  ...(Array.isArray(input.urls) ? input.urls.map(String) : []),
  ...collectUrls(searches),
]).slice(0, fetchTopN)

stage('Fetch')
const rawFetchedSources = urls.length === 0 ? [] : await parallel(urls.map((url) => async () => ({
  url,
  content: await fetchContent({
    url,
    prompt: 'Extract source facts relevant to: ' + question,
  }),
})), {
  concurrency: input.fetchConcurrency || input.concurrency,
  retry: input.retry,
  onError: collectErrors ? 'collect' : 'fail-fast',
})
const fetchedSources = normalizeParallel(rawFetchedSources, urls)
const sourceBrief = [
  'Question: ' + question,
  '',
  'Planned approach:',
  compact(plan, 2000),
  '',
  'Searches:',
  compact(searches, 5000),
  '',
  'Fetched sources:',
  compact(fetchedSources, 6000),
].join('\\n')

stage('Verify')
const panelResults = await parallel(panel.map((item, index) => async () => {
  const model = typeof item === 'string'
    ? item
    : (item && item.model ? String(item.model) : undefined)
  const label = item && typeof item === 'object' && (item.label || item.name)
    ? String(item.label || item.name)
    : (model || ('source analyst ' + (index + 1)))
  return {
    label,
    model,
    output: await agent([
      'Assess the source evidence for this research question.',
      'Cross-check claims, cite only URLs present in the source brief, and identify uncertainties.',
      '',
      sourceBrief,
    ].join('\\n'), { label, model, agentType: model ? 'model' : undefined }),
  }
}), {
  concurrency: input.panelConcurrency || input.concurrency,
  retry: input.retry,
  onError: collectErrors ? 'collect' : 'fail-fast',
})
const normalizedPanel = normalizeParallel(panelResults, panel.map((item, index) => item && item.label ? String(item.label) : 'source analyst ' + (index + 1)))
const verified = await agent([
  'Adversarially verify the research evidence.',
  'Separate well-supported claims, weak claims, contradictions, and missing source coverage.',
  'Every supported claim must cite a URL from the fetched/search sources. Do not invent citations.',
  '',
  sourceBrief,
  '',
  'Source analyst notes:',
  compact(normalizedPanel, 6000),
].join('\\n'), { label: 'cross-check sources', model: input.verifierModel })

stage('Report')
const report = await agent([
  'Write the final user-facing deep research report.',
  'Requirements:',
  '- Answer the question directly.',
  '- Use inline citations with source URLs for factual claims.',
  '- Include a Sources section listing cited URLs.',
  '- Call out uncertainty, contradictions, and unverified areas.',
  '',
  'Question:',
  question,
  '',
  'Verified evidence:',
  compact(verified, 6000),
  '',
  'Source analyst notes:',
  compact(normalizedPanel, 6000),
].join('\\n'), {
  label: 'write cited report',
  model: input.judgeModel || input.reportModel,
  agentType: input.judgeModel || input.reportModel ? 'model' : undefined,
})
return { question, plan, queries, searches, fetchedSources, panelResults: normalizedPanel, verified, report }`;
}

export function reviewWorkflowScript(): string {
  return `export const meta = {
  name: 'review',
  description: 'Adversarial review workflow with critique, rebuttal, and verdict synthesis',
  stages: [{ title: 'Investigate' }, { title: 'Critique' }, { title: 'Rebut' }, { title: 'Verdict' }],
}

const input = args || {}
const task = String(input.task || input.prompt || input.question || '').trim()
const collectErrors = input.collectErrors !== false
const criticCount = boundedInt(input.critics, 2, 1, 6)

function boundedInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}

function compact(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

function normalizeParallel(results, labels) {
  return results.map((item, index) => {
    if (item && item.status === 'fulfilled') return item.value
    if (item && item.status === 'rejected') return { label: labels[index], error: errorText(item.reason) }
    return item
  })
}

stage('Investigate')
const search = input.skipSearch ? { skipped: true } : await webSearch({
  query: task,
  numResults: input.numResults || 5,
  includeContent: false,
})
const findings = await agent([
  'List concrete, reviewable findings for the target below.',
  'Prefer claims that can be checked. Include likely evidence URLs from the search data when present.',
  '',
  'Target:',
  task,
  '',
  'Search data:',
  compact(search, 4000),
].join('\\n'), { label: 'investigate findings', model: input.investigatorModel })

stage('Critique')
const criticLabels = Array.from({ length: criticCount }, (_, index) => 'skeptic ' + (index + 1))
const rawCritiques = await parallel(criticLabels.map((label, index) => async () => ({
  label,
  critique: await agent([
    'Adversarially review these findings.',
    'Find false positives, unsupported claims, missing evidence, edge cases, and risk severity mistakes.',
    'Return clear objections and what evidence would resolve each objection.',
    '',
    'Target:',
    task,
    '',
    'Findings:',
    compact(findings, 6000),
  ].join('\\n'), {
    label,
    model: Array.isArray(input.criticModels) ? input.criticModels[index] : input.criticModel,
    agentType: Array.isArray(input.criticModels) || input.criticModel ? 'model' : undefined,
  }),
})), {
  concurrency: input.concurrency,
  retry: input.retry,
  onError: collectErrors ? 'collect' : 'fail-fast',
})
const critiques = normalizeParallel(rawCritiques, criticLabels)

stage('Rebut')
const rebuttal = await agent([
  'Respond to the adversarial critiques without hand-waving.',
  'Mark each finding as survives, revised, or rejected. Cite source URLs from search data when available.',
  '',
  'Target:',
  task,
  '',
  'Findings:',
  compact(findings, 6000),
  '',
  'Critiques:',
  compact(critiques, 6000),
].join('\\n'), { label: 'rebut critiques', model: input.rebuttalModel })

stage('Verdict')
const report = await agent([
  'Write the final adversarial review verdict.',
  'Include:',
  '- Overall verdict: pass, pass-with-issues, or fail.',
  '- Surviving findings with confidence and citations when available.',
  '- Rejected or downgraded findings with reasons.',
  '- Follow-up checks needed.',
  '',
  'Target:',
  task,
  '',
  'Original findings:',
  compact(findings, 6000),
  '',
  'Critiques:',
  compact(critiques, 6000),
  '',
  'Rebuttal:',
  compact(rebuttal, 6000),
].join('\\n'), { label: 'adversarial verdict', model: input.verdictModel || input.judgeModel })
return { task, search, findings, critiques, rebuttal, report }`;
}

export function fanOutWithBriefWorkflowScript(): string {
  return `export const meta = {
  name: 'fan_out_with_brief',
  description: 'Fan out multiple agents from one shared briefing artifact and collect their outputs',
  stages: [{ title: 'Brief' }, { title: 'Fan out' }, { title: 'Fan in' }],
}

const briefBody = args && typeof args.briefBody === 'string' ? args.briefBody : ''
const agents = Array.isArray(args && args.agents) ? args.agents : []
if (!briefBody.trim()) throw new Error('fan_out_with_brief requires args.briefBody')
if (agents.length === 0) throw new Error('fan_out_with_brief requires args.agents[]')

stage('Brief')
const brief = await artifactRecord({
  title: args.briefTitle || 'Workflow briefing',
  kind: 'research',
  format: 'markdown',
  body: briefBody,
})
stage('Brief', { status: 'success' })

stage('Fan out')
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
stage('Fan out', { status: 'success' })

stage('Fan in')
return { briefRef: brief.ref, outputs }`;
}
