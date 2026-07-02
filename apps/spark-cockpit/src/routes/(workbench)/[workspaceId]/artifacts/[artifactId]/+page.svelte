<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import SparkUiRenderer from "$lib/SparkUiRenderer.svelte";
  import { buildArtifactSparkUiReplay } from "$lib/artifact-ui-replay";
  import { enumLabel, formatByteSize, formatRelativeTime } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.artifactDetail);
  let common = $derived(data.messages.common);
  let previewCache = $derived(data.cacheBlobs.find((blob) => blob.isPreview));
  let preview = $derived(data.preview);
  let workspaceUrl = $derived(workspacePath({ slug: data.artifact.workspaceSlug }));
  let sparkUiReplay = $derived(
    buildArtifactSparkUiReplay({
      kind: data.artifact.kind,
      format: data.artifact.format,
      contentRef: data.artifact.contentRef as Record<string, unknown>,
      previewText: preview.body?.text ?? null,
    }),
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function formatJson(value: unknown) {
    return JSON.stringify(value, null, 2);
  }

  function formatSize(value: number | null) {
    return formatByteSize(value, data.locale, common);
  }

  function previewStatusLabel(status: string) {
    return enumLabel(status, t.preview.statusLabels);
  }

  function previewStatusHint(status: string) {
    return enumLabel(status, t.preview.statusHints);
  }

  function scopeLabel(scope: string) {
    return enumLabel(scope, common.scope);
  }
</script>

<svelte:head>
  <title>{data.artifact.title} · {t.headTitleSuffix} · Spark</title>
</svelte:head>

<section class="artifact-detail-page">
  <header class="hero">
    <div>
      <p class="eyebrow">{data.artifact.kind} · {data.artifact.format}</p>
      <h1>{data.artifact.title}</h1>
      <p class="lede">
        {data.artifact.projectName ?? data.artifact.workspaceName} · {data.artifact.source} {t.evidenceLabel} · {formatRelative(data.artifact.createdAt)}
      </p>
    </div>
    <span class="scope-pill {data.artifact.scope}">{scopeLabel(data.artifact.scope)}</span>
  </header>

  <section class="meta-grid" aria-label={t.meta.aria}>
    <article>
      <span>{t.meta.source}</span>
      <strong>{data.artifact.source}</strong>
    </article>
    <article>
      <span>{t.meta.size}</span>
      <strong>{formatSize(data.artifact.sizeBytes)}</strong>
    </article>
    <article>
      <span>{t.meta.runner}</span>
      <strong>{data.artifact.runtimeName ?? common.fallback.server}</strong>
    </article>
    <article>
      <span>{t.meta.previewCache}</span>
      <strong>{previewStatusLabel(preview.status)}</strong>
    </article>
  </section>

  <section class="grid">
    <section class="panel" aria-labelledby="provenance-title">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">{t.provenance.kicker}</p>
          <h2 id="provenance-title">{t.provenance.title}</h2>
        </div>
      </div>

      <div class="provenance-list">
        {#if data.artifact.projectId}
          <article>
            <span>{t.provenance.project}</span>
            <a href={`${workspaceUrl}/projects/${data.artifact.projectId}`}
              >{data.artifact.projectName}</a
            >
          </article>
        {/if}
        {#if data.artifact.runtimeInvocationId}
          <article>
            <span>{t.provenance.invocation}</span>
            <strong>{data.artifact.runtimeInvocationId}</strong>
            <small>{data.artifact.agentName ?? common.fallback.runner} · {data.artifact.invocationStatus}</small>
          </article>
        {/if}
        {#if data.artifact.humanRequestId}
          <article>
            <span>{t.provenance.humanRequest}</span>
            <strong>{data.artifact.humanRequestTitle ?? data.artifact.humanRequestId}</strong>
          </article>
        {/if}
        {#if data.links.length > 0}
          <article>
            <span>{t.provenance.links}</span>
            <div class="chip-list">
              {#each data.links as link}
                <span class="chip">{link.relation}: {link.targetKind}/{link.targetId}</span>
              {/each}
            </div>
          </article>
        {/if}
      </div>

      <details open>
        <summary>{t.provenance.json}</summary>
        <pre>{formatJson(data.artifact.provenance)}</pre>
      </details>
    </section>

    <aside class="panel" aria-labelledby="cache-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.cache.kicker}</p>
          <h2 id="cache-title">{t.cache.title}</h2>
        </div>
      </div>

      {#if form?.message}
        <div class="form-error" role="alert">{form.message}</div>
      {/if}

      <div class="cache-body">
        <div class="cache-icon"><Icon name="archive" size={24} /></div>
        <div>
          <h3>{previewCache ? t.cache.registered : t.cache.notPrepared}</h3>
          <p>
            {t.cache.body}
          </p>
        </div>

        {#if previewCache}
          <dl>
            <div><dt>{t.cache.state}</dt><dd>{previewCache.state}</dd></div>
            <div><dt>{t.cache.path}</dt><dd>{previewCache.cachePath}</dd></div>
            <div><dt>{t.cache.mime}</dt><dd>{previewCache.mime ?? common.unknown}</dd></div>
            <div><dt>{t.cache.lastAccessed}</dt><dd>{formatRelative(previewCache.lastAccessedAt)}</dd></div>
          </dl>
        {/if}

        <form method="POST" action="?/preparePreview">
          <button class="primary-action" type="submit">{t.cache.prepare}</button>
          <a class="secondary-action" href={`/api/v1/artifacts/${data.artifact.id}/cache`}>{t.cache.openApi}</a>
        </form>
      </div>
    </aside>
  </section>

  <section class="panel" aria-labelledby="preview-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.preview.kicker}</p>
        <h2 id="preview-title">{t.preview.title}</h2>
      </div>
      <span class="preview-pill {preview.status}">
        {previewStatusLabel(preview.status)}
      </span>
    </div>

    <div class="preview-meta">
      <span>{t.preview.statusHint}</span>
      <p>{previewStatusHint(preview.status)}</p>
      <dl>
        <div><dt>{t.preview.state}</dt><dd>{preview.state}</dd></div>
        <div><dt>{t.preview.mime}</dt><dd>{preview.mime ?? common.unknown}</dd></div>
        <div><dt>{t.preview.size}</dt><dd>{formatSize(preview.sizeBytes)}</dd></div>
        <div><dt>{t.preview.fetched}</dt><dd>{formatRelative(preview.fetchedAt)}</dd></div>
      </dl>
      {#if preview.error?.message}
        <p class="preview-error">{preview.error.message}</p>
      {/if}
    </div>

    {#if preview.status === "ready" && preview.body}
      {#if preview.body.text !== null}
        <pre class="preview-body">{preview.body.text}</pre>
        {#if preview.body.truncated}
          <p class="preview-truncation">
            {t.preview.truncatedPrefix} {formatSize(preview.inlineLimitBytes)}.
            <a href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.openFull}</a>
          </p>
        {:else}
          <p class="preview-truncation">
            <a href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.openRaw}</a>
          </p>
        {/if}
      {:else}
        <p class="preview-truncation">
          {t.preview.nonTextPrefix}
          <a href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.contentEndpoint}</a>.
        </p>
      {/if}
    {:else}
      <p class="preview-truncation">
        <a href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.probe}</a>
      </p>
    {/if}
  </section>

  {#if sparkUiReplay}
    <section class="panel" aria-labelledby="spark-ui-replay-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.sparkUi.kicker}</p>
          <h2 id="spark-ui-replay-title">{t.sparkUi.title}</h2>
          <p class="panel-copy">{t.sparkUi.body}</p>
        </div>
        <span class="preview-pill ready">
          {sparkUiReplay.mode === "source" ? t.sparkUi.sourceMode : t.sparkUi.astMode}
        </span>
      </div>
      <div class="spark-ui-replay-body">
        <SparkUiRenderer document={sparkUiReplay.document} source={sparkUiReplay.source} />
      </div>
    </section>
  {/if}

  <section class="panel" aria-labelledby="content-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.content.kicker}</p>
        <h2 id="content-title">{t.content.title}</h2>
      </div>
    </div>
    <pre>{formatJson(data.artifact.contentRef)}</pre>
  </section>
</section>

<style>
  .artifact-detail-page {
    display: grid;
    gap: 24px;
  }

  .hero {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .eyebrow,
  .panel-kicker {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 34px;
    letter-spacing: -0.03em;
  }

  .lede,
  .cache-body p,
  .provenance-list small {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
  }

  .meta-grid,
  .grid {
    display: grid;
    gap: 18px;
  }

  .meta-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .meta-grid article,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .meta-grid article {
    display: grid;
    gap: 8px;
    min-width: 0;
    padding: 18px;
  }

  .meta-grid span,
  .provenance-list span,
  dt {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .meta-grid strong,
  dd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grid {
    align-items: start;
    grid-template-columns: minmax(0, 1fr) 390px;
  }

  .panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    padding: 24px 28px;
  }

  .panel-header.compact {
    padding: 22px 24px;
  }

  .scope-pill,
  .chip {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .scope-pill.project {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .scope-pill.workspace {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .provenance-list,
  .cache-body {
    display: grid;
    gap: 16px;
    padding: 22px 24px 24px;
  }

  .provenance-list article {
    display: grid;
    gap: 6px;
  }

  .provenance-list a {
    color: var(--color-primary);
    font-weight: 800;
    text-decoration: none;
  }

  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chip {
    background: var(--color-surface-soft);
    color: var(--color-ink-muted);
  }

  details {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 12px;
    padding: 18px 24px 24px;
  }

  summary {
    color: var(--color-ink-muted);
    cursor: pointer;
    font-weight: 800;
  }

  .cache-icon {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: grid;
    height: 52px;
    place-items: center;
    width: 52px;
  }

  dl {
    display: grid;
    gap: 10px;
    margin: 0;
  }

  dl div {
    display: grid;
    gap: 4px;
  }

  dd {
    margin: 0;
  }

  form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 12px;
    display: inline-flex;
    font-weight: 800;
    height: 44px;
    justify-content: center;
    padding: 0 16px;
    text-decoration: none;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: white;
    cursor: pointer;
  }

  .secondary-action {
    background: white;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .form-error {
    background: var(--color-danger-weak);
    border-bottom: 1px solid var(--color-danger-soft);
    color: var(--color-danger-strong);
    font-weight: 700;
    padding: 14px 24px;
  }

  pre {
    background: var(--color-ink);
    border-radius: 12px;
    color: var(--color-border);
    font-size: 12px;
    margin: 0;
    overflow: auto;
    padding: 14px;
    white-space: pre-wrap;
  }

  .panel > pre {
    border-radius: 0 0 16px 16px;
  }

  .panel-copy {
    color: var(--color-ink-subtle);
    line-height: 1.55;
    margin-top: 8px;
    max-width: 72ch;
  }

  .spark-ui-replay-body {
    padding: 22px 24px 24px;
  }

  .preview-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 12px;
    text-transform: capitalize;
    background: var(--color-surface-soft);
    color: var(--color-ink-muted);
  }

  .preview-pill.ready {
    background: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .preview-pill.missing,
  .preview-pill.fetching,
  .preview-pill.evicted {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .preview-pill.too_large,
  .preview-pill.unsupported_binary {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .preview-pill.error {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  .preview-meta {
    display: grid;
    gap: 12px;
    padding: 22px 24px 18px;
  }

  .preview-meta span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .preview-meta p {
    color: var(--color-ink-muted);
    line-height: 1.55;
    margin: 0;
  }

  .preview-meta dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    display: grid;
    gap: 12px;
    margin: 0;
  }

  .preview-error {
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    border-radius: 12px;
    color: var(--color-danger-strong);
    font-weight: 600;
    margin: 0;
    padding: 10px 14px;
  }

  .preview-body {
    border-radius: 0;
    margin: 0 24px;
  }

  .preview-truncation {
    color: var(--color-ink-subtle);
    line-height: 1.55;
    margin: 0;
    padding: 14px 24px 24px;
  }

  .preview-truncation a {
    color: var(--color-primary);
    font-weight: 700;
    text-decoration: none;
  }

  @media (max-width: 1100px) {
    .meta-grid,
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
