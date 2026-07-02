<script lang="ts">
  import type { SparkUiDiagnostic, SparkUiDocumentV1 } from "@zendev-lab/spark-generative-ui";
  import SafeMarkdown from "$lib/SafeMarkdown.svelte";

  type Labels = {
    artifact: string;
    task: string;
    run: string;
    diagnostics: string;
    source: string;
    unsupportedComponent: string;
  };

  const defaultLabels: Labels = {
    artifact: "Artifact",
    task: "Task",
    run: "Run",
    diagnostics: "Spark UI diagnostics",
    source: "Source",
    unsupportedComponent: "Unsupported component",
  };

  let {
    document,
    source = "",
    showSource = true,
    labels = defaultLabels,
  }: {
    document: SparkUiDocumentV1;
    source?: string;
    showSource?: boolean;
    labels?: Partial<Labels>;
  } = $props();

  let mergedLabels = $derived({ ...defaultLabels, ...labels });

  function formatDiagnostic(diagnostic: SparkUiDiagnostic): string {
    const location = diagnostic.line ? `line ${diagnostic.line}: ` : "";
    return `${diagnostic.severity}: ${location}${diagnostic.message}`;
  }
</script>

<div class="spark-ui-document" data-schema-version={document.schemaVersion}>
  {#each document.blocks as block, index (`${block.type}-${index}`)}
    <section class="spark-ui-block {block.type}">
      {#if block.type === "markdown"}
        <SafeMarkdown source={block.text} />
      {:else if block.type === "artifact"}
        <article class="reference-card artifact-card">
          <span class="reference-kicker">{mergedLabels.artifact}</span>
          <strong>{block.title ?? block.artifactRef}</strong>
          <code>{block.artifactRef}</code>
        </article>
      {:else if block.type === "task"}
        <article class="reference-card task-card">
          <span class="reference-kicker">{mergedLabels.task}</span>
          <strong>{block.title ?? block.taskRef}</strong>
          <code>{block.taskRef}</code>
        </article>
      {:else if block.type === "run"}
        <article class="reference-card run-card">
          <span class="reference-kicker">{mergedLabels.run}</span>
          <strong>{block.title ?? block.runRef}</strong>
          <code>{block.runRef}</code>
        </article>
      {:else if block.type === "callout"}
        <article class="callout {block.tone}">
          {#if block.title}
            <strong>{block.title}</strong>
          {/if}
          <SafeMarkdown source={block.body} />
        </article>
      {:else}
        <article class="reference-card unsupported-card">
          <span class="reference-kicker">{mergedLabels.unsupportedComponent}</span>
          <code>{JSON.stringify(block)}</code>
        </article>
      {/if}
    </section>
  {/each}

  {#if document.diagnostics.length > 0}
    <details class="spark-ui-diagnostics">
      <summary>{mergedLabels.diagnostics}</summary>
      <ul>
        {#each document.diagnostics as diagnostic}
          <li class={diagnostic.severity}>{formatDiagnostic(diagnostic)}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if showSource && source.trim()}
    <details class="spark-ui-source">
      <summary>{mergedLabels.source}</summary>
      <pre>{source}</pre>
    </details>
  {/if}
</div>

<style>
  .spark-ui-document {
    display: grid;
    gap: 0.85rem;
    min-width: 0;
  }

  .spark-ui-block {
    min-width: 0;
  }

  .reference-card,
  .callout {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 0.35rem;
    padding: 0.85rem;
  }

  .reference-card strong {
    color: var(--color-ink);
    font-size: 0.95rem;
  }

  .reference-kicker {
    color: var(--color-ink-muted);
    font-size: 0.72rem;
    font-weight: 850;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .reference-card code,
  .unsupported-card code {
    color: var(--color-ink-subtle);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  .artifact-card {
    border-color: var(--color-primary-soft);
  }

  .task-card {
    border-color: var(--color-success);
  }

  .run-card {
    border-color: var(--color-warning);
  }

  .callout {
    border-left-width: 4px;
  }

  .callout strong {
    color: var(--color-ink);
  }

  .callout.info {
    border-left-color: var(--color-primary);
  }

  .callout.success {
    border-left-color: var(--color-success);
  }

  .callout.warning {
    border-left-color: var(--color-warning);
  }

  .callout.error {
    border-left-color: var(--color-danger);
  }

  .spark-ui-diagnostics,
  .spark-ui-source {
    border-top: 1px solid var(--color-border);
    color: var(--color-ink-subtle);
    font-size: 0.78rem;
    padding-top: 0.5rem;
  }

  .spark-ui-diagnostics summary,
  .spark-ui-source summary {
    cursor: pointer;
    font-weight: 800;
  }

  .spark-ui-diagnostics ul {
    display: grid;
    gap: 0.35rem;
    margin: 0.5rem 0 0;
    padding-left: 1.2rem;
  }

  .spark-ui-diagnostics li.error {
    color: var(--color-danger-strong);
  }

  .spark-ui-source pre {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-ink);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    margin: 0.5rem 0 0;
    max-height: 260px;
    overflow: auto;
    padding: 10px;
    white-space: pre-wrap;
  }
</style>
