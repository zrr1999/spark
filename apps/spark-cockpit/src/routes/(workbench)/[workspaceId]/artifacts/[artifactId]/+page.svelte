<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import SparkUiRenderer from "$lib/SparkUiRenderer.svelte";
  import { buildArtifactSparkUiReplay } from "$lib/artifact-ui-replay";
  import { enumLabel, formatByteSize, formatRelativeTime } from "$lib/i18n";
  import { Button, Panel } from "$lib/ui";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.artifactDetail);
  let common = $derived(data.messages.common);
  let previewCache = $derived(data.cacheBlobs.find((blob) => blob.isPreview));
  let preview = $derived(data.preview);
  let workspaceUrl = $derived(workspacePath({ slug: data.artifact.workspaceSlug }));
  let displayTitle = $derived(
    data.artifact.title.match(/^Role run .*? for (.+)$/i)?.[1] ?? data.artifact.title,
  );
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
  <title>{displayTitle} · {t.headTitleSuffix} · Spark</title>
</svelte:head>

<section class="artifact-detail-page">
  <a class="back-link" href={`${workspaceUrl}/artifacts`}>
    <span aria-hidden="true"><Icon name="chevron" size={15} /></span>{t.back}
  </a>

  <header class="hero">
    <div>
      <p class="eyebrow">{data.artifact.kind} · {data.artifact.format}</p>
      <h1>{displayTitle}</h1>
      <p class="lede">{data.artifact.workspaceName} · {formatRelative(data.artifact.createdAt)} · {formatSize(data.artifact.sizeBytes)}</p>
    </div>
    <span class="scope-pill {data.artifact.scope}">{scopeLabel(data.artifact.scope)}</span>
  </header>

  <Panel class="preview-panel" title={t.preview.title} ariaLabelledby="preview-title" padded={false}>
    {#snippet headerActions()}
      <span class="preview-pill {preview.status}">{previewStatusLabel(preview.status)}</span>
    {/snippet}

    {#if form?.message}
      <div class="form-error" role="alert">{form.message}</div>
    {/if}

    {#if sparkUiReplay}
      <div class="spark-ui-replay-body">
        <SparkUiRenderer
          document={sparkUiReplay.document}
          source={sparkUiReplay.source}
          showSource={false}
        />
      </div>
    {:else if preview.status === "ready" && preview.body}
      {#if preview.body.text !== null}
        <pre class="preview-body">{preview.body.text}</pre>
        <div class="preview-actions">
          {#if preview.body.truncated}<span>{t.preview.truncatedPrefix} {formatSize(preview.inlineLimitBytes)}.</span>{/if}
          <Button variant="secondary" href={`/api/v1/artifacts/${data.artifact.id}/content`}>
            {preview.body.truncated ? t.preview.openFull : t.preview.openRaw}
          </Button>
        </div>
      {:else}
        <div class="preview-empty">
          <p>{t.preview.nonTextPrefix}</p>
          <Button href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.contentEndpoint}</Button>
        </div>
      {/if}
    {:else}
      <div class="preview-empty">
        <div class="preview-icon"><Icon name="artifacts" size={24} /></div>
        <h3>{previewStatusLabel(preview.status)}</h3>
        <p>{previewStatusHint(preview.status)}</p>
        <form method="POST" action="?/preparePreview">
          <Button type="submit">{t.cache.prepare}</Button>
          <Button variant="secondary" href={`/api/v1/artifacts/${data.artifact.id}/content`}>{t.preview.probe}</Button>
        </form>
      </div>
    {/if}
  </Panel>

  <details class="technical-details">
    <summary><span><strong>{t.technicalTitle}</strong><small>{t.technicalHint}</small></span></summary>
    <div class="technical-body">
      <dl class="meta-grid" aria-label={t.meta.aria}>
        <div><dt>{t.meta.source}</dt><dd>{data.artifact.source}</dd></div>
        <div><dt>{t.meta.size}</dt><dd>{formatSize(data.artifact.sizeBytes)}</dd></div>
        <div><dt>{t.meta.runner}</dt><dd>{data.artifact.runtimeName ?? common.fallback.server}</dd></div>
        <div><dt>{t.meta.previewCache}</dt><dd>{previewStatusLabel(preview.status)}</dd></div>
      </dl>

      {#if preview.status === "error" && preview.error?.message}
        <section class="technical-section" aria-labelledby="preview-error-title">
          <h2 id="preview-error-title">{t.preview.errorDetails}</h2>
          <pre class="technical-error">{preview.error.message}</pre>
        </section>
      {/if}

      <section class="technical-section" aria-labelledby="provenance-title">
        <h2 id="provenance-title">{t.provenance.title}</h2>
        <div class="provenance-list">
          {#if data.artifact.sessionId}
            <article><span>{t.provenance.conversation}</span><a href={`/sessions/${encodeURIComponent(data.artifact.sessionId)}`}>{data.artifact.sessionId}</a></article>
          {/if}
          {#if data.artifact.runtimeInvocationId}
            <article><span>{t.provenance.invocation}</span><strong>{data.artifact.runtimeInvocationId}</strong><small>{data.artifact.agentName ?? common.fallback.runner} · {data.artifact.invocationStatus}</small></article>
          {/if}
          {#if data.artifact.humanRequestId}
            <article><span>{t.provenance.humanRequest}</span><strong>{data.artifact.humanRequestTitle ?? data.artifact.humanRequestId}</strong></article>
          {/if}
          {#if data.links.length > 0}
            <article><span>{t.provenance.links}</span><div class="chip-list">{#each data.links as link}<span class="chip">{link.relation}: {link.targetKind}/{link.targetId}</span>{/each}</div></article>
          {/if}
        </div>
      </section>

      <section class="technical-section" aria-labelledby="cache-title">
        <h2 id="cache-title">{t.cache.title}</h2>
        {#if previewCache}
          <dl class="meta-grid">
            <div><dt>{t.cache.state}</dt><dd>{previewCache.state}</dd></div>
            <div><dt>{t.cache.path}</dt><dd>{previewCache.cachePath}</dd></div>
            <div><dt>{t.cache.mime}</dt><dd>{previewCache.mime ?? common.unknown}</dd></div>
            <div><dt>{t.cache.lastAccessed}</dt><dd>{formatRelative(previewCache.lastAccessedAt)}</dd></div>
          </dl>
        {:else}
          <p class="muted">{t.cache.notPrepared}</p>
        {/if}
        <Button variant="secondary" href={`/api/v1/artifacts/${data.artifact.id}/cache`}>{t.cache.openApi}</Button>
      </section>

      <details class="raw-details">
        <summary>{t.provenance.json}</summary>
        <pre>{formatJson(data.artifact.provenance)}</pre>
      </details>
      <details class="raw-details">
        <summary>{t.content.title}</summary>
        <pre>{formatJson(data.artifact.contentRef)}</pre>
      </details>
    </div>
  </details>
</section>

<style>
  .artifact-detail-page { display: grid; gap: var(--spacing-xl); }

  .back-link {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    gap: var(--spacing-xs);
    text-decoration: none;
    width: fit-content;
  }

  .back-link > span { display: flex; transform: rotate(180deg); }
  .back-link:hover { color: var(--color-primary); }

  .hero { align-items: center; display: flex; gap: var(--spacing-lg); justify-content: space-between; }
  .hero > div { min-width: 0; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: var(--text-page-title); letter-spacing: var(--tracking-page-title); line-height: var(--leading-page-title); overflow-wrap: anywhere; }
  h2 { font-size: var(--text-section-title); }
  h3 { font-size: var(--text-card-title); }
  .eyebrow { color: var(--color-primary); font-size: var(--text-caption); font-weight: var(--weight-caption-medium); margin: 0 0 var(--spacing-xs); }
  .lede, .muted { color: var(--color-ink-subtle); line-height: var(--leading-body); }
  .lede { margin-top: var(--spacing-xs); }

  .scope-pill, .preview-pill, .chip {
    border-radius: var(--rounded-full);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 5px 9px;
  }
  .scope-pill { background: var(--color-primary-weak); color: var(--color-primary); }
  .scope-pill.workspace { background: var(--color-purple-soft); color: var(--color-purple); }
  .preview-pill { background: var(--color-surface-soft); color: var(--color-ink-muted); white-space: nowrap; }
  .preview-pill.ready { background: var(--color-success-soft); color: var(--color-success-strong); }
  .preview-pill.missing, .preview-pill.fetching, .preview-pill.evicted { background: var(--color-warning-soft); color: var(--color-warning-strong); }
  .preview-pill.error { background: var(--color-danger-soft); color: var(--color-danger-strong); }

  .technical-details {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }

  .spark-ui-replay-body { padding: var(--spacing-xl); }
  :global(.preview-panel .ui-panel-body) { gap: 0; }
  .preview-body { background: var(--color-ink); color: var(--color-border); font-size: var(--text-caption); margin: 0; max-height: 60vh; overflow: auto; padding: var(--spacing-xl); white-space: pre-wrap; }

  .preview-empty { align-items: center; display: grid; gap: var(--spacing-sm); justify-items: center; padding: var(--spacing-xxl); text-align: center; }
  .preview-empty p { color: var(--color-ink-subtle); line-height: var(--leading-body); max-width: 48ch; }
  .preview-empty form { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); justify-content: center; }
  .preview-icon { align-items: center; background: var(--color-primary-weak); border-radius: var(--rounded-full); color: var(--color-primary); display: flex; height: 52px; justify-content: center; width: 52px; }
  .preview-actions { align-items: center; color: var(--color-ink-subtle); display: flex; flex-wrap: wrap; gap: var(--spacing-md); justify-content: space-between; padding: var(--spacing-md) var(--spacing-xl); }

  .form-error { background: var(--color-danger-weak); color: var(--color-danger-strong); padding: var(--spacing-sm) var(--spacing-xl); }

  .technical-details > summary { cursor: pointer; list-style: none; padding: var(--spacing-lg) var(--spacing-xl); }
  .technical-details > summary::-webkit-details-marker { display: none; }
  .technical-details > summary span { display: grid; gap: var(--spacing-xxs); }
  .technical-details > summary small { color: var(--color-ink-subtle); font-weight: 400; }
  .technical-details[open] > summary { border-bottom: 1px solid var(--color-border); }
  .technical-body { display: grid; gap: var(--spacing-xl); padding: var(--spacing-xl); }
  .technical-section { display: grid; gap: var(--spacing-sm); }
  .technical-error { background: var(--color-ink); border-radius: var(--rounded-md); color: var(--color-border); margin: 0; overflow: auto; padding: var(--spacing-md); white-space: pre-wrap; }

  .meta-grid { display: grid; gap: var(--spacing-sm); grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
  .meta-grid div { background: var(--color-surface-soft); border-radius: var(--rounded-md); display: grid; gap: var(--spacing-xxs); min-width: 0; padding: var(--spacing-sm); }
  dt, .provenance-list > article > span { color: var(--color-ink-subtle); font-size: var(--text-caption); font-weight: var(--weight-caption-medium); }
  dd { margin: 0; overflow-wrap: anywhere; }

  .provenance-list { display: grid; gap: var(--spacing-sm); }
  .provenance-list article { display: grid; gap: var(--spacing-xxs); }
  .provenance-list a { color: var(--color-primary); font-weight: var(--weight-button); text-decoration: none; }
  .provenance-list small { color: var(--color-ink-subtle); }
  .chip-list { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
  .chip { background: var(--color-surface-soft); color: var(--color-ink-muted); }

  .raw-details { border-top: 1px solid var(--color-border-soft); padding-top: var(--spacing-sm); }
  .raw-details summary { align-items: center; color: var(--color-ink-muted); cursor: pointer; display: flex; font-weight: var(--weight-button); min-height: 40px; }
  .raw-details pre { background: var(--color-ink); border-radius: var(--rounded-md); color: var(--color-border); font-size: var(--text-caption); margin: var(--spacing-sm) 0 0; overflow: auto; padding: var(--spacing-md); white-space: pre-wrap; }

  @media (max-width: 760px) {
    .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 560px) {
    .hero { align-items: flex-start; flex-direction: column; }
    .meta-grid { grid-template-columns: 1fr; }
    .technical-body, .spark-ui-replay-body { padding: var(--spacing-lg); }
  }
</style>
