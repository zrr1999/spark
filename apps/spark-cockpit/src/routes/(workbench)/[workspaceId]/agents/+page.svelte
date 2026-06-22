<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    enumLabel,
    formatRelativeTime,
    statusLabel as getStatusLabel,
  } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.agents);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function sourceLabel(source: string) {
    return enumLabel(source, common.agentSource);
  }

  function parseConfig(value: string) {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const roleRef = typeof parsed.roleRef === "string" ? parsed.roleRef : null;
    const instructions = typeof parsed.instructions === "string" ? parsed.instructions : null;
    return { roleRef, instructions };
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="agents-page">
  <header class="hero">
    <div>
      <p class="eyebrow">{t.hero.eyebrow}</p>
      <h1>{t.hero.title}</h1>
      <p class="lede">
        {t.hero.lede}
      </p>
    </div>
  </header>

  <section class="metrics" aria-label={t.metrics.aria}>
    <article><span>{t.metrics.total}</span><strong>{data.counts.total}</strong></article>
    <article><span>{t.metrics.active}</span><strong>{data.counts.active}</strong></article>
    <article><span>{t.metrics.disabled}</span><strong>{data.counts.disabled}</strong></article>
    <article><span>{t.metrics.archived}</span><strong>{data.counts.archived}</strong></article>
  </section>

  {#if !data.workspace}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="agents" size={28} /></div>
      <h2>{t.emptyWorkspace.title}</h2>
      <p>{t.emptyWorkspace.body}</p>
      <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
    </section>
  {:else}
    <section class="grid">
      <section class="panel" aria-labelledby="agent-list-title">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">{data.workspace.name}</p>
            <h2 id="agent-list-title">{t.list.title}</h2>
          </div>
          <span class="panel-badge">{data.agentSpecs.length} {t.list.totalSuffix}</span>
        </div>

        {#if data.agentSpecs.length === 0}
          <div class="compact-empty">
            <div class="empty-icon small"><Icon name="agents" size={22} /></div>
            <div>
              <h3>{t.list.emptyTitle}</h3>
              <p>{t.list.emptyBody}</p>
            </div>
          </div>
        {:else}
          <div class="agent-list">
            {#each data.agentSpecs as agent}
              {@const config = parseConfig(agent.configJson)}
              <article class="agent-row">
                <div class="row-icon"><Icon name="agents" size={22} /></div>
                <div>
                  <div class="row-title">
                    <h3>{agent.name}</h3>
                    <span class="source-pill">{sourceLabel(agent.source)}</span>
                  </div>
                  <p>{agent.description ?? config.instructions ?? common.fallback.noDescription}</p>
                  <small>{config.roleRef ?? common.fallback.noRoleHint} · {t.list.updatedPrefix} {formatRelative(agent.updatedAt)}</small>
                </div>
                <span class="status-pill {agent.status}">{statusLabel(agent.status)}</span>
                <form method="POST" action="?/setAgentStatus">
                  <input type="hidden" name="agentSpecId" value={agent.id} />
                  {#if agent.status === "active"}
                    <button class="secondary-action small" name="status" value="disabled" type="submit">{t.list.disable}</button>
                  {:else if agent.status === "disabled"}
                    <button class="secondary-action small" name="status" value="active" type="submit">{t.list.enable}</button>
                  {:else}
                    <button class="secondary-action small" name="status" value="active" type="submit">{t.list.restore}</button>
                  {/if}
                  {#if agent.status !== "archived"}
                    <button class="secondary-action small" name="status" value="archived" type="submit">{t.list.archive}</button>
                  {/if}
                </form>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="panel create-panel" aria-labelledby="create-agent-title">
        <div class="panel-header compact">
          <div>
            <p class="panel-kicker">{t.create.kicker}</p>
            <h2 id="create-agent-title">{t.create.title}</h2>
          </div>
        </div>

        {#if form?.message}
          <div class="form-error" role="alert">{form.message}</div>
        {/if}

        <form method="POST" action="?/createAgentSpec">
          <label>
            <span>{t.create.name}</span>
            <input name="name" placeholder={t.create.namePlaceholder} required />
          </label>
          <label>
            <span>{t.create.source}</span>
            <select name="source" required>
              <option value="workspace">{common.agentSource.workspace}</option>
              <option value="builtin">{common.agentSource.builtin}</option>
              <option value="imported">{common.agentSource.imported}</option>
            </select>
          </label>
          <label>
            <span>{t.create.roleHint}</span>
            <input name="roleRef" placeholder={t.create.roleHintPlaceholder} />
          </label>
          <label>
            <span>{t.create.description}</span>
            <input name="description" placeholder={t.create.descriptionPlaceholder} />
          </label>
          <label>
            <span>{t.create.instructions}</span>
            <textarea name="instructions" rows="4" placeholder={t.create.instructionsPlaceholder}></textarea>
          </label>
          <button class="primary-action" type="submit">{t.create.submit}</button>
        </form>
      </aside>
    </section>
  {/if}
</section>

<style>
  .agents-page {
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
  .agent-row p,
  .agent-row small,
  .compact-empty p,
  .empty-state p {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
    max-width: 840px;
  }

  .metrics,
  .grid {
    display: grid;
    gap: 18px;
  }

  .metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .grid {
    align-items: start;
    grid-template-columns: minmax(0, 1fr) 380px;
  }

  .metrics article,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .metrics article {
    padding: 22px;
  }

  .metrics span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 13px;
    font-weight: 750;
    margin-bottom: 10px;
  }

  .metrics strong {
    color: var(--color-ink);
    font-size: 32px;
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

  .panel-badge,
  .status-pill,
  .source-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .panel-badge,
  .source-pill {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.active {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .agent-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .agent-row {
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 16px;
    grid-template-columns: 48px minmax(0, 1fr) auto auto;
    padding: 16px;
  }

  .row-icon,
  .empty-icon {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: grid;
    place-items: center;
  }

  .row-icon {
    height: 48px;
    width: 48px;
  }

  .empty-icon {
    height: 64px;
    width: 64px;
  }

  .empty-icon.small {
    height: 46px;
    width: 46px;
  }

  .row-title {
    align-items: center;
    display: flex;
    gap: 10px;
    margin-bottom: 4px;
  }

  .compact-empty,
  .empty-state {
    align-items: center;
    display: grid;
    gap: 14px;
    justify-items: center;
    padding: 42px;
    text-align: center;
  }

  .compact-empty {
    grid-template-columns: 46px minmax(0, 1fr);
    justify-items: start;
    text-align: left;
  }

  .create-panel form,
  .agent-row form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .create-panel form {
    display: grid;
    gap: 16px;
    padding: 22px 24px 24px;
  }

  label {
    display: grid;
    gap: 7px;
  }

  label span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  input,
  select,
  textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: 12px;
    color: var(--color-ink);
    font: inherit;
    padding: 11px 12px;
  }

  textarea {
    resize: vertical;
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
    cursor: pointer;
  }

  .secondary-action.small {
    height: 38px;
  }

  .form-error {
    background: var(--color-danger-weak);
    border-bottom: 1px solid var(--color-danger-soft);
    color: var(--color-danger-strong);
    font-weight: 700;
    padding: 14px 24px;
  }

  @media (max-width: 1100px) {
    .metrics,
    .grid,
    .agent-row {
      grid-template-columns: 1fr;
    }
  }
</style>
